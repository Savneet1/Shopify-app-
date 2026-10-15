import { normalizeQuery } from "~/lib/search/text";

/**
 * Phase 11 — analytics event schema, PII redaction, and per-field validation.
 * Pure (no DB, no throw). Every value a storefront sends is validated here
 * BEFORE any SQL; invalid events are dropped individually. occurred_at is NOT
 * accepted from the client — the server stamps it at insert time.
 */

export const EVENT_TYPES = [
  "search_performed",
  "search_zero_result",
  "result_click",
  "predictive_click",
  "suggestion_click",
  "redirect_followed",
  "add_to_cart_from_search",
  "recommendation_click",
  "bundle_add_to_cart",
  "filter_applied",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SURFACES = ["search_page", "predictive", "recommendation", "bundle", "redirect"] as const;
export type Surface = (typeof SURFACES)[number];

export const MAX_BATCH = 20;
export const MAX_QUERY_LEN = 100;
export const MAX_PROPERTIES_BYTES = 2000;
export const MAX_PROPERTY_KEYS = 12;

const GID_RE = /^gid:\/\/shopify\/Product\/\d{1,20}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RawEvent {
  eventType?: unknown;
  surface?: unknown;
  sessionId?: unknown;
  query?: unknown;
  resultCount?: unknown;
  productGid?: unknown;
  position?: unknown;
  experimentId?: unknown;
  variant?: unknown;
  properties?: unknown;
  // A client-supplied timestamp is accepted in the payload but IGNORED (the
  // server stamps occurred_at). Present only so an unknown-keys check passes.
  ts?: unknown;
}

export interface CleanEvent {
  eventType: EventType;
  surface: Surface;
  sessionId: string | null;
  queryNorm: string | null;
  queryRedacted: boolean;
  resultCount: number | null;
  productGid: string | null;
  position: number | null;
  experimentId: string | null;
  variant: "A" | "B" | "control" | null;
  properties: Record<string, string | number | boolean>;
}

const ALLOWED_KEYS = new Set<string>([
  "eventType", "surface", "sessionId", "query", "resultCount",
  "productGid", "position", "experimentId", "variant", "properties", "ts",
]);

// ---- PII redaction ---------------------------------------------------------
//
// N2 (Phase 11.1): redaction must survive normalization-based evasion. An
// attacker (or an East-Asian IME) can split/obfuscate PII with zero-width or
// format characters and full-width / non-ASCII decimal digits, so that the RAW
// text does not match a card/phone/email pattern but the NORMALIZED text (NFKC
// + punctuation-folding) becomes a clean ASCII digit run. We therefore:
//   1. CANONICALIZE first (NFKC, strip invisible/format chars, fold every
//      Unicode decimal digit to ASCII, map full-width @/. to ASCII);
//   2. redact the canonical text;
//   3. normalizeQuery;
//   4. redact AGAIN on the normalized string (digit runs separated by
//      spaces/dashes only appear after punctuation-folding).
// Patterns match \p{Nd} (any Unicode decimal digit), so even a digit script we
// do not fold is still caught as a run. Redaction is idempotent and never throws.

// Unicode-aware. After canonicalization, "@"/"." are ASCII; letters may be
// international (e.g. exämple), domains internationalized.
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
// A run of 13–19 decimal digits (card-like), allowing spaces/dashes between.
const CARD_RE = /(?:\p{Nd}[ -]?){13,19}/gu;
// A run of 7+ decimal digits (phone-like), allowing spaces/dashes/parens/+.
const PHONE_RE = /\+?\p{Nd}[\p{Nd} ().-]{5,}\p{Nd}/gu;
// A long opaque token (>=20 chars) — likely an id/secret.
const TOKEN_RE = /\b[A-Za-z0-9_-]{20,}\b/g;

const INVISIBLE_RE = /[­​-‏⁠﻿]/g;
const Nd_RE = /\p{Nd}/u;
// Decimal-digit block "zero" code points, so any \p{Nd} folds to ASCII 0-9 by
// (code point − block zero). Covers the scripts a storefront realistically sees
// (NFKC already folds full-width/mathematical digits; these are the rest).
const DIGIT_ZEROES = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66,
  0xce6, 0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0x17e0, 0x1810, 0xff10,
];
function foldDigit(ch: string): string {
  const cp = ch.codePointAt(0)!;
  for (const z of DIGIT_ZEROES) if (cp >= z && cp <= z + 9) return String(cp - z);
  return ch; // untabled script: left as-is, but still caught by \p{Nd} runs
}

/** Count Unicode decimal digits in a string. */
function countDigits(s: string): number {
  let n = 0;
  for (const ch of s) if (Nd_RE.test(ch)) n++;
  return n;
}

/**
 * Canonicalize for PII detection: NFKC, remove invisible/format characters,
 * fold every Unicode decimal digit to ASCII. (NFKC already maps full-width
 * "@"/"." and full-width digits to ASCII; the explicit fold covers Arabic-Indic
 * etc.) Pure, never throws.
 */
export function canonicalizeForPII(input: string): string {
  let s = input.normalize("NFKC").replace(INVISIBLE_RE, "").replace(/\p{Cf}/gu, "");
  if (Nd_RE.test(s)) s = s.replace(/\p{Nd}/gu, foldDigit);
  return s;
}

/**
 * Redact likely PII. Order: emails, URLs, card runs, phone runs, long tokens.
 * Idempotent (re-running over "[redacted]" output changes nothing). Never throws.
 */
export function redactPII(input: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = input;
  const apply = (re: RegExp, test?: (m: string) => boolean) => {
    out = out.replace(re, (m) => {
      if (test && !test(m)) return m;
      redacted = true;
      return "[redacted]";
    });
  };
  apply(EMAIL_RE);
  apply(URL_RE);
  apply(CARD_RE, (m) => { const d = countDigits(m); return d >= 13 && d <= 19; });
  apply(PHONE_RE, (m) => countDigits(m) >= 7);
  apply(TOKEN_RE);
  return { text: out, redacted };
}

/**
 * Normalize + length-bound + redact a raw query. Canonicalize → redact →
 * normalizeQuery → redact again (so a run only visible after punctuation-folding
 * is still caught). Returns null for an absent/empty query. Never throws.
 */
// normalizeQuery folds "[redacted]" to "redacted" (brackets are not \p{L}\p{N}).
// To keep a visible, bracketed marker in the stored value, the pass-1 markers are
// swapped for a normalize-stable sentinel across the normalize step, then
// restored. The sentinel is letters only (survives normalize unchanged but for
// case), under 20 chars (not caught by TOKEN_RE), and not a digit run.
const REDACTION_SENTINEL = "zzredactedzz";

export function cleanQuery(raw: unknown): { queryNorm: string | null; redacted: boolean } {
  if (raw == null) return { queryNorm: null, redacted: false };
  let s = String(raw);
  if (s.length > 4000) s = s.slice(0, 4000); // guard before regex work
  const canon = canonicalizeForPII(s);
  const pass1 = redactPII(canon);
  // protect pass-1 markers across normalization
  const protectedText = pass1.text.split("[redacted]").join(REDACTION_SENTINEL);
  const normalized = normalizeQuery(protectedText);
  const pass2 = redactPII(normalized); // catch runs only visible after folding
  // restore protected markers to the bracketed form
  const restored = pass2.text.split(REDACTION_SENTINEL).join("[redacted]");
  const redacted = pass1.redacted || pass2.redacted;
  if (restored.length === 0) return { queryNorm: null, redacted };
  const bounded = restored.length > MAX_QUERY_LEN ? restored.slice(0, MAX_QUERY_LEN) : restored;
  return { queryNorm: bounded, redacted };
}

/** Redact a short property string value (canonicalize → redact). Never throws. */
export function redactValue(input: string): string {
  const s = input.length > 4000 ? input.slice(0, 4000) : input;
  return redactPII(canonicalizeForPII(s)).text;
}

// ---- per-field validation --------------------------------------------------

function boundedInt(v: unknown, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function sanitizeProperties(v: unknown): Record<string, string | number | boolean> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string | number | boolean> = {};
  let keys = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (keys >= MAX_PROPERTY_KEYS) break;
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue; // reject odd/nested keys
    // scalars only — no nested objects/arrays. String values are PII-redacted.
    if (typeof val === "string") { const r = redactValue(val); out[k] = r.length > 120 ? r.slice(0, 120) : r; }
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "boolean") out[k] = val;
    else continue;
    keys++;
  }
  // Enforce the serialized size cap; drop keys until it fits.
  let serialized = JSON.stringify(out);
  if (serialized.length > MAX_PROPERTIES_BYTES) {
    for (const k of Object.keys(out)) {
      delete out[k];
      serialized = JSON.stringify(out);
      if (serialized.length <= MAX_PROPERTIES_BYTES) break;
    }
  }
  return out;
}

/**
 * Validate + clean ONE raw event. Returns a CleanEvent or null (dropped).
 * Rejects unknown keys, bad enums, malformed gid/uuid/session, out-of-range
 * ints, and non-scalar properties. Never throws. `sessionAllowed` controls
 * whether a session id is kept (anonymous mode strips it).
 */
export function validateEvent(raw: unknown, opts: { sessionAllowed: boolean }): CleanEvent | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!ALLOWED_KEYS.has(k)) return null; // unknown key → drop

  const eventType = obj.eventType;
  if (typeof eventType !== "string" || !(EVENT_TYPES as readonly string[]).includes(eventType)) return null;
  const surface = obj.surface;
  if (typeof surface !== "string" || !(SURFACES as readonly string[]).includes(surface)) return null;

  let sessionId: string | null = null;
  if (opts.sessionAllowed && obj.sessionId != null && obj.sessionId !== "") {
    if (typeof obj.sessionId !== "string" || !SESSION_RE.test(obj.sessionId)) return null;
    sessionId = obj.sessionId;
  }

  const { queryNorm, redacted } = cleanQuery(obj.query);

  let productGid: string | null = null;
  if (obj.productGid != null && obj.productGid !== "") {
    if (typeof obj.productGid !== "string" || !GID_RE.test(obj.productGid)) return null;
    productGid = obj.productGid;
  }

  let experimentId: string | null = null;
  if (obj.experimentId != null && obj.experimentId !== "") {
    if (typeof obj.experimentId !== "string" || !UUID_RE.test(obj.experimentId)) return null;
    experimentId = obj.experimentId;
  }

  let variant: "A" | "B" | "control" | null = null;
  if (obj.variant != null && obj.variant !== "") {
    if (obj.variant !== "A" && obj.variant !== "B" && obj.variant !== "control") return null;
    variant = obj.variant;
  }

  const resultCount = boundedInt(obj.resultCount, 0, 100_000_000);
  if (obj.resultCount != null && obj.resultCount !== "" && resultCount === null) return null;
  const position = boundedInt(obj.position, 0, 100_000);
  if (obj.position != null && obj.position !== "" && position === null) return null;

  return {
    eventType: eventType as EventType,
    surface: surface as Surface,
    sessionId,
    queryNorm,
    queryRedacted: redacted,
    resultCount,
    productGid,
    position,
    experimentId,
    variant,
    properties: sanitizeProperties(obj.properties),
  };
}

/**
 * Validate a whole batch. Returns the clean events and how many were rejected.
 * Enforces the batch-size cap. Never throws.
 */
export function validateBatch(
  rawEvents: unknown, opts: { sessionAllowed: boolean },
): { clean: CleanEvent[]; rejected: number } {
  if (!Array.isArray(rawEvents)) return { clean: [], rejected: 0 };
  const capped = rawEvents.slice(0, MAX_BATCH);
  const overflow = Math.max(0, rawEvents.length - MAX_BATCH);
  const clean: CleanEvent[] = [];
  let rejected = overflow;
  for (const raw of capped) {
    const ev = validateEvent(raw, opts);
    if (ev) clean.push(ev);
    else rejected++;
  }
  return { clean, rejected };
}
