import { canonicalizeForPII } from "~/lib/analytics/events";

/**
 * Phase 12 — shopper email normalisation + validation + masking.
 *
 * Normalisation runs the SAME Unicode canonicalisation the analytics PII layer
 * uses (NFKC, strip invisible/format chars, fold decimal digits, full-width
 * "@"/"." → ASCII) BEFORE trimming + lowercasing, so a zero-width / full-width
 * obfuscated address cannot slip past dedupe, caps or the suppression list.
 * Emails are treated case-insensitively (lowercased). CR/LF/NUL are rejected
 * (header-injection safety). No display-name form is accepted.
 */

// Single bare address; no spaces, angle brackets, quotes, commas, semicolons.
const EMAIL_RE = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]{2,}$/;

export function normalizeEmail(raw: unknown): { email: string | null; valid: boolean } {
  if (raw == null) return { email: null, valid: false };
  let s = String(raw);
  if (s.length > 320) return { email: null, valid: false }; // bound before any work
  s = canonicalizeForPII(s).trim().toLowerCase();
  if (/[\r\n\u0000]/.test(s)) return { email: null, valid: false };
  if (s.length === 0 || s.length > 254 || !EMAIL_RE.test(s)) return { email: null, valid: false };
  return { email: s, valid: true };
}

/** Mask an email for admin display / logs: j***@e***.com. Never reveals the
 * full local part or domain label. Safe on malformed input. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  const domHead = dot >= 0 ? domain.slice(0, dot) : domain;
  const m = (s: string) => (s.length === 0 ? "" : s[0] + "***");
  return `${m(local)}@${m(domHead)}${tld}`;
}
