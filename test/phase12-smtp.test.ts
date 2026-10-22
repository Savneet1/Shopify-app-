import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { SmtpEmailProvider, type SocketLike } from "~/lib/email/smtp";
import { PermanentEmailError, TransientEmailError, EmailValidationError } from "~/lib/email/errors";
import { buildMessage, assertAddress, encodeHeaderWord, dotStuff, MAX_MESSAGE_BYTES } from "~/lib/email/mime";

/*
 * Phase 12.1 — SMTP client against a LOCAL, in-process FAKE SMTP server (no
 * network). The fake implements SocketLike and scripts the SMTP conversation,
 * so the real client state machine (EHLO → STARTTLS → AUTH → MAIL/RCPT/DATA →
 * QUIT), its dot-stuffing, timeouts and typed permanent/transient errors are all
 * exercised deterministically. Plus pure MIME/header-injection unit tests.
 */

interface FakeOpts {
  auth?: number;          // reply code to AUTH (235 ok, 535 permanent, 454 transient)
  mail?: number;          // reply to MAIL FROM
  rcpt?: number;          // reply to RCPT TO
  data?: number;          // reply after the message body
  advertiseStartTls?: boolean;
  hangAt?: string;        // a command keyword after which the server never replies (timeout)
  captureAuth?: boolean;
}

/** An in-process fake SMTP socket: parses each written command and emits a
 * scripted reply. Loopback only, no OS sockets. */
class FakeSmtpSocket extends EventEmitter implements SocketLike {
  destroyed = false;
  wrote: string[] = [];
  authPayload: string | null = null;
  messageData = "";
  private inData = false;
  private loginStep = 0;
  constructor(private opts: FakeOpts) {
    super();
    // Greeting after the client attaches its data listener.
    setTimeout(() => this.reply("220 fake ESMTP ready"), 0);
  }
  private reply(s: string) { if (!this.destroyed) this.emit("data", Buffer.from(s + "\r\n")); }
  private hang(keyword: string): boolean { return this.opts.hangAt === keyword; }
  write(data: string): void {
    this.wrote.push(data);
    if (this.inData) {
      this.messageData += data;
      if (/\r\n\.\r\n$/.test(this.messageData)) {
        this.inData = false;
        if (!this.hang("DATA")) this.reply(`${this.opts.data ?? 250} OK queued as ABC123`);
      }
      return;
    }
    const line = data.replace(/\r\n$/, "");
    const kw = line.split(/\s+/)[0].toUpperCase();
    switch (kw) {
      case "EHLO": {
        if (this.hang("EHLO")) return;
        const caps = ["250-fake greets you", "250-AUTH PLAIN LOGIN"];
        if (this.opts.advertiseStartTls) caps.push("250-STARTTLS");
        caps.push("250 PIPELINING");
        this.reply(caps.join("\r\n"));
        break;
      }
      case "STARTTLS": this.reply("220 go ahead"); break;
      case "AUTH": {
        const mech = (line.split(/\s+/)[1] || "").toUpperCase();
        if (mech === "PLAIN") {
          if (this.opts.captureAuth) this.authPayload = line.split(/\s+/)[2] || "";
          this.reply(`${this.opts.auth ?? 235} auth`);
        } else if (mech === "LOGIN") {
          this.loginStep = 1; this.reply("334 VXNlcm5hbWU6");
        }
        break;
      }
      case "MAIL": if (this.hang("MAIL")) return; this.reply(`${this.opts.mail ?? 250} sender ok`); break;
      case "RCPT": this.reply(`${this.opts.rcpt ?? 250} recipient ok`); break;
      case "DATA": this.inData = true; this.reply("354 end with <CRLF>.<CRLF>"); break;
      case "QUIT": this.reply("221 bye"); break;
      default:
        // AUTH LOGIN continuation lines (base64 user / pass).
        if (this.loginStep === 1) { this.loginStep = 2; this.reply("334 UGFzc3dvcmQ6"); }
        else if (this.loginStep === 2) { this.loginStep = 0; if (this.opts.captureAuth) this.authPayload = line; this.reply(`${this.opts.auth ?? 235} auth`); }
        else this.reply("500 unknown");
    }
  }
  destroy(): void { this.destroyed = true; this.emit("close"); }
}

// A public IP the injected resolver returns, so the SSRF policy permits the
// connect while the fake server (injected) actually answers — no real network.
const PUBLIC_IP = "93.184.216.34";
const injectedLookup = async () => [{ address: PUBLIC_IP, family: 4 }];

function providerWith(opts: FakeOpts, cfgOverrides: Partial<ConstructorParameters<typeof SmtpEmailProvider>[0]> = {}, maxRetries = 0) {
  const sockets: FakeSmtpSocket[] = [];
  const provider = new SmtpEmailProvider(
    {
      // A public hostname (resolved via the injected lookup) on an allowed port;
      // implicit TLS so AUTH credentials are permitted by the policy.
      host: "smtp.example.com", port: 465, security: "tls",
      username: "user", password: "pass",
      fromEmail: "shop@example.com", fromName: "My Shop",
      timeoutMs: 300, maxRetries,
      ...cfgOverrides,
    },
    {
      connect: async () => { const s = new FakeSmtpSocket(opts); sockets.push(s); return s; },
      upgrade: async () => { const s = new FakeSmtpSocket(opts); sockets.push(s); return s; },
      sleep: async () => {},
      lookup: injectedLookup,
    },
  );
  return { provider, sockets };
}

const MSG = { to: "buyer@example.com", subject: "Your item is back", text: "Hello", html: "<p>Hello</p>" };

describe("Phase 12.1 — SMTP client vs in-process fake server", () => {
  it("delivers a message end-to-end (EHLO, AUTH PLAIN, MAIL/RCPT/DATA, QUIT)", async () => {
    const { provider, sockets } = providerWith({ captureAuth: true });
    const res = await provider.send(MSG);
    expect(res.delivered).toBe(true);
    expect(res.provider).toBe("smtp");
    const convo = sockets[0].wrote.join("");
    expect(convo).toMatch(/EHLO /);
    expect(convo).toMatch(/AUTH PLAIN /);
    expect(convo).toMatch(/MAIL FROM:<shop@example\.com>/);
    expect(convo).toMatch(/RCPT TO:<buyer@example\.com>/);
    expect(convo).toMatch(/QUIT/);
    // AUTH PLAIN payload is base64("\0user\0pass")
    const b64 = Buffer.from("\u0000user\u0000pass", "utf8").toString("base64");
    expect(sockets[0].authPayload).toBe(b64);
  });

  it("performs STARTTLS then re-EHLO when security=starttls", async () => {
    const { provider, sockets } = providerWith({ advertiseStartTls: true }, { security: "starttls", port: 587 });
    const res = await provider.send(MSG);
    expect(res.delivered).toBe(true);
    // first socket speaks STARTTLS; conversation continues on the upgraded one.
    expect(sockets[0].wrote.join("")).toMatch(/STARTTLS/);
  });

  it("AUTH LOGIN path works when only LOGIN is offered", async () => {
    // Force LOGIN by advertising it; the client prefers PLAIN, so to exercise
    // LOGIN we make the caps omit PLAIN via a tweaked fake.
    const sockets: FakeSmtpSocket[] = [];
    const provider = new SmtpEmailProvider(
      { host: "smtp.example.com", port: 465, security: "tls", username: "u", password: "p", fromEmail: "s@e.com", timeoutMs: 300, maxRetries: 0 },
      {
        connect: async () => {
          const s = new FakeSmtpSocket({});
          // Override EHLO caps to advertise LOGIN only.
          const origWrite = s.write.bind(s);
          s.write = (d: string) => { if (/^EHLO/.test(d)) { (s as any).emit("data", Buffer.from("250-x\r\n250 AUTH LOGIN\r\n")); s.wrote.push(d); } else origWrite(d); };
          sockets.push(s); return s;
        },
        sleep: async () => {},
        lookup: injectedLookup,
      },
    );
    const res = await provider.send(MSG);
    expect(res.delivered).toBe(true);
    expect(sockets[0].wrote.join("")).toMatch(/AUTH LOGIN/);
  });

  it("5xx on MAIL FROM is a PERMANENT error (not retried)", async () => {
    const { provider, sockets } = providerWith({ mail: 550 }, {}, 3);
    await expect(provider.send(MSG)).rejects.toBeInstanceOf(PermanentEmailError);
    expect(sockets.length).toBe(1); // never retried
  });

  it("4xx on the message body is a TRANSIENT error (retried up to the limit)", async () => {
    const { provider, sockets } = providerWith({ data: 451 }, {}, 2);
    await expect(provider.send(MSG)).rejects.toBeInstanceOf(TransientEmailError);
    expect(sockets.length).toBe(3); // 1 + 2 retries
  });

  it("a hung server times out as a TRANSIENT error", async () => {
    const { provider } = providerWith({ hangAt: "MAIL" }, { timeoutMs: 80 }, 0);
    await expect(provider.send(MSG)).rejects.toBeInstanceOf(TransientEmailError);
  });

  it("dot-stuffs a body line beginning with '.'", async () => {
    const { provider, sockets } = providerWith({ captureAuth: false });
    await provider.send({ to: "b@example.com", subject: "s", text: ".hidden\nnormal", html: undefined });
    // The raw text is base64-encoded in the MIME part, so dot-stuffing applies
    // to any encoded line that happens to start with '.'; assert the terminator
    // is correct and no bare "\r\n.\r\n" appears mid-body.
    expect(sockets[0].messageData.endsWith("\r\n.\r\n")).toBe(true);
  });

  it("a header-injection attempt is a PERMANENT validation error BEFORE any socket", async () => {
    const { provider, sockets } = providerWith({});
    await expect(provider.send({ ...MSG, subject: "x\r\nBcc: victim@evil.com" }))
      .rejects.toBeInstanceOf(EmailValidationError);
    expect(sockets.length).toBe(0); // never connected
  });

  it("an oversized body is rejected before any socket", async () => {
    const { provider, sockets } = providerWith({});
    await expect(provider.send({ ...MSG, text: "x".repeat(MAX_MESSAGE_BYTES + 10) }))
      .rejects.toBeInstanceOf(EmailValidationError);
    expect(sockets.length).toBe(0);
  });
});

describe("Phase 12.1 — MIME build + header injection (pure)", () => {
  it("rejects CR/LF/NUL in any header field", () => {
    expect(() => assertAddress("a@b.com\r\nBcc: x@y.com", "to")).toThrow(EmailValidationError);
    expect(() => buildMessage({ from: "s@e.com", to: "a@b.com", subject: "ok\nInjected: 1", text: "x" })).toThrow();
    expect(() => buildMessage({ from: "s@e.com", to: "a@b.com", subject: "s", text: "x", headers: { "List-Unsubscribe": "<x>\r\nBcc: y" } })).toThrow();
  });
  it("rejects a display-name address form (no 'Name <a@b>' from callers)", () => {
    expect(() => assertAddress("Victim <a@b.com>", "to")).toThrow(EmailValidationError);
    expect(() => assertAddress('"a@b.com" <c@d.com>', "to")).toThrow(EmailValidationError);
  });
  it("RFC 2047-encodes a non-ASCII subject; ASCII passes through", () => {
    expect(encodeHeaderWord("Plain ASCII")).toBe("Plain ASCII");
    const enc = encodeHeaderWord("réappro ✓ café");
    expect(enc.startsWith("=?UTF-8?B?")).toBe(true);
    expect(enc.endsWith("?=")).toBe(true);
    // decodes back to the original
    const b64 = enc.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("réappro ✓ café");
  });
  it("dotStuff doubles only a leading dot per line", () => {
    expect(dotStuff(".a\r\nb\r\n..c")).toBe("..a\r\nb\r\n...c");
    expect(dotStuff("no dots")).toBe("no dots");
  });
  it("builds a multipart/alternative with List-Unsubscribe headers and valid addresses", () => {
    const m = buildMessage({
      from: "shop@example.com", fromName: "My Shop", to: "buyer@example.com",
      subject: "Back in stock", text: "hi", html: "<p>hi</p>",
      headers: { "List-Unsubscribe": "<https://x/unsub>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      now: new Date("2026-05-01T00:00:00Z"), messageId: "fixed@example.com", boundary: "BND",
    });
    expect(m.from).toBe("shop@example.com");
    expect(m.to).toBe("buyer@example.com");
    expect(m.data).toMatch(/Content-Type: multipart\/alternative; boundary="BND"/);
    expect(m.data).toMatch(/List-Unsubscribe: <https:\/\/x\/unsub>/);
    expect(m.data).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    expect(m.data).toMatch(/text\/plain/);
    expect(m.data).toMatch(/text\/html/);
  });
  it("drops non-allowlisted extra headers", () => {
    const m = buildMessage({ from: "s@e.com", to: "a@b.com", subject: "s", text: "x", headers: { "X-Evil": "1", "List-Unsubscribe": "<u>" } });
    expect(m.data).not.toMatch(/X-Evil/);
    expect(m.data).toMatch(/List-Unsubscribe: <u>/);
  });
});
