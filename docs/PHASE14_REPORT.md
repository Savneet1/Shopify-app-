# Phase 14 Report — Performance, optimization & security hardening

**Base:** `2253b9a` (Phase 13b) → fast-forward, existing history.
**No new** scope, npm dependency (two `overrides` only), PostgreSQL extension or
SECURITY DEFINER function. **New migrations:** `0020` (autovacuum stats),
`0021` (gid index) — additive + idempotent. Design in `docs/PHASE14.md`;
benchmark results in `docs/PHASE14_BENCH.md`; security + dependency detail in
`docs/PHASE14_SECURITY.md`.

## Decisions
- **Benchmark harness** (`scripts/bench/`, `npm run bench`) loads a deterministic
  synthetic catalog through the REAL sync→index path and times the public query
  paths as `app_runtime` with RLS on. All sandbox numbers are labelled
  **indicative, single shared node, not production**; the manual
  `benchmark.yml` workflow exists to get hosted-hardware figures.
- **Optimize only what measurements showed.** Two safe, additive, byte-identical
  fixes: migration **0020** (fresh planner stats after a bulk build — stale
  stats were forcing seq-scans) and migration **0021** (`psd_gid_btree`, killing
  a 99 999-row seq scan in the recommendation seed lookup that is shared by five
  public gid-lookup paths). The informational phase-3 index check is now a real
  assertion (`phase14-index-usage.test.ts`).
- **Security hardening** (14.4) landed with a test each; three guards
  (authorization, egress, RLS-completeness) were **mutation-tested** (break →
  the test fails → restore).
- **Dependency audit** (14.5): applied the semver-compatible `body-parser` +
  `qs` overrides (two advisories cleared); the remaining five are prisma-7 /
  zod-4 majors — assessed and proposed, **not applied** per the phase rules.
- **Analytics rollup** (14.6c): measurement showed 90-day reports miss a
  sensible bound at 100k events/day (2–4.5 s), so the bounded daily rollup was
  implemented (byte-identical, long-range-gated, per-query reports stay on raw).

## Deviations
- **Performance targets (F14) are NOT met on the sandbox** (predictive p95
  1 500 ms vs 60 ms, search+facets 930 ms vs 250 ms, typo +633 ms vs +30 ms at
  100k). These are reported with the measured numbers and the reason (shared-CPU
  node + algorithmic candidate/aggregate scans), **not** tuned away. At 10k,
  search+facets already PASSES (88 ms ≤ 150). Whether the targets are met on
  production hardware is **Requires-Verification**.
- The recommendation candidate scan and the suggestion/facet aggregates are
  algorithmic (scan the visible result set); meeting their targets needs a
  precomputed candidate/cache layer, which the rules allow only with a proven
  tenant/locale/context-safe design + tests — proposed, not built this phase.
- `getActiveVersion` per-request dedupe (a few statements) was deferred as
  higher-risk-than-reward against hot call sites.

## Limitations
- All latency figures are sandbox-indicative. Relative comparisons, statement
  counts and EXPLAIN plans are the trustworthy outputs here.
- The analytics rollup serves only the event_type/surface reports; per-query
  reports (top/zero-result/no-click queries) stay on raw by design (the rollup
  stores no query text).

## Requires-Verification
- F14 latency targets on hosted hardware (run `benchmark.yml` at 10k + 100k).
- 5 000-update webhook-burst drain time at 100k on hosted hardware.
- **Live-Prisma parity: PENDING** your GitHub Actions run (the Prisma-integration
  suite self-skips in the offline sandbox — 13 skipped here).
- The prisma-7 / zod-4 major upgrades (exploitability + plan in
  `PHASE14_SECURITY.md`) await your explicit approval.

## Verification
- `npm test`: **806 passed | 13 skipped**. `npm run test:ci-parity` (scrubbed
  env, no `.env`): **806 passed | 13 skipped** — **identical**. Up from the
  Phase 13b baseline of 761/13; **no prior test weakened or removed**.
- Gates green: `typecheck`, `build`, `worker:build`.
- `npm audit --omit=dev` after the overrides: the `body-parser` + `qs`
  advisories are gone; 5 high remain (the documented majors).
- Benchmark run at **10k and 100k**; JSON in `scripts/bench/out/`, summary +
  EXPLAIN in `docs/PHASE14_BENCH.md`.
- 3 new guards mutation-tested (authorization, egress, RLS-completeness).

## Deliverables
- Code, migrations `0020`/`0021`, `docs/PHASE14.md`, `docs/PHASE14_BENCH.md`,
  `docs/PHASE14_SECURITY.md`, this report, updated `docs/FEATURE_MATRIX.md` (F14
  with MEASURED numbers + PASS/FAIL) and `README`.
- Git format-patch on top of `2253b9a` **and** a full `.tgz` (tracked files
  only, incl `.git`, no `node_modules`/`.env`), both verified to apply /
  reconstruct the committed tree and pass `git fsck`.

**STATUS:** Phase 14 complete and committed on top of `2253b9a`. No performance
target is claimed as met (sandbox numbers are indicative; hosted verification
pending). Live-Prisma parity PENDING your workflow run. Awaiting explicit
approval before Phase 15.
