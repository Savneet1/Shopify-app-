/**
 * Per-shop rate limiting for the storefront App Proxy endpoints (Phase 3.6),
 * WITHOUT Redis (global rule) and without any external service.
 *
 * Implementation: an in-process token bucket keyed by shop domain. Each shop
 * gets `capacity` tokens that refill at `refillPerSec`; a request costs one
 * token. This is intentionally simple and dependency-free.
 *
 * DOCUMENTED MULTI-INSTANCE LIMITATION: the bucket lives in ONE process's
 * memory. If the app is scaled horizontally to N instances behind a load
 * balancer, each instance enforces the limit independently, so the effective
 * global limit is up to N × the per-instance limit. This is an accepted
 * trade-off for Phase 3 (abuse protection / accidental floods, not billing-grade
 * quota). A future phase can move this to a Postgres-backed counter (a single
 * shared row per shop with an atomic UPDATE ... RETURNING window check) if a
 * strict global limit is required — noted in docs/PHASE3.md. No behaviour here
 * depends on a specific deployment topology.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(
    private capacity = Number(process.env.SEARCH_RL_CAPACITY || 30),
    private refillPerSec = Number(process.env.SEARCH_RL_REFILL_PER_SEC || 10),
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    this.maybeSweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    // Refill based on elapsed time.
    const elapsedSec = Math.max(0, (now - b.updatedAt) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.updatedAt = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { allowed: true, retryAfterMs: 0 };
    }
    this.buckets.set(key, b);
    const deficit = 1 - b.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSec) * 1000);
    return { allowed: false, retryAfterMs };
  }

  /** Drop idle buckets occasionally so the map cannot grow unbounded. */
  private maybeSweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const idleCutoff = now - 5 * 60_000;
    for (const [k, b] of this.buckets) {
      if (b.updatedAt < idleCutoff) this.buckets.delete(k);
    }
  }
}

// Shared singleton for the proxy routes.
export const storefrontLimiter = new TokenBucketLimiter();
