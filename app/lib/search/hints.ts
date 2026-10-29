/**
 * Phase 13.3 — storefront market/context hints (UNTRUSTED).
 *
 * The Shopify App Proxy signs ONLY shop, logged_in_customer_id, path_prefix,
 * timestamp and signature — it does NOT pass locale, country, market or
 * currency. Those must be sent by the storefront JS from the Liquid objects
 * (request.locale, localization.country.iso_code, localization.country.currency.iso_code)
 * as VALIDATED, UNTRUSTED hints. This module is the single validation point.
 *
 * RULES (all enforced here):
 *   - Every hint is validated to a strict shape BEFORE it is used in any SQL.
 *   - The ONLY server-side use of a hint is LOCALE SCOPING (Phase 13.2d:
 *     `locale IS NULL OR locale = <validated>`). Country/currency are accepted,
 *     validated and otherwise IGNORED server-side (price localisation is a
 *     CLIENT concern — see price hydration). We never echo a hint back, never
 *     log it, and it never crosses a tenant boundary.
 *   - Anything that does not match → null (treated as "no hint" → the default,
 *     byte-identical behaviour). Never throws.
 */

const COUNTRY_RE = /^[A-Za-z]{2}$/; // ISO 3166-1 alpha-2
const CURRENCY_RE = /^[A-Za-z]{3}$/; // ISO 4217
// BCP-47 subset: language(2-3) + optional script(4) + optional region(2 alpha | 3 digit).
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$/;
const LOCALE_MAX = 10;

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // Reject control characters outright (defends against header/log injection).
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  const s = v.trim();
  return s.length === 0 ? null : s;
}

/** Validate an ISO 3166-1 alpha-2 country → uppercase, or null. */
export function validateCountry(v: unknown): string | null {
  const s = asString(v);
  return s && COUNTRY_RE.test(s) ? s.toUpperCase() : null;
}

/** Validate an ISO 4217 currency → uppercase, or null. */
export function validateCurrency(v: unknown): string | null {
  const s = asString(v);
  return s && CURRENCY_RE.test(s) ? s.toUpperCase() : null;
}

/**
 * Validate a BCP-47 locale (subset) → canonical case (lang lower, Script Title,
 * REGION upper), or null. Bounded to 10 chars BEFORE the regex to cap work.
 */
export function validateLocale(v: unknown): string | null {
  const s = asString(v);
  if (!s || s.length > LOCALE_MAX) return null;
  if (!LOCALE_RE.test(s)) return null;
  const parts = s.split("-");
  const out = [parts[0].toLowerCase()];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 4 && /^[A-Za-z]+$/.test(p)) out.push(p[0].toUpperCase() + p.slice(1).toLowerCase()); // script
    else out.push(p.toUpperCase()); // region (alpha or numeric)
  }
  return out.join("-");
}

export interface MarketHints {
  country: string | null;
  currency: string | null;
  locale: string | null;
}

/** Validate a raw hint bag (e.g. parsed query params). Each field independently
 * validated; unknown fields dropped. Never throws. */
export function validateHints(raw: unknown): MarketHints {
  const r = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  return {
    country: validateCountry(r.country),
    currency: validateCurrency(r.currency),
    locale: validateLocale(r.locale),
  };
}
