/**
 * Provider-agnostic email abstraction.
 *
 * Phase 1 requirement: define the abstraction WITHOUT forcing a paid email
 * SaaS and without adding unnecessary dependencies. The default implementation
 * is a no-op. An SMTP/Nodemailer implementation (or any provider) can be added
 * later behind this interface, when back-in-stock email is built (Phase 12).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export interface EmailSendResult {
  delivered: boolean;
  provider: string;
  id?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
