import pino from "pino";

/**
 * Structured logger. Redacts secret-bearing fields so tokens, HMACs, SMTP
 * passwords, hash peppers and API secrets never land in logs (Phase 14.4h).
 * Raw emails are never logged in the clear — use `maskEmail` for the rare case
 * an address must appear at all.
 */
const SECRET_FIELDS = [
  "accessToken", "access_token", "token", "confirmToken", "unsubToken", "abt",
  "password", "smtpPassword", "smtp_password", "pepper", "emailPepper",
  "apiSecret", "api_secret", "secret", "clientSecret", "encryptionKey",
  "EMAIL_ENCRYPTION_KEY", "SHOPIFY_API_SECRET", "signature", "hmac",
];
// Redact each secret field at the top level and nested one level under common
// wrappers (so `{smtp:{password}}`, `{data:{token}}` etc. are also caught).
const WRAPPERS = ["*", "req.headers"];
const redactPaths = [
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.flatMap((f) => WRAPPERS.map((w) => `${w}.${f}`)),
  "req.headers.authorization",
  'req.headers["x-shopify-hmac-sha256"]',
  "email", "*.email", "rawEmail", "*.rawEmail", // never log a raw address
];

/** The exact redaction config the app logger uses (exported for the 14.4h test). */
export const REDACT = { paths: redactPaths, censor: "[redacted]" as const };

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: REDACT,
});

/** Mask an email for the rare log line that must reference one: j***@e***.com.
 * Never logs the local part or full domain. */
export function maskEmail(email: string): string {
  const s = String(email);
  const at = s.indexOf("@");
  if (at <= 0) return "[redacted]";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domain[0] || ""}***${tld}`;
}

/** Phase 14.4i — slow-query / slow-request log. Emits a single WARN when a
 * labelled operation exceeds the threshold, with the shop id HASHED (never the
 * raw domain/uuid) and NO SQL text or parameters. Off below the threshold. */
import { createHash } from "node:crypto";
export const SLOW_QUERY_MS = Math.max(50, Number(process.env.SLOW_QUERY_MS || 1000));
export function hashShop(shopId: string): string {
  return createHash("sha256").update(String(shopId)).digest("hex").slice(0, 12);
}
export function maybeLogSlow(label: string, ms: number, shopId?: string): void {
  if (ms < SLOW_QUERY_MS) return;
  logger.warn({ label, ms: Math.round(ms), shop: shopId ? hashShop(shopId) : undefined }, "slow operation");
}

export type Logger = typeof logger;
