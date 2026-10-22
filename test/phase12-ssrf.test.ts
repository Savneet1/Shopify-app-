import { describe, it, expect } from "vitest";
import {
  validateDestination, isPublicIp, isPublicIPv4, isPublicIPv6, assertPublicDestination,
  DestinationPolicyError, ALLOWED_PORTS, type ResolvedAddr,
} from "~/lib/email/destination";
import { SmtpEmailProvider, type SocketLike, type ConnectFn } from "~/lib/email/smtp";
import { PermanentEmailError } from "~/lib/email/errors";
import { EventEmitter } from "node:events";

/*
 * Phase 12.1 Q1 — SMTP destination policy (anti-SSRF). Pure policy units plus a
 * provider-level assertion that a REJECTED destination never opens a socket
 * (the injected connect is not called), and a DNS-rebinding resolver connects
 * only to the pinned first (public) address. No real network.
 */

const PUB = "93.184.216.34";
const lookupPublic = async (): Promise<ResolvedAddr[]> => [{ address: PUB, family: 4 }];
const lookupPrivate = async (): Promise<ResolvedAddr[]> => [{ address: "10.1.2.3", family: 4 }];
const lookupMixed = async (): Promise<ResolvedAddr[]> => [{ address: PUB, family: 4 }, { address: "192.168.1.5", family: 4 }];

describe("Phase 12.1 Q1 — validateDestination (host shape + port + TLS/creds)", () => {
  const base = { security: "none" as const, hasCredentials: false };
  it("accepts a conservative hostname or canonical IP literal on an allowed port", () => {
    expect(validateDestination({ ...base, host: "smtp.example.com", port: 587 }).ok).toBe(true);
    expect(validateDestination({ ...base, host: "93.184.216.34", port: 25 }).ok).toBe(true);
    expect(validateDestination({ host: "mail.shop.co", port: 465, security: "tls", hasCredentials: true }).ok).toBe(true);
  });
  it("rejects numeric obfuscations, userinfo, port-in-host, control chars, bad TLD", () => {
    for (const host of ["localhost", "2130706433", "0x7f000001", "0177.0.0.1", "user@host.com", "host.com:25", "ho st.com", "http://x.com", "x".repeat(300), "a.b", "smtp.x"]) {
      expect(validateDestination({ ...base, host, port: 587 }).ok, host).toBe(false);
    }
  });
  it("allows only ports 25/465/587/2525", () => {
    expect([...ALLOWED_PORTS]).toEqual([25, 465, 587, 2525]);
    for (const port of [22, 80, 110, 143, 5432, 6379, 8080, 0, 65536]) {
      expect(validateDestination({ ...base, host: "smtp.example.com", port }).ok, String(port)).toBe(false);
    }
  });
  it("enforces 465⇒implicit TLS and never AUTH over plaintext", () => {
    expect(validateDestination({ host: "smtp.example.com", port: 465, security: "none", hasCredentials: false }).ok).toBe(false); // 465 needs tls
    expect(validateDestination({ host: "smtp.example.com", port: 587, security: "none", hasCredentials: true }).ok).toBe(false); // creds need tls
    expect(validateDestination({ host: "smtp.example.com", port: 587, security: "starttls", hasCredentials: true }).ok).toBe(true);
  });
});

describe("Phase 12.1 Q1 — IP classification", () => {
  it("rejects every private / special IPv4 range", () => {
    for (const ip of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1"]) {
      expect(isPublicIPv4(ip), ip).toBe(false);
    }
    expect(isPublicIPv4("93.184.216.34")).toBe(true);
    expect(isPublicIPv4("8.8.8.8")).toBe(true);
  });
  it("rejects loopback/ULA/link-local/doc/mapped/embedded IPv6", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0:0:0:0:0:0:1"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(isPublicIPv6("2606:4700:4700::1111")).toBe(true); // public (Cloudflare)
    expect(isPublicIp("::ffff:93.184.216.34")).toBe(true);   // mapped public
  });
});

// A provider wired with a spy connect so we can assert it is NOT called for a
// rejected destination (no network probe), and a valid message so buildMessage
// never short-circuits first.
function spyProvider(host: string, opts: { port?: number; security?: "none" | "starttls" | "tls"; creds?: boolean; lookup?: () => Promise<ResolvedAddr[]> }) {
  let connectCalls = 0;
  const connectedHosts: string[] = [];
  const connect: ConnectFn = async ({ host: h }) => {
    connectCalls++; connectedHosts.push(h);
    // Minimal fake that completes a send, for the ALLOWED cases.
    const s = new (class extends EventEmitter implements SocketLike {
      write() {}
      destroy() {}
    })();
    // Drive a trivially-successful conversation.
    setTimeout(() => s.emit("data", Buffer.from("220 ok\r\n")), 0);
    const realWrite = (line: string) => {
      if (/^EHLO/.test(line)) s.emit("data", Buffer.from("250 ok\r\n"));
      else if (/^MAIL/.test(line)) s.emit("data", Buffer.from("250 ok\r\n"));
      else if (/^RCPT/.test(line)) s.emit("data", Buffer.from("250 ok\r\n"));
      else if (/^DATA/.test(line)) s.emit("data", Buffer.from("354 go\r\n"));
      else if (/^\r\n\.\r\n$/.test(line) || /\r\n\.\r\n$/.test(line)) s.emit("data", Buffer.from("250 queued\r\n"));
      else if (/^QUIT/.test(line)) s.emit("data", Buffer.from("221 bye\r\n"));
      else if (/^AUTH/.test(line)) s.emit("data", Buffer.from("235 ok\r\n"));
    };
    (s as unknown as { write: (l: string) => void }).write = realWrite;
    return s;
  };
  const provider = new SmtpEmailProvider(
    { host, port: opts.port ?? 587, security: opts.security ?? "none", username: opts.creds ? "u" : undefined, password: opts.creds ? "p" : undefined, fromEmail: "s@e.com", timeoutMs: 300, maxRetries: 0 },
    { connect, upgrade: async () => { throw new Error("no upgrade"); }, sleep: async () => {}, lookup: opts.lookup ?? lookupPublic },
  );
  return { provider, connectCalls: () => connectCalls, connectedHosts };
}
const MSG = { to: "buyer@example.com", subject: "hi", text: "x" };

describe("Phase 12.1 Q1 — the provider never probes a rejected destination", () => {
  // host-shape rejects + bad ports + creds-over-none + private literals +
  // private-resolving hostnames: ALL must reject WITHOUT calling connect.
  const rejected: Array<[string, Parameters<typeof spyProvider>[1]]> = [
    ["127.0.0.1", {}],
    ["::1", {}],
    ["::ffff:127.0.0.1", {}],
    ["2130706433", {}],
    ["0x7f000001", {}],
    ["169.254.169.254", {}],
    ["10.0.0.5", {}],
    ["172.16.9.9", {}],
    ["192.168.0.1", {}],
    ["100.64.0.1", {}],
    ["localhost", {}],
    ["smtp.example.com", { port: 22 }],
    ["smtp.example.com", { port: 80 }],
    ["smtp.example.com", { port: 5432 }],
    ["smtp.example.com", { port: 6379 }],
    ["smtp.example.com", { port: 8080 }],
    ["smtp.example.com", { security: "none", creds: true }], // AUTH over plaintext
    ["private-dns.example.com", { lookup: lookupPrivate }],   // resolves to 10.x
    ["mixed-dns.example.com", { lookup: lookupMixed }],       // one public + one private
  ];
  for (const [host, opts] of rejected) {
    it(`rejects ${host} ${JSON.stringify(opts)} without connecting`, async () => {
      const s = spyProvider(host, opts);
      await expect(s.provider.send(MSG)).rejects.toBeTruthy();
      expect(s.connectCalls(), "connect must not be called").toBe(0);
    });
  }

  it("generic error text leaks no IP / port / errno / banner", async () => {
    const s = spyProvider("127.0.0.1", {});
    await s.provider.send(MSG).then(() => { throw new Error("should have rejected"); }, (err: Error) => {
      expect(err).toBeInstanceOf(PermanentEmailError);
      expect(err.message).not.toMatch(/127\.0\.0\.1|\b25\b|ECONN|errno|\b465\b/);
      expect(err.message).toBe("destination not allowed");
    });
  });
});

describe("Phase 12.1 Q1 — allowed destinations + rebinding pin", () => {
  for (const port of [25, 587, 2525]) {
    it(`connects to a public IP on port ${port}`, async () => {
      const s = spyProvider("smtp.example.com", { port, security: "none" });
      const r = await s.provider.send(MSG);
      expect(r.delivered).toBe(true);
      expect(s.connectCalls()).toBe(1);
      expect(s.connectedHosts[0]).toBe(PUB); // connected to the resolved public IP, not the hostname
    });
  }
  it("port 465 with implicit TLS + credentials is allowed", async () => {
    const s = spyProvider("smtp.example.com", { port: 465, security: "tls", creds: true });
    expect((await s.provider.send(MSG)).delivered).toBe(true);
  });
  it("DNS rebinding: resolver returns public first, private second → pins the FIRST (public) address", async () => {
    let call = 0;
    const rebinding = async (): Promise<ResolvedAddr[]> => (++call === 1 ? [{ address: PUB, family: 4 }] : [{ address: "10.0.0.9", family: 4 }]);
    // assertPublicDestination resolves ONCE and pins; a second resolve never happens.
    const pinned = await assertPublicDestination("rebind.example.com", { lookup: rebinding });
    expect(pinned).toBe(PUB);
    expect(call).toBe(1); // resolved exactly once
  });
  it("assertPublicDestination rejects a non-resolving host and a private-only host", async () => {
    await expect(assertPublicDestination("nope.invalid", { lookup: async () => { throw new Error("ENOTFOUND"); } })).rejects.toBeInstanceOf(DestinationPolicyError);
    await expect(assertPublicDestination("p.example.com", { lookup: lookupPrivate })).rejects.toBeInstanceOf(DestinationPolicyError);
  });
});
