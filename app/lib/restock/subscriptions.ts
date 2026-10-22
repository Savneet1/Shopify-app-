import type { Exec } from "~/lib/db/executor";
import { normalizeEmail } from "./email";
import { randomUUID } from "node:crypto";
import { emailHash, getShopPepper, deriveUnsubToken, hashToken, verifyToken } from "~/lib/crypto/secret.server";
import { loadRestockSettings } from "./settings";

/**
 * Phase 12.2 — back-in-stock subscription capture (double opt-in).
 *
 * Security/privacy invariants enforced here:
 *  - All input is validated BEFORE any SQL; nothing throws on hostile input.
 *  - The product must be a VISIBLE doc in the ACTIVE index version AND currently
 *    UNAVAILABLE (product-level, or the chosen variant), else nothing is stored.
 *  - Dedupe on (shop, email_hash, product, variant); the suppression list and
 *    per-email / per-shop daily caps are honoured.
 *  - The PUBLIC result is identical whether or not a subscription already
 *    exists — the caller maps every outcome to one generic response.
 */

const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/[0-9]{1,20}$/;
const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/[0-9]{1,20}$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const SOURCES = new Set(["product_page", "search", "predictive", "recommendation", "bundle", "other"]);

export const CONFIRM_TTL_HOURS = 24 * 7; // confirm link valid for 7 days

export type SubscribeOutcome =
  | "created" | "exists" | "rejected" | "suppressed" | "capped" | "not_applicable";

export interface SubscribeInput {
  email?: unknown;
  productGid?: unknown;
  variantGid?: unknown;
  locale?: unknown;
  consent?: unknown;
  consentTextVersion?: unknown;
  source?: unknown;
}

export interface SubscribeResult {
  outcome: SubscribeOutcome;
  subscriptionId?: string;
}

interface Subscribable { productId: string; variantId: string | null; }

/** Is this product a visible doc in the active version AND currently
 * unavailable (product-level, or the specified variant)? Returns null if not. */
export async function checkSubscribable(
  exec: Exec, shopId: string, productGid: string, variantGid: string | null,
): Promise<Subscribable | null> {
  const docs = await exec.rows<{ product_id: string; available: boolean }>(
    `SELECT psd.product_id, psd.available
     FROM product_search_doc psd
     JOIN index_version iv ON iv.id = psd.index_version_id AND iv.status='active' AND iv.shop_id=psd.shop_id
     WHERE psd.shop_id=$1::uuid AND psd.shopify_product_gid=$2
       AND psd.published = true AND psd.status = 'ACTIVE'`,
    [shopId, productGid],
  );
  const doc = docs[0];
  if (!doc) return null; // not a visible doc in the active version

  if (!variantGid) {
    // Product-level: subscribable only when the product is currently unavailable.
    return doc.available === false ? { productId: doc.product_id, variantId: null } : null;
  }

  // Variant-level: the variant must belong to this product and be unavailable.
  const vrows = await exec.rows<{ id: string; available_for_sale: boolean | null }>(
    `SELECT id, available_for_sale FROM variant
     WHERE shop_id=$1::uuid AND product_id=$2::uuid AND shopify_variant_gid=$3 AND deleted_at IS NULL`,
    [shopId, doc.product_id, variantGid],
  );
  const v = vrows[0];
  if (!v) return null;
  return v.available_for_sale === false ? { productId: doc.product_id, variantId: v.id } : null;
}

function startOfUtcDay(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  return d.toISOString();
}

export async function isSuppressed(exec: Exec, shopId: string, hash: string): Promise<boolean> {
  const rows = await exec.rows<{ one: number }>(
    `SELECT 1 AS one FROM restock_suppression WHERE shop_id=$1::uuid AND email_hash=$2 LIMIT 1`,
    [shopId, hash],
  );
  return rows.length > 0;
}

export interface SubscribeDeps { now?: Date; }

/**
 * Validate + capture one subscription. Returns a typed outcome; the public
 * route maps every outcome to one generic response. On "created" the caller
 * sends the double-opt-in confirmation email using `confirmToken`.
 */
export async function subscribe(
  exec: Exec, shopId: string, input: SubscribeInput, deps: SubscribeDeps = {},
): Promise<SubscribeResult> {
  const now = deps.now ?? new Date();

  // ---- validation BEFORE any SQL ----
  const { email, valid } = normalizeEmail(input.email);
  if (!valid || !email) return { outcome: "rejected" };
  const productGid = typeof input.productGid === "string" ? input.productGid : "";
  if (!PRODUCT_GID_RE.test(productGid)) return { outcome: "rejected" };
  let variantGid: string | null = null;
  if (input.variantGid != null && input.variantGid !== "") {
    if (typeof input.variantGid !== "string" || !VARIANT_GID_RE.test(input.variantGid)) return { outcome: "rejected" };
    variantGid = input.variantGid;
  }
  const locale = typeof input.locale === "string" && LOCALE_RE.test(input.locale) ? input.locale : "en";
  if (input.consent !== true && input.consent !== "true" && input.consent !== "on") return { outcome: "rejected" };
  const source = typeof input.source === "string" && SOURCES.has(input.source) ? input.source : "other";
  const consentTextVersion = typeof input.consentTextVersion === "string"
    ? input.consentTextVersion.slice(0, 50) : "v1";

  // Per-shop pepper (Q3) keys the email hash; obtained inside the tenant context.
  const pepper = await getShopPepper(exec, shopId);
  const hash = emailHash(pepper, shopId, email);

  // ---- suppression (never re-mail an unsubscribed/bounced address) ----
  if (await isSuppressed(exec, shopId, hash)) return { outcome: "suppressed" };

  // ---- the product must be visible + currently unavailable ----
  const sub = await checkSubscribable(exec, shopId, productGid, variantGid);
  if (!sub) return { outcome: "not_applicable" };

  // ---- daily caps (anti-spam / anti-flood) ----
  const settings = await loadRestockSettings(exec, shopId);
  const dayStart = startOfUtcDay(now);
  const perEmail = await exec.rows<{ n: number }>(
    `SELECT count(*)::int n FROM back_in_stock_subscription
     WHERE shop_id=$1::uuid AND email_hash=$2 AND created_at >= $3::timestamptz`,
    [shopId, hash, dayStart],
  );
  if (Number(perEmail[0].n) >= settings.perEmailDailyCap) return { outcome: "capped" };
  const perShop = await exec.rows<{ n: number }>(
    `SELECT count(*)::int n FROM back_in_stock_subscription
     WHERE shop_id=$1::uuid AND created_at >= $2::timestamptz`,
    [shopId, dayStart],
  );
  if (Number(perShop[0].n) >= settings.perShopDailyCap) return { outcome: "capped" };

  // ---- create (dedupe via unique index; existing row → identical response) ----
  // The id is generated app-side so the deterministic unsubscribe token (keyed
  // HMAC of the id) can be hashed and stored in the SAME insert (one query).
  // Q2: NO confirm token is minted here and NO email is sent in this (public)
  // request. The row is 'pending' with no confirm token; the worker mints a
  // fresh token, stores its hash+expiry, and sends the confirmation email.
  const subscriptionId = randomUUID();
  const unsubTokenHash = hashToken(deriveUnsubToken(shopId, subscriptionId));
  const variantKey = variantGid ?? "";

  const inserted = await exec.rows<{ id: string }>(
    `INSERT INTO back_in_stock_subscription
       (id, shop_id, product_id, shopify_product_gid, variant_id, variant_gid, variant_key,
        email, email_hash, locale, status, consented_at, consent_text_version, source,
        unsubscribe_token_hash, created_at, updated_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,$10,'pending',$11::timestamptz,$12,$13,$14, now(), now())
     ON CONFLICT (shop_id, email_hash, shopify_product_gid, variant_key) DO NOTHING
     RETURNING id`,
    [
      subscriptionId, shopId, sub.productId, productGid, sub.variantId, variantGid, variantKey,
      email, hash, locale, now.toISOString(), consentTextVersion, source, unsubTokenHash,
    ],
  );

  if (inserted.length === 0) return { outcome: "exists" }; // dedupe: do not reveal, do not resend
  return { outcome: "created", subscriptionId: inserted[0].id };
}

/** Confirm a pending subscription via its id + raw confirm token. Generic
 * boolean result; never reveals whether the row exists. Idempotent-ish: an
 * already-confirmed row returns false (no state change) but leaks nothing. */
export async function confirmSubscription(
  exec: Exec, shopId: string, subscriptionId: string, rawToken: string, deps: SubscribeDeps = {},
): Promise<{ confirmed: boolean }> {
  if (!isUuid(subscriptionId)) return { confirmed: false };
  const now = deps.now ?? new Date();
  const rows = await exec.rows<{ id: string; confirm_token_hash: string | null; confirm_expires_at: string | null; status: string }>(
    `SELECT id, confirm_token_hash, confirm_expires_at, status
     FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, subscriptionId],
  );
  const r = rows[0];
  if (!r || r.status !== "pending") return { confirmed: false };
  if (!verifyToken(rawToken, r.confirm_token_hash)) return { confirmed: false };
  if (!r.confirm_expires_at || new Date(r.confirm_expires_at).getTime() < now.getTime()) return { confirmed: false };
  const upd = await exec.run(
    `UPDATE back_in_stock_subscription
     SET status='confirmed', confirmed_at=now(), confirm_token_hash=NULL, confirm_expires_at=NULL, updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid AND status='pending'`,
    [shopId, subscriptionId],
  );
  return { confirmed: upd > 0 };
}

/** Unsubscribe via id + raw unsubscribe token. Idempotent (already-unsubscribed
 * returns ok=true). Adds a suppression record so the address is never re-mailed.
 * Never reveals whether the row exists. */
export async function unsubscribe(
  exec: Exec, shopId: string, subscriptionId: string, rawToken: string,
): Promise<{ ok: boolean }> {
  if (!isUuid(subscriptionId)) return { ok: false };
  const rows = await exec.rows<{ id: string; unsubscribe_token_hash: string; email_hash: string; status: string }>(
    `SELECT id, unsubscribe_token_hash, email_hash, status
     FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, subscriptionId],
  );
  const r = rows[0];
  if (!r) return { ok: false };
  if (!verifyToken(rawToken, r.unsubscribe_token_hash)) return { ok: false };
  await exec.run(
    `UPDATE back_in_stock_subscription SET status='unsubscribed', updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, subscriptionId],
  );
  await exec.run(
    `INSERT INTO restock_suppression (shop_id, email_hash, reason, created_at)
     VALUES ($1::uuid,$2,'unsubscribed', now())
     ON CONFLICT (shop_id, email_hash) DO NOTHING`,
    [shopId, r.email_hash],
  );
  return { ok: true };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
