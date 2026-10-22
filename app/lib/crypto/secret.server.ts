import crypto from "node:crypto";
import type { Exec } from "~/lib/db/executor";

/**
 * Phase 12 / 12.1 — secret handling for email credentials and PII-safe lookups.
 *
 * Three concerns:
 *   1. SMTP passwords are ENCRYPTED AT REST with AES-256-GCM, bound to their
 *      context with Associated Data (shop id + a fixed purpose) and a version
 *      byte (Q4a). We REFUSE to encrypt when EMAIL_ENCRYPTION_KEY is absent.
 *   2. Shopper emails are looked up / deduped / suppressed / redacted by a KEYED
 *      hash (HMAC-SHA256). The key is a PER-SHOP random PEPPER (Q3), generated
 *      lazily under RLS and stored in restock_hash_pepper — NOT SHOPIFY_API_SECRET
 *      (rotating that secret would orphan every stored email_hash).
 *   3. Confirm / unsubscribe TOKENS are HMAC'd with the app signing secret
 *      (SHOPIFY_API_SECRET, a required env), independent of the email pepper.
 *
 * No key, pepper or secret is ever logged or returned to a client.
 */

export class EncryptionKeyMissingError extends Error {
  constructor() { super("EMAIL_ENCRYPTION_KEY is not configured"); this.name = "EncryptionKeyMissingError"; }
}
export class DecryptionError extends Error {
  constructor() { super("failed to decrypt secret"); this.name = "DecryptionError"; }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1; // ciphertext format version byte (Q4a)

/** Parse the 32-byte AES key from env (64-hex or base64). Null when absent/invalid. */
function loadKey(): Buffer | null {
  const raw = process.env.EMAIL_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) return null;
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else { try { const b = Buffer.from(raw, "base64"); if (b.length === 32) buf = b; } catch { buf = null; } }
  return buf && buf.length === 32 ? buf : null;
}

export function hasEncryptionKey(): boolean { return loadKey() !== null; }

/** The Associated Data that binds a ciphertext to its shop + purpose, so a
 * ciphertext copied into another shop's row fails to decrypt (Q4a). */
export function passwordAad(shopId: string): Buffer {
  return Buffer.from(`${shopId}:email_setting.password`, "utf8");
}

/** Encrypt a UTF-8 plaintext → base64(version(1) || iv(12) || tag(16) || ct),
 * authenticated with `aad`. Throws EncryptionKeyMissingError without a key. */
export function encryptSecret(plaintext: string, aad: Buffer): string {
  const key = loadKey();
  if (!key) throw new EncryptionKeyMissingError();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]).toString("base64");
}

/** Decrypt base64(version||iv||tag||ct) → UTF-8, verifying `aad`. Throws on a
 * missing key, wrong aad, unknown version, or any tamper/format error. */
export function decryptSecret(stored: string, aad: Buffer): string {
  const key = loadKey();
  if (!key) throw new EncryptionKeyMissingError();
  let raw: Buffer;
  try { raw = Buffer.from(stored, "base64"); } catch { throw new DecryptionError(); }
  if (raw.length < 1 + IV_BYTES + TAG_BYTES + 1) throw new DecryptionError();
  if (raw[0] !== VERSION) throw new DecryptionError();
  const iv = raw.subarray(1, 1 + IV_BYTES);
  const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch { throw new DecryptionError(); }
}

// ---- per-shop email pepper (Q3) -------------------------------------------

/**
 * Obtain this shop's email-hash pepper, creating it lazily on first use. Must be
 * called inside the shop's RLS/tenant context (the exec is shop-scoped). The
 * INSERT ... ON CONFLICT DO NOTHING + SELECT is race-safe: two concurrent
 * first-use requests converge on the ONE stored pepper. Returns 64 hex chars.
 */
export async function getShopPepper(exec: Exec, shopId: string): Promise<string> {
  const candidate = crypto.randomBytes(32).toString("hex");
  await exec.run(
    `INSERT INTO restock_hash_pepper (shop_id, pepper) VALUES ($1::uuid, $2)
     ON CONFLICT (shop_id) DO NOTHING`,
    [shopId, candidate],
  );
  const rows = await exec.rows<{ pepper: string }>(
    `SELECT pepper FROM restock_hash_pepper WHERE shop_id=$1::uuid`, [shopId],
  );
  if (!rows[0]) throw new Error("pepper unavailable"); // RLS context missing
  return rows[0].pepper;
}

/**
 * Keyed, shop-scoped hash of a NORMALISED email, using the per-shop pepper as
 * the HMAC key. Deterministic for a given (pepper, shop, email); independent of
 * SHOPIFY_API_SECRET, so rotating the app secret never orphans stored hashes.
 */
export function emailHash(pepper: string, shopId: string, normalizedEmail: string): string {
  return crypto.createHmac("sha256", pepper).update(`${shopId}:${normalizedEmail}`).digest("hex");
}

// ---- confirm / unsubscribe tokens (app signing secret) --------------------

function tokenKey(): string {
  const k = process.env.SHOPIFY_API_SECRET;
  if (!k) throw new Error("SHOPIFY_API_SECRET is required");
  return k;
}

/** A random, URL-safe, unguessable token (the single-use confirm token). */
export function generateToken(): string { return crypto.randomBytes(32).toString("base64url"); }

/** A keyed, deterministic, unguessable unsubscribe token for a subscription,
 * reconstructable without storage; only its hash is persisted. */
export function deriveUnsubToken(shopId: string, subscriptionId: string): string {
  return crypto.createHmac("sha256", tokenKey()).update(`unsub:${shopId}:${subscriptionId}`).digest("base64url");
}

/** Keyed hash of a raw token, for at-rest storage. */
export function hashToken(rawToken: string): string {
  return crypto.createHmac("sha256", tokenKey()).update(rawToken).digest("hex");
}

/** Constant-time comparison of a raw token against a stored hash. */
export function verifyToken(rawToken: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!rawToken || !storedHash) return false;
  const expected = Buffer.from(hashToken(rawToken));
  const provided = Buffer.from(storedHash);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}
