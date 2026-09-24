import { config } from "dotenv";

// Load .env for local runs (CI injects env directly).
config();

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
