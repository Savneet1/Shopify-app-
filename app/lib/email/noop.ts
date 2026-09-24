import type { EmailMessage, EmailProvider, EmailSendResult } from "./provider";

/**
 * Default email provider: records intent but sends nothing. Keeps Phase 1 free
 * of any email dependency or external service.
 */
export class NoopEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    return { delivered: false, provider: "noop", id: undefined };
  }
}

export const email: EmailProvider = new NoopEmailProvider();
