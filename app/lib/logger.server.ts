import pino from "pino";

/**
 * Structured logger. Redacts common secret-bearing fields so tokens/HMAC never
 * land in logs (security requirement: no improper logging of secrets).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "accessToken",
      "access_token",
      "*.accessToken",
      "req.headers.authorization",
      'req.headers["x-shopify-hmac-sha256"]',
      "hmac",
      "password",
    ],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
