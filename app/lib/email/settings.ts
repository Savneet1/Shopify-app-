import type { Exec } from "~/lib/db/executor";
import { encryptSecret, decryptSecret, hasEncryptionKey, EncryptionKeyMissingError, passwordAad } from "~/lib/crypto/secret.server";
import type { SmtpSecurity } from "./smtp";
import { validateDestination, DestinationPolicyError } from "./destination";

/**
 * Phase 12.1 — per-shop SMTP settings. The password is stored ENCRYPTED
 * (AES-256-GCM) and is write-only from the admin's perspective: it is never
 * returned to a client and never logged. The admin sees only whether it is
 * configured and, at most, its last 2 characters.
 */

export interface EmailSettingsInput {
  host?: string | null;
  port?: number | null;
  security?: SmtpSecurity;
  username?: string | null;
  /** New plaintext password; omit to keep the stored one, or pass empty+clear. */
  password?: string | null;
  clearPassword?: boolean;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
}

/** Safe view of the settings (NO password). */
export interface EmailSettingsView {
  host: string | null;
  port: number | null;
  security: SmtpSecurity;
  username: string | null;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  passwordSet: boolean;
  /** At most the last 2 chars of the password, for the merchant to recognise it. */
  passwordLast2: string | null;
  /** True when enough is set to actually send (host + port + fromEmail, and if a
   * username is set, a decryptable password + a present encryption key). */
  configured: boolean;
  /** True when the encryption key is present so a password CAN be saved. */
  encryptionAvailable: boolean;
}

interface Row {
  host: string | null;
  port: number | null;
  security: SmtpSecurity;
  username: string | null;
  password_cipher: string | null;
  from_email: string | null;
  from_name: string | null;
  reply_to: string | null;
}

async function readRow(exec: Exec, shopId: string): Promise<Row | null> {
  const rows = await exec.rows<Row>(
    `SELECT host, port, security, username, password_cipher, from_email, from_name, reply_to
     FROM email_setting WHERE shop_id=$1::uuid`,
    [shopId],
  );
  return rows[0] ?? null;
}

function computeConfigured(row: Row | null, shopId: string): boolean {
  if (!row || !row.host || !row.port || !row.from_email) return false;
  // Destination must satisfy the SSRF policy (host shape + allowed port + 465⇒TLS).
  if (!validateDestination({ host: row.host, port: row.port, security: row.security, hasCredentials: Boolean(row.username) }).ok) return false;
  if (row.username) {
    // A username implies auth; we must be able to decrypt the password to send.
    if (!row.password_cipher || !hasEncryptionKey()) return false;
    try { decryptSecret(row.password_cipher, passwordAad(shopId)); } catch { return false; }
  }
  return true;
}

export async function loadEmailSettingsView(exec: Exec, shopId: string): Promise<EmailSettingsView> {
  const row = await readRow(exec, shopId);
  let last2: string | null = null;
  if (row?.password_cipher && hasEncryptionKey()) {
    try { const p = decryptSecret(row.password_cipher, passwordAad(shopId)); last2 = p.length >= 2 ? p.slice(-2) : null; } catch { last2 = null; }
  }
  return {
    host: row?.host ?? null,
    port: row?.port ?? null,
    security: row?.security ?? "starttls",
    username: row?.username ?? null,
    fromEmail: row?.from_email ?? null,
    fromName: row?.from_name ?? null,
    replyTo: row?.reply_to ?? null,
    passwordSet: Boolean(row?.password_cipher),
    passwordLast2: last2,
    configured: computeConfigured(row, shopId),
    encryptionAvailable: hasEncryptionKey(),
  };
}

function clampPort(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

function cleanStr(v: unknown, max = 320): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length === 0) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Save SMTP settings. The password is write-only: supplying a non-empty
 * `password` encrypts and stores it (REQUIRING the encryption key — otherwise
 * EncryptionKeyMissingError, and nothing is written); omitting it preserves the
 * stored one; `clearPassword` removes it. Returns the safe view.
 */
export async function saveEmailSettings(
  exec: Exec, shopId: string, input: EmailSettingsInput,
): Promise<EmailSettingsView> {
  const existing = await readRow(exec, shopId);

  const host = input.host !== undefined ? cleanStr(input.host, 255) : (existing?.host ?? null);
  const port = input.port !== undefined ? clampPort(input.port) : (existing?.port ?? null);
  const security: SmtpSecurity =
    input.security && ["none", "starttls", "tls"].includes(input.security) ? input.security : (existing?.security ?? "starttls");
  const username = input.username !== undefined ? cleanStr(input.username, 255) : (existing?.username ?? null);
  const fromEmail = input.fromEmail !== undefined ? cleanStr(input.fromEmail, 254) : (existing?.from_email ?? null);
  const fromName = input.fromName !== undefined ? cleanStr(input.fromName, 120) : (existing?.from_name ?? null);
  const replyTo = input.replyTo !== undefined ? cleanStr(input.replyTo, 254) : (existing?.reply_to ?? null);

  // Q1: enforce the SSRF destination policy at SAVE time (fast feedback). The
  // same policy is re-applied authoritatively at every connect. A null host is
  // allowed (settings not yet filled in); a present host must pass.
  const willHaveCreds = Boolean(username);
  if (host) {
    const verdict = validateDestination({ host, port, security, hasCredentials: willHaveCreds });
    if (!verdict.ok) throw new DestinationPolicyError(verdict.reason);
  }

  let passwordCipher: string | null = existing?.password_cipher ?? null;
  if (input.clearPassword) {
    passwordCipher = null;
  } else if (input.password != null && input.password !== "") {
    if (!hasEncryptionKey()) {
      // Refuse to persist a password with no key. Nothing is written.
      throw new EncryptionKeyMissingError();
    }
    passwordCipher = encryptSecret(input.password, passwordAad(shopId));
  }

  await exec.run(
    `INSERT INTO email_setting
       (shop_id, host, port, security, username, password_cipher, from_email, from_name, reply_to, updated_at)
     VALUES ($1::uuid,$2,$3::int,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (shop_id) DO UPDATE SET
       host=EXCLUDED.host, port=EXCLUDED.port, security=EXCLUDED.security, username=EXCLUDED.username,
       password_cipher=EXCLUDED.password_cipher, from_email=EXCLUDED.from_email,
       from_name=EXCLUDED.from_name, reply_to=EXCLUDED.reply_to, updated_at=now()`,
    [shopId, host, port, security, username, passwordCipher, fromEmail, fromName, replyTo],
  );

  return loadEmailSettingsView(exec, shopId);
}

/** Internal: the full config incl. the decrypted password, for the provider
 * factory ONLY (never returned to a client). Returns null when not sendable. */
export async function loadSmtpConfig(exec: Exec, shopId: string): Promise<{
  host: string; port: number; security: SmtpSecurity; username: string | null;
  password: string | null; fromEmail: string; fromName: string | null; replyTo: string | null;
} | null> {
  const row = await readRow(exec, shopId);
  if (!row || !row.host || !row.port || !row.from_email) return null;
  let password: string | null = null;
  if (row.username) {
    if (!row.password_cipher || !hasEncryptionKey()) return null;
    try { password = decryptSecret(row.password_cipher, passwordAad(shopId)); } catch { return null; }
  }
  return {
    host: row.host, port: row.port, security: row.security, username: row.username,
    password, fromEmail: row.from_email, fromName: row.from_name, replyTo: row.reply_to,
  };
}

export const SEND_TEST_COOLDOWN_MS = 60_000;

/**
 * Q4(b) — DB-backed send-test cooldown (replaces the per-process in-memory Map,
 * so it holds across instances/restarts). Atomically stamps last_test_email_at
 * only when the cooldown has elapsed; returns whether this call may send.
 */
export async function claimSendTest(
  exec: Exec, shopId: string, opts: { now?: Date; cooldownMs?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const cooldownMs = opts.cooldownMs ?? SEND_TEST_COOLDOWN_MS;
  const n = await exec.run(
    `UPDATE email_setting SET last_test_email_at=$2::timestamptz
     WHERE shop_id=$1::uuid
       AND (last_test_email_at IS NULL OR last_test_email_at < $2::timestamptz - make_interval(secs => $3::double precision))`,
    [shopId, now.toISOString(), cooldownMs / 1000],
  );
  return n > 0;
}
