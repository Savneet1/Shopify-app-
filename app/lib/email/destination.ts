import net from "node:net";
import { PermanentEmailError } from "./errors";

/**
 * Phase 12.1 Q1 — SMTP destination policy (anti-SSRF).
 *
 * The SMTP host/port are merchant-controlled and the same settings drive the
 * PUBLIC subscribe flow, so an unrestricted connect is a server-side request
 * forgery / internal port-scan oracle (refused vs hang vs ENOTFOUND, echoed
 * internal IP:port). This module is PURE and has two layers:
 *
 *   1. validateDestination() — host SHAPE + allowed port + TLS/cred consistency.
 *      Applied at SAVE time (fast feedback) and again at every connect.
 *   2. assertPublicDestination() — at connect time, resolve the hostname (with an
 *      injectable resolver), reject if ANY resolved address is non-public, and
 *      PIN the validated IP (connect to it; use the hostname only for TLS SNI /
 *      cert verification) — defeating DNS rebinding.
 *
 * Nothing here opens a socket. Errors are generic (no IP/port/errno leak).
 */

// A policy violation is a PERMANENT configuration error (no retry loop, no
// 45s waits). Extends PermanentEmailError so the notifier classifies it so.
export class DestinationPolicyError extends PermanentEmailError {
  constructor(message = "destination not allowed") { super(message); this.name = "DestinationPolicyError"; }
}

export const ALLOWED_PORTS = [25, 465, 587, 2525] as const;
export type SmtpSecurityLite = "none" | "starttls" | "tls";

// A conservative DNS hostname: labels of [A-Za-z0-9-] (no leading/trailing
// hyphen), 1..63 each, total <= 253, at least two labels, no trailing dot, a
// non-numeric TLD (so a bare "127.0.0.1" / "0x7f..." / "2130706433" is NOT a
// valid hostname and must go through the IP-literal branch instead).
const HOSTNAME_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

export interface DestinationInput {
  host: string | null | undefined;
  port: number | null | undefined;
  security: SmtpSecurityLite;
  hasCredentials: boolean;
}
export type DestinationVerdict = { ok: true; host: string; port: number } | { ok: false; reason: string };

/** Pure host-shape + port + TLS/credential-consistency check. */
export function validateDestination(input: DestinationInput): DestinationVerdict {
  const host = typeof input.host === "string" ? input.host : "";
  // No whitespace / control chars / userinfo / port-in-host / brackets.
  if (host.length === 0 || host.length > 253) return { ok: false, reason: "destination not allowed" };
  if (/[\s\u0000-\u001f\u007f]/.test(host)) return { ok: false, reason: "destination not allowed" };
  if (host.includes("@") || host.includes("/") || host.includes("\\")) return { ok: false, reason: "destination not allowed" };
  // Reject a host that carries a port (e.g. "h:25") or IPv6 brackets.
  if (host.includes(":") && net.isIP(host) !== 6) return { ok: false, reason: "destination not allowed" };
  if (host.includes("[") || host.includes("]")) return { ok: false, reason: "destination not allowed" };

  const ipVer = net.isIP(host); // 0 = not an IP literal, 4 or 6 otherwise
  const isHostname = HOSTNAME_RE.test(host);
  if (ipVer === 0 && !isHostname) {
    // Not a canonical IP literal and not a valid DNS hostname → this catches
    // decimal (2130706433), hex (0x7f000001), octal, and short IPv4 forms.
    return { ok: false, reason: "destination not allowed" };
  }

  const port = Number(input.port);
  if (!Number.isInteger(port) || !(ALLOWED_PORTS as readonly number[]).includes(port)) {
    return { ok: false, reason: "destination port not allowed" };
  }
  // 465 is implicit TLS by definition.
  if (port === 465 && input.security !== "tls") return { ok: false, reason: "port 465 requires implicit TLS" };
  // Never allow AUTH credentials over a plaintext connection.
  if (input.hasCredentials && input.security === "none") return { ok: false, reason: "credentials require TLS" };
  return { ok: true, host, port };
}

// ---- IP classification ----------------------------------------------------

function v4ToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}
function inCidrV4(ip: number, netStr: string, bits: number): boolean {
  const [a, b, c, d] = netStr.split(".").map(Number);
  const base = v4ToInt(a, b, c, d);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

/** True when a dotted-quad IPv4 is a PUBLIC (globally routable) address. */
export function isPublicIPv4(ip: string): boolean {
  const m = ip.split(".");
  if (m.length !== 4) return false;
  const oct = m.map((x) => Number(x));
  if (oct.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const n = v4ToInt(oct[0], oct[1], oct[2], oct[3]);
  const BLOCKED: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !BLOCKED.some(([netStr, bits]) => inCidrV4(n, netStr, bits));
}

/** Parse an IPv6 literal to 16 bytes, or null. Handles "::" and a trailing
 * embedded IPv4 ("::ffff:1.2.3.4"). */
export function ipv6ToBytes(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (net.isIP(s) !== 6) return null;
  // Expand an embedded IPv4 tail into two hextets.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const q = tail.split(".").map(Number);
    if (q.length !== 4 || q.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hex = ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hex;
  }
  const dbl = s.indexOf("::");
  let groups: string[];
  if (dbl >= 0) {
    const head = s.slice(0, dbl).split(":").filter((x) => x !== "");
    const tailp = s.slice(dbl + 2).split(":").filter((x) => x !== "");
    const fill = 8 - head.length - tailp.length;
    if (fill < 0) return null;
    groups = head.concat(Array(fill).fill("0"), tailp);
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const v = parseInt(g || "0", 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** True when an IPv6 literal is a PUBLIC address (also inspecting any embedded /
 * mapped IPv4: v4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16,
 * Teredo 2001:0000::/32). */
export function isPublicIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return false;
  const allZero = b.every((x) => x === 0);
  if (allZero) return false;                                   // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return false; // ::1
  if ((b[0] & 0xfe) === 0xfc) return false;                    // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false;   // fe80::/10 link-local
  if (b[0] === 0xff) return false;                             // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 doc
  const v4 = (i: number) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  // v4-mapped ::ffff:0:0/96
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return isPublicIPv4(v4(12));
  // NAT64 64:ff9b::/96
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return isPublicIPv4(v4(12));
  // 6to4 2002::/16 → embedded v4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicIPv4(v4(2));
  // Teredo 2001:0000::/32 → client v4 is ~bytes[12..15]
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    const c = `${b[12] ^ 0xff}.${b[13] ^ 0xff}.${b[14] ^ 0xff}.${b[15] ^ 0xff}`;
    return isPublicIPv4(c);
  }
  return true;
}

/** True when an IP literal (v4 or v6) is a public, connectable address. */
export function isPublicIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPublicIPv4(ip);
  if (v === 6) return isPublicIPv6(ip);
  return false;
}

export interface ResolvedAddr { address: string; family: number }
export type LookupAllFn = (hostname: string) => Promise<ResolvedAddr[]>;

export interface AssertPublicDeps { lookup: LookupAllFn; allowPrivate?: boolean }

/**
 * Resolve `host` and return the single PINNED IP to connect to. Rejects
 * (DestinationPolicyError) if the hostname does not resolve or ANY resolved
 * address is non-public. The caller connects to the returned IP and uses the
 * original hostname only for TLS SNI + certificate verification. `allowPrivate`
 * (dev-only escape, never honoured in production) skips the public-range check.
 */
export async function assertPublicDestination(host: string, deps: AssertPublicDeps): Promise<string> {
  // A literal host needs no DNS; validate it directly and pin it.
  const litVer = net.isIP(host);
  if (litVer !== 0) {
    if (!deps.allowPrivate && !isPublicIp(host)) throw new DestinationPolicyError();
    return host;
  }
  let addrs: ResolvedAddr[];
  try { addrs = await deps.lookup(host); } catch { throw new DestinationPolicyError("could not resolve destination"); }
  if (!addrs || addrs.length === 0) throw new DestinationPolicyError("could not resolve destination");
  if (!deps.allowPrivate) {
    for (const a of addrs) { if (!isPublicIp(a.address)) throw new DestinationPolicyError(); }
  }
  return addrs[0].address; // PIN the first validated address (no second resolve)
}
