import { config } from "dotenv";

// Load .env for LOCAL runs (CI injects env directly). `npm run test:ci-parity`
// sets CI_PARITY=1 to skip this, reproducing CI where no .env exists — so a test
// can never silently depend on a developer's gitignored .env (Phase 12.2 R1).
if (!process.env.CI_PARITY) {
  config();
}

// Safety: tests must target the TEST databases, never dev/prod.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DIRECT_DATABASE_URL) {
  process.env.DIRECT_DATABASE_URL = process.env.TEST_DIRECT_DATABASE_URL;
}

// A predictable secret for HMAC unit tests.
process.env.SHOPIFY_API_SECRET =
  process.env.SHOPIFY_API_SECRET || "test_api_secret_phase1";

// R1(a): a fixed, TEST-ONLY AES key so the suite is HERMETIC — it must not
// depend on a developer's .env (the Phase 12 CI failure). Only set when unset,
// and only under NODE_ENV=test, so it can never leak into a real environment.
// This is a throwaway 32-byte (64-hex) value, NOT a production secret.
if (process.env.NODE_ENV === "test" && !process.env.EMAIL_ENCRYPTION_KEY) {
  process.env.EMAIL_ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
}
