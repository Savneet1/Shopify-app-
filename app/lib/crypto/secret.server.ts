import crypto from "node:crypto";

/**
 * Phase 12 — secret handling for email credentials and PII-safe lookups.
 *
 * Two independent concerns:
 *   1. SMTP passwords are ENCRYPTED AT REST with AES-256-GCM using a key from
 *      EMAIL_ENCRYPTION_KEY. We REFUSE to encrypt (and therefore to save a
 *      password) when the key is absent or malformed — the caller surfaces
 *      "email not configured" rather than ever storing a plaintext secret.
 *   2. Shopper emails are looked up / deduped / suppressed / redacted by a KEYED
 *      hash (HMAC-SHA256) so the plaintext never has to be queried on. The hash
 *      key (RESTOCK_HASH_KEY, falling back to SHOPIFY_API_SECRET) is always
 *      available, so collecting subscriptions does NOT depend on the (optional)
 *      email-encryption key.
 *
 * No key or secret is ever logged or returned to a client.
 */

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super("EMAIL_ENCRYPTION_KEY is not configured");
    this.name = "EncryptionKeyMissingError";
  }
}
export class DecryptionError extends Error {
  constructor() {
    super("failed to decrypt secret");
    this.name = "DecryptionError";
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parse the 32-byte AES key from env (64-hex or base64). Returns null if the
 * env var is absent or not exactly 32 bytes — callers treat null as "no key". */
function loadKey(): Buffer | null {
  const raw = process.env.EMAIL_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) return null;
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) buf = b;
    } catch { buf = null; }
  }
  return buf && buf.length === 32 ? buf : null;
}

/** Whether a usable email-encryption key is configured. */
export function hasEncryptionKey(): boolean {
  return loadKey() !== null;
}

/** Encrypt a UTF-8 plaintext → base64(iv||tag||ciphertext). Throws
 * EncryptionKeyMissingError when no key is configured (so a password is never
 * stored unencrypted). */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  if (!key) throw new EncryptionKeyMissingError();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt base64(iv||tag||ciphertext) → UTF-8. Throws on a missing key or any
 * tamper/format error. Never returns a partial result. */
export function decryptSecret(stored: string): string {
  const key = loadKey();
  if (!key) throw new EncryptionKeyMissingError();
  let raw: Buffer;
  try {
    raw = Buffer.from(stored, "base64");
  } catch {
    throw new DecryptionError();
  }
  if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new DecryptionError();
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}

/** The keyed-hash key. Always available in a running server (SHOPIFY_API_SECRET
 * is required env); RESTOCK_HASH_KEY overrides it so the email-lookup hash can
 * be rotated independently. */
function hashKey(): string {
  const k = process.env.RESTOCK_HASH_KEY || process.env.SHOPIFY_API_SECRET;
  if (!k) throw new Error("RESTOCK_HASH_KEY (or SHOPIFY_API_SECRET) is required");
  return k;
}

/** Keyed, shop-scoped hash of a NORMALISED email (lowercased/trimmed by the
 * caller). Hex. Used for dedupe/suppression/redaction lookups without querying
 * on the plaintext. Shop-scoped so the same address in two shops never collides
 * across tenants. */
export function emailHash(shopId: string, normalizedEmail: string): string {
  return crypto.createHmac("sha256", hashKey())
    .update(`${shopId}:${normalizedEmail}`)
    .digest("hex");
}

/** A random, URL-safe, unguessable token (e.g. the single-use confirm token). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * A keyed, deterministic, unguessable unsubscribe token for a subscription.
 * Deterministic (from the subscription id + server key) so it can be
 * reconstructed to embed in every outgoing email WITHOUT storing the raw token;
 * unguessable without the key. Only its hash (hashToken) is persisted. */
export function deriveUnsubToken(shopId: string, subscriptionId: string): string {
  return crypto.createHmac("sha256", hashKey())
    .update(`unsub:${shopId}:${subscriptionId}`)
    .digest("base64url");
}

/** Keyed hash of a raw token, for at-rest storage. Verified in constant time
 * via verifyToken. */
export function hashToken(rawToken: string): string {
  return crypto.createHmac("sha256", hashKey()).update(rawToken).digest("hex");
}

/** Constant-time comparison of a raw token against a stored hash. */
export function verifyToken(rawToken: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!rawToken || !storedHash) return false;
  const expected = Buffer.from(hashToken(rawToken));
  const provided = Buffer.from(storedHash);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}
