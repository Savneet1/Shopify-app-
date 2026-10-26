import { describe, it, expect } from "vitest";
import { parseWorkflowEnv } from "../scripts/ci-parity.mjs";

/*
 * Phase 12.2 R3 — drift guard. The `test:ci-parity` harness runs the suite with
 * ONLY the variables the live-prisma-check workflow provides. If the app grows a
 * required env var but the workflow's env block does not, CI (and this guard)
 * must fail — so the two cannot silently drift. In particular EMAIL_ENCRYPTION_KEY
 * MUST be present after the Phase 12 CI failure.
 */
describe("CI parity — workflow env provides every required variable", () => {
  const env = parseWorkflowEnv() as Record<string, string | undefined>;
  const REQUIRED = [
    "DATABASE_URL", "DIRECT_DATABASE_URL", "TEST_DATABASE_URL", "TEST_DIRECT_DATABASE_URL",
    "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES",
    "EMAIL_ENCRYPTION_KEY",
  ];
  for (const key of REQUIRED) {
    it(`workflow env defines ${key}`, () => {
      expect(env[key], `${key} missing from live-prisma-check.yml env block`).toBeTruthy();
    });
  }
  it("EMAIL_ENCRYPTION_KEY is a 64-hex (32-byte) value", () => {
    expect(/^[0-9a-fA-F]{64}$/.test(String(env.EMAIL_ENCRYPTION_KEY ?? ""))).toBe(true);
  });
});
