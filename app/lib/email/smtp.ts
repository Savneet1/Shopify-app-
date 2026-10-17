import net from "node:net";
import tls from "node:tls";
import type { EmailMessage, EmailProvider, EmailSendResult } from "./provider";
import { PermanentEmailError, TransientEmailError } from "./errors";
import { buildMessage } from "./mime";

/**
 * Phase 12.1 — SMTP email provider using ONLY Node built-ins (node:net /
 * node:tls). No nodemailer / SendGrid / Resend SDK, no new dependency. Speaks
 * enough SMTP to deliver one message: EHLO, (STARTTLS | implicit TLS), AUTH
 * PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA (dot-stuffed), QUIT. Hard timeouts, a
 * message-size cap, strict header-injection protection (in ./mime), bounded
 * retries with backoff, and typed PERMANENT (5xx / bad input) vs TRANSIENT
 * (4xx / network / timeout) errors.
 *
 * TLS certificate behaviour against real providers (port 25/465/587, SPF/DKIM/
 * DMARC, verified certs) is Requires Verification; the socket factory is
 * injectable so the protocol is fully testable against a local in-process fake
 * SMTP server with no network.
 */

export type SmtpSecurity = "none" | "starttls" | "tls";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string | null;
  password?: string | null;
  fromEmail: string;
  fromName?: string | null;
  replyTo?: string | null;
  /** Per-step + overall socket timeout (ms). */
  timeoutMs?: number;
  /** Retry count for TRANSIENT failures (total attempts = maxRetries + 1). */
  maxRetries?: number;
  /** EHLO name. */
  ehloName?: string;
}

export interface SocketLike extends NodeJS.EventEmitter {
  write(data: string): void;
  destroy(err?: Error): void;
  setTimeout?(ms: number): void;
}

export type ConnectFn = (opts: { host: string; port: number; tls: boolean }) => Promise<SocketLike>;
export type SleepFn = (ms: number) => Promise<void>;
export type UpgradeFn = (socket: SocketLike, host: string) => Promise<SocketLike>;

const DEFAULT_TIMEOUT = 15000;

const realConnect: ConnectFn = ({ host, port, tls: useTls }) =>
  new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(new TransientEmailError(`connect failed: ${e.message}`));
    if (useTls) {
      const s = tls.connect({ host, port, servername: host }, () => resolve(s));
      s.once("error", onErr);
    } else {
      const s = net.connect({ host, port }, () => resolve(s));
      s.once("error", onErr);
    }
  });

const realUpgrade: UpgradeFn = (socket, host) =>
  new Promise((resolve, reject) => {
    const s = tls.connect({ socket: socket as unknown as net.Socket, servername: host }, () => resolve(s));
    s.once("error", (e: Error) => reject(new TransientEmailError(`STARTTLS upgrade failed: ${e.message}`)));
  });

const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

interface SmtpResponse {
  code: number;
  text: string;
}

/** Lockstep SMTP connection: one outstanding request/response at a time. */
class SmtpConnection {
  private buf = "";
  private waiter: { resolve: (r: SmtpResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private closed = false;

  constructor(private socket: SocketLike, private timeoutMs: number) {
    socket.on("data", (d: Buffer | string) => { this.buf += d.toString(); this.tryParse(); });
    socket.on("error", (e: Error) => this.fail(new TransientEmailError(`socket error: ${e.message}`)));
    socket.on("close", () => { this.closed = true; this.fail(new TransientEmailError("connection closed")); });
  }

  rebind(socket: SocketLike): void {
    this.socket = socket;
    this.buf = "";
    this.closed = false;
    socket.on("data", (d: Buffer | string) => { this.buf += d.toString(); this.tryParse(); });
    socket.on("error", (e: Error) => this.fail(new TransientEmailError(`socket error: ${e.message}`)));
    socket.on("close", () => { this.closed = true; this.fail(new TransientEmailError("connection closed")); });
  }

  private fail(err: Error): void {
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.reject(err); this.waiter = null; }
  }

  private tryParse(): void {
    if (!this.waiter) return;
    const lines = this.buf.split("\r\n");
    let endIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) { endIdx = i; break; }
      if (lines[i].length > 0 && !/^\d{3}-/.test(lines[i])) {
        // Not a well-formed SMTP line.
        this.fail(new TransientEmailError("malformed SMTP response"));
        return;
      }
    }
    if (endIdx < 0) return; // response incomplete
    const respLines = lines.slice(0, endIdx + 1);
    this.buf = lines.slice(endIdx + 1).join("\r\n");
    const code = Number(respLines[endIdx].slice(0, 3));
    const text = respLines.map((l) => l.slice(4)).join(" ").trim();
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve({ code, text });
  }

  /** Await the next complete response. */
  read(): Promise<SmtpResponse> {
    if (this.closed) return Promise.reject(new TransientEmailError("connection closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.socket.destroy();
        reject(new TransientEmailError("SMTP timeout"));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.tryParse(); // data may already be buffered
    });
  }

  write(line: string): void {
    this.socket.write(line);
  }

  close(): void {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

/** Classify a reply code: 5xx permanent, 4xx transient, else transient. */
function assertCode(resp: SmtpResponse, expected: number[], what: string): void {
  if (expected.includes(resp.code)) return;
  const msg = `${what}: unexpected ${resp.code}`;
  if (resp.code >= 500 && resp.code < 600) throw new PermanentEmailError(msg, resp.code);
  throw new TransientEmailError(msg, resp.code);
}

export class SmtpEmailProvider implements EmailProvider {
  constructor(
    private cfg: SmtpConfig,
    private deps: { connect?: ConnectFn; upgrade?: UpgradeFn; sleep?: SleepFn } = {},
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const maxRetries = this.cfg.maxRetries ?? 2;
    const sleep = this.deps.sleep ?? realSleep;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.attempt(message);
      } catch (err) {
        lastErr = err;
        if (err instanceof PermanentEmailError) throw err; // never retry permanent
        if (attempt < maxRetries) await sleep(Math.min(2000, 100 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new TransientEmailError("send failed");
  }

  private async attempt(message: EmailMessage): Promise<EmailSendResult> {
    const cfg = this.cfg;
    const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
    const connect = this.deps.connect ?? realConnect;
    const upgrade = this.deps.upgrade ?? realUpgrade;
    const ehlo = cfg.ehloName || "localhost";

    // Build + validate the message BEFORE any network I/O (header injection,
    // size cap, address validation all happen here and throw Permanent).
    const built = buildMessage({
      from: message.from || cfg.fromEmail,
      fromName: message.fromName ?? cfg.fromName ?? undefined,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo ?? cfg.replyTo ?? undefined,
      headers: message.headers,
    });

    const sock = await connect({ host: cfg.host, port: cfg.port, tls: cfg.security === "tls" });
    const conn = new SmtpConnection(sock, timeout);
    try {
      assertCode(await conn.read(), [220], "greeting");
      conn.write(`EHLO ${ehlo}\r\n`);
      let caps = await conn.read();
      assertCode(caps, [250], "EHLO");

      if (cfg.security === "starttls") {
        conn.write("STARTTLS\r\n");
        assertCode(await conn.read(), [220], "STARTTLS");
        const upgraded = await upgrade(sock, cfg.host);
        conn.rebind(upgraded);
        conn.write(`EHLO ${ehlo}\r\n`);
        caps = await conn.read();
        assertCode(caps, [250], "EHLO(tls)");
      }

      if (cfg.username && cfg.password) {
        await this.authenticate(conn, caps.text, cfg.username, cfg.password);
      }

      conn.write(`MAIL FROM:<${built.from}>\r\n`);
      assertCode(await conn.read(), [250], "MAIL FROM");
      conn.write(`RCPT TO:<${built.to}>\r\n`);
      assertCode(await conn.read(), [250, 251], "RCPT TO");
      conn.write("DATA\r\n");
      assertCode(await conn.read(), [354], "DATA");
      conn.write(built.data + "\r\n.\r\n");
      const dataResp = await conn.read();
      assertCode(dataResp, [250], "message body");

      try { conn.write("QUIT\r\n"); await conn.read(); } catch { /* QUIT best-effort */ }
      return { delivered: true, provider: "smtp", id: dataResp.text.match(/\b([0-9A-Za-z._-]{6,})\b/)?.[1] };
    } finally {
      conn.close();
    }
  }

  private async authenticate(conn: SmtpConnection, capsText: string, user: string, pass: string): Promise<void> {
    const mechs = capsText.toUpperCase();
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    if (mechs.includes("PLAIN") || !mechs.includes("LOGIN")) {
      conn.write(`AUTH PLAIN ${b64("\u0000" + user + "\u0000" + pass)}\r\n`);
      assertCode(await conn.read(), [235], "AUTH PLAIN");
      return;
    }
    // AUTH LOGIN
    conn.write("AUTH LOGIN\r\n");
    assertCode(await conn.read(), [334], "AUTH LOGIN");
    conn.write(`${b64(user)}\r\n`);
    assertCode(await conn.read(), [334], "AUTH LOGIN user");
    conn.write(`${b64(pass)}\r\n`);
    assertCode(await conn.read(), [235], "AUTH LOGIN pass");
  }
}
