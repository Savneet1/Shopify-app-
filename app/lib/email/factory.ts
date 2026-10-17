import type { Exec } from "~/lib/db/executor";
import type { EmailProvider } from "./provider";
import { NoopEmailProvider } from "./noop";
import { SmtpEmailProvider } from "./smtp";
import { loadSmtpConfig } from "./settings";

/**
 * Phase 12.1 — provider selection. Returns a real SMTP provider when the shop
 * has valid, sendable settings; otherwise the NoopEmailProvider (the default,
 * "email not configured": subscriptions are still collected, nothing is sent).
 * `configured` lets callers record WHY nothing was sent without leaking config.
 */
export async function getEmailProvider(
  exec: Exec, shopId: string,
): Promise<{ provider: EmailProvider; configured: boolean }> {
  const cfg = await loadSmtpConfig(exec, shopId);
  if (!cfg) return { provider: new NoopEmailProvider(), configured: false };
  return {
    provider: new SmtpEmailProvider({
      host: cfg.host,
      port: cfg.port,
      security: cfg.security,
      username: cfg.username,
      password: cfg.password,
      fromEmail: cfg.fromEmail,
      fromName: cfg.fromName,
      replyTo: cfg.replyTo,
    }),
    configured: true,
  };
}
