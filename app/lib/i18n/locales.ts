/**
 * Phase 13.2 — supported UI locales + a pure locale resolver.
 *
 * The storefront extension ships a locale file per entry here. `review` records
 * translation provenance: "source" (en), "reviewed" (fr, hand-written in Phase 7)
 * and "needs-native-review" (de/es/it/pt-BR/nl/ja/ar — machine-assisted strings
 * pending a native speaker's pass). The admin /app/localization page surfaces
 * this so a merchant knows which languages are production-ready.
 *
 * `dir` drives the app root's text direction (ar = rtl). We set lang/dir on the
 * APP's own root element only — NEVER on <html> — so the extension can be RTL on
 * an LTR theme (and vice-versa) without touching the host theme.
 */

export type LocaleReview = "source" | "reviewed" | "needs-native-review";
export interface SupportedLocale {
  code: string; // BCP-47, canonical case
  dir: "ltr" | "rtl";
  review: LocaleReview;
}

export const SUPPORTED_LOCALES: SupportedLocale[] = [
  { code: "en", dir: "ltr", review: "source" },
  { code: "fr", dir: "ltr", review: "reviewed" },
  { code: "de", dir: "ltr", review: "needs-native-review" },
  { code: "es", dir: "ltr", review: "needs-native-review" },
  { code: "it", dir: "ltr", review: "needs-native-review" },
  { code: "pt-BR", dir: "ltr", review: "needs-native-review" },
  { code: "nl", dir: "ltr", review: "needs-native-review" },
  { code: "ja", dir: "ltr", review: "needs-native-review" },
  { code: "ar", dir: "rtl", review: "needs-native-review" },
];

export const DEFAULT_LOCALE = "en";

/** Base language of a BCP-47 tag (the part before the first "-"), lower-cased. */
export function baseLanguage(code: string): string {
  return String(code).split("-")[0].toLowerCase();
}

/**
 * Resolve a requested locale to a supported one: EXACT (case-insensitive) match
 * first, then a base-language match (so "pt" or "pt-PT" → "pt-BR", "de-AT" →
 * "de"), else the default "en". Pure; hostile/empty input → default. The
 * requested value should already be validated by hints.validateLocale, but this
 * never trusts it (bounds the length, ignores junk).
 */
export function resolveLocale(
  requested: unknown,
  supported: SupportedLocale[] = SUPPORTED_LOCALES,
  fallback: string = DEFAULT_LOCALE,
): string {
  if (typeof requested !== "string") return fallback;
  const req = requested.trim();
  if (req.length === 0 || req.length > 35) return fallback;
  const lower = req.toLowerCase();
  // exact (case-insensitive)
  for (const s of supported) if (s.code.toLowerCase() === lower) return s.code;
  // base-language
  const base = baseLanguage(req);
  for (const s of supported) if (baseLanguage(s.code) === base) return s.code;
  return fallback;
}

/** Text direction for a resolved locale code (defaults ltr for unknown). */
export function localeDir(code: string): "ltr" | "rtl" {
  const hit = SUPPORTED_LOCALES.find((s) => s.code === code);
  return hit ? hit.dir : "ltr";
}

/** Is `code` one we ship? */
export function isSupportedLocale(code: string): boolean {
  return SUPPORTED_LOCALES.some((s) => s.code === code);
}
