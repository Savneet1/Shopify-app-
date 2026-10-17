/**
 * Phase 12 — typed email errors. The restock notifier uses the distinction to
 * decide whether to RETRY (transient) or give up and mark the subscription
 * bounced (permanent).
 */

/** A permanent failure: the server replied 5xx, or the message/address was
 * rejected as invalid. NOT retried. */
export class PermanentEmailError extends Error {
  readonly permanent = true;
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "PermanentEmailError";
    this.code = code;
  }
}

/** A transient failure: the server replied 4xx, or a network/timeout error
 * occurred. Eligible for bounded retry. */
export class TransientEmailError extends Error {
  readonly permanent = false;
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TransientEmailError";
    this.code = code;
  }
}

/** Header-injection / invalid-address / size-limit rejections before any
 * network I/O. Treated as permanent (a retry cannot fix malformed input). */
export class EmailValidationError extends PermanentEmailError {
  constructor(message: string) {
    super(message);
    this.name = "EmailValidationError";
  }
}

export function isPermanentEmailError(err: unknown): boolean {
  return err instanceof PermanentEmailError;
}
