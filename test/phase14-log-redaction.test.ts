import { describe, it, expect } from "vitest";
import pino from "pino";
import { REDACT, maskEmail } from "~/lib/logger.server";

/*
 * Phase 14.4h — log redaction. A logger built with the app's EXACT redaction
 * config must never emit SMTP passwords, tokens, hash peppers, API secrets or
 * raw email addresses. We log objects carrying those fields into a capture
 * stream and assert the secret values never appear.
 */

function capture(): { logger: pino.Logger; text: () => string } {
  const chunks: string[] = [];
  const stream = { write: (s: string) => { chunks.push(s); } };
  const logger = pino({ redact: REDACT }, stream as unknown as pino.DestinationStream);
  return { logger, text: () => chunks.join("") };
}

describe("Phase 14.4h — log redaction", () => {
  it("secret-bearing fields are censored, never emitted", () => {
    const c = capture();
    const secrets = {
      accessToken: "shpat_SECRET_TOKEN_VALUE",
      password: "smtp-PASSWORD-123",
      smtpPassword: "another-PW-xyz",
      pepper: "PEPPER_abcdef",
      apiSecret: "API_SECRET_zzz",
      signature: "HMAC_SIG_qqq",
      token: "confirm_TOKEN_999",
      smtp: { password: "nested-PW-777" },
      data: { token: "nested-TOKEN-555" },
    };
    c.logger.info(secrets, "sending");
    const out = c.text();
    for (const v of ["shpat_SECRET_TOKEN_VALUE", "smtp-PASSWORD-123", "another-PW-xyz",
      "PEPPER_abcdef", "API_SECRET_zzz", "HMAC_SIG_qqq", "confirm_TOKEN_999",
      "nested-PW-777", "nested-TOKEN-555"]) {
      expect(out, `secret leaked: ${v}`).not.toContain(v);
    }
    expect(out).toContain("[redacted]");
  });

  it("raw email fields are redacted by default", () => {
    const c = capture();
    c.logger.info({ email: "jane.doe@example.com", sub: { email: "bob@shop.co" } }, "opt-in");
    const out = c.text();
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).not.toContain("bob@shop.co");
  });

  it("maskEmail hides the local part and full domain", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@e***.com");
    expect(maskEmail("a@b.io")).toBe("a***@b***.io");
    expect(maskEmail("not-an-email")).toBe("[redacted]");
    expect(maskEmail("")).toBe("[redacted]");
    // the masked form never contains the original local part or bare domain
    expect(maskEmail("secretuser@private-domain.com")).not.toContain("secretuser");
    expect(maskEmail("secretuser@private-domain.com")).not.toContain("private-domain");
  });
});
