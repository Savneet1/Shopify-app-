import { EmailValidationError } from "./errors";

/**
 * Phase 12 — pure MIME construction with strict header-injection protection.
 * No network, no throw except EmailValidationError on hostile input. Builds a
 * multipart/alternative (text + optional html) message with correctly encoded
 * headers, dot-stuffed body, and an RFC 2047 encoded Subject when non-ASCII.
 */

export const MAX_MESSAGE_BYTES = 256 * 1024; // hard cap on the serialized message

// A bare email address, conservative. (We never accept a display-name form from
// callers — display names are passed separately and encoded, closing the
// "To: victim@x\r\nBcc: ..." and "Name <a@b>" injection vectors.)
const ADDRESS_RE = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]{2,}$/;

/** Reject any header VALUE containing CR or LF (header injection) or NUL. */
export function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n\u0000]/.test(value)) {
    throw new EmailValidationError(`illegal control character in ${field}`);
  }
}

/** Validate a bare email address used in a header / SMTP command. */
export function assertAddress(addr: unknown, field: string): string {
  if (typeof addr !== "string") throw new EmailValidationError(`${field} must be a string`);
  const a = addr.trim();
  assertNoHeaderInjection(a, field);
  if (a.length === 0 || a.length > 254 || !ADDRESS_RE.test(a)) {
    throw new EmailValidationError(`invalid ${field} address`);
  }
  return a;
}

/** True when a string is pure ASCII printable (no encoding needed). */
function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/**
 * RFC 2047 "encoded-word" for a header value when it contains non-ASCII (UTF-8,
 * Base64). ASCII passes through unchanged (after an injection check). Splits
 * into <=75-char encoded words per the RFC.
 */
export function encodeHeaderWord(value: string): string {
  assertNoHeaderInjection(value, "header");
  if (isAscii(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  // Max raw bytes per encoded word so the whole word stays <= 75 chars:
  // "=?UTF-8?B?" (10) + "?=" (2) = 12 overhead; base64 is 4 chars per 3 bytes.
  const maxRaw = Math.floor(((75 - 12) / 4)) * 3; // 45 bytes
  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += maxRaw) {
    words.push("=?UTF-8?B?" + bytes.subarray(i, i + maxRaw).toString("base64") + "?=");
  }
  return words.join("\r\n "); // folded with a leading space (continuation)
}

/** Format an address header, optionally with an encoded display name. */
export function formatAddressHeader(address: string, name?: string): string {
  const addr = assertAddress(address, "address");
  if (!name || name.trim().length === 0) return addr;
  const encoded = encodeHeaderWord(name.trim());
  return `${encoded} <${addr}>`;
}

/** SMTP dot-stuffing: any line beginning with '.' gets an extra leading '.'.
 * Operates on the already-CRLF-joined body. */
export function dotStuff(body: string): string {
  return body.replace(/^\./gm, "..");
}

export interface BuiltMessage {
  from: string;
  to: string;
  /** The full serialized RFC 5322 message (headers + CRLF CRLF + body), already
   * dot-stuffed and CRLF-normalised, WITHOUT the trailing "\r\n.\r\n" terminator
   * (the SMTP client appends that). */
  data: string;
  bytes: number;
}

export interface BuildInput {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Injectable for deterministic tests. */
  now?: Date;
  messageId?: string;
  boundary?: string;
}

const ALLOWED_EXTRA_HEADERS = new Set([
  "list-unsubscribe",
  "list-unsubscribe-post",
  "auto-submitted",
  "x-entity-ref-id",
]);

/**
 * Build a complete multipart/alternative message. Every header value is
 * injection-checked; the Subject is RFC 2047 encoded if non-ASCII; From/To/
 * Reply-To are validated bare addresses (display name encoded separately).
 * Enforces MAX_MESSAGE_BYTES.
 */
export function buildMessage(input: BuildInput): BuiltMessage {
  const from = assertAddress(input.from, "from");
  const to = assertAddress(input.to, "to");
  const now = input.now ?? new Date();
  const boundary = input.boundary ?? "b_" + Buffer.from(String(now.getTime()) + ":bnd").toString("hex").slice(0, 24);
  const fromHeader = formatAddressHeader(from, input.fromName);

  const headers: string[] = [];
  headers.push(`From: ${fromHeader}`);
  headers.push(`To: ${to}`);
  if (input.replyTo != null && input.replyTo !== "") {
    headers.push(`Reply-To: ${assertAddress(input.replyTo, "replyTo")}`);
  }
  headers.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  headers.push(`Date: ${now.toUTCString()}`);
  const msgId = input.messageId ?? `${now.getTime()}.${Buffer.from(String(Math.random())).toString("hex").slice(0, 12)}@${from.split("@")[1]}`;
  assertNoHeaderInjection(msgId, "Message-ID");
  headers.push(`Message-ID: <${msgId}>`);
  headers.push("MIME-Version: 1.0");

  // Caller-supplied extra headers (allowlisted names; values injection-checked).
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const name = k.trim();
    if (!ALLOWED_EXTRA_HEADERS.has(name.toLowerCase())) continue;
    assertNoHeaderInjection(name, "header name");
    if (/[^\x21-\x7e]/.test(name) || name.includes(":")) continue; // valid header name only
    assertNoHeaderInjection(v, name);
    headers.push(`${name}: ${v}`);
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/plain; charset=UTF-8");
  parts.push("Content-Transfer-Encoding: base64");
  parts.push("");
  parts.push(chunk76(Buffer.from(input.text, "utf8").toString("base64")));
  if (input.html != null && input.html !== "") {
    parts.push(`--${boundary}`);
    parts.push("Content-Type: text/html; charset=UTF-8");
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    parts.push(chunk76(Buffer.from(input.html, "utf8").toString("base64")));
  }
  parts.push(`--${boundary}--`);

  const raw = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + "\r\n";
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"); // canonical CRLF
  const data = dotStuff(normalized);
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new EmailValidationError(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
  return { from, to, data, bytes };
}

/** Wrap a base64 blob at 76 chars per line (RFC 2045). */
function chunk76(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join("\r\n");
}
