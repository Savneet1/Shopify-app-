# Phase 14 — Security hardening & dependency audit

Base `2253b9a`. No new scope, dependency, extension or SECURITY DEFINER function.
This document records the 14.4 hardening surface and the 14.5 dependency audit.

## 14.4 Hardening summary (each with tests)

| Item | What | Test |
|---|---|---|
| a | Default `statement_timeout` (SET LOCAL, 2 s) on every PUBLIC proxy query path via `withShopExecTimed`; a pathological query is cancelled (SQLSTATE 57014) and the proxy returns a native fallback, never a 5xx. Admin/sync/build paths keep the longer tx bound. | `phase14-statement-timeout` (real-PG cancel + wiring) |
| b | Rate-limit + body-size audit (below). No gaps. | `phase14-security-headers` (rate-limit + body-cap asserts) |
| c | Authorization audit: every admin route calls `authenticate.admin`, every proxy route uses `handleProxy`, every webhook route verifies HMAC; the rest allowlisted. | `phase14-authz-audit` (mutation-tested) |
| d | RLS completeness: every public table with `shop_id` has RLS enabled+forced + a policy; grants are app_runtime/app_owner only. | `phase14-rls-completeness` (+ `phase11_1-definer` for SECURITY DEFINER) |
| e | Egress audit: the only outbound network primitives in `app/` are the Shopify Admin API client and the SMTP module; anything else fails the test. | `phase14-egress-audit` |
| f | Security headers: admin documents get Shopify CSP `frame-ancestors` + `X-Content-Type-Options: nosniff` + `Referrer-Policy`; proxy JSON gets `nosniff` + `Cache-Control: no-store`. | `phase14-security-headers` |
| g | Error hygiene: the proxy catch returns a generic body (no stack/SQL/paths); only `err.message` is logged, never the stack; `/healthz` degrades to 503 without detail. | `phase14-security-headers` |
| h | Log redaction: tokens, SMTP passwords, peppers, API secrets and raw emails are redacted by the pino config; `maskEmail` masks the local part + domain. | `phase14-log-redaction` |
| i | `/healthz` (DB connectivity only, no auth, no tenant data) + a slow-operation WARN (`maybeLogSlow`) with the shop id hashed and NO SQL/params. | `phase14-security-headers`, route registered + allowlisted |

### 14.4b — rate-limit & body-size, per public endpoint

All 12 App Proxy routes go through `handleProxy`, which (1) verifies the Shopify
proxy signature, (2) applies the per-shop `TokenBucketLimiter` (429 + `Retry-After`
when exceeded), and (3) catches all errors into a native-fallback 200.

| Endpoint | Input | Rate-limited | Body cap |
|---|---|---|---|
| proxy/products, predictive, suggest | query params | yes (handleProxy) | n/a (no body) |
| proxy/recommendations, bundles, countdown, preorder, back-in-stock (GET) | query params | yes | n/a |
| proxy/merch-event, rec-event, bundle-event | query params only (counter beacons) | yes | n/a (no `request.json/text/formData`) |
| proxy/analytics-event (POST) | JSON batch | yes | **16 KB** hard cap + **≤20** events, rejected before parse/SQL |
| proxy/back-in-stock (POST) | JSON | yes | **4 KB** hard cap, rejected before parse/SQL |

JSON-depth: the byte cap bounds parse depth (a 16 KB body cannot nest deeply
enough to exhaust the stack); each field is validated before any SQL. **No gaps
found; no fix required.**

## 14.5 Dependency audit (`npm audit --omit=dev` on 2253b9a)

7 production advisories. Classification against THIS app's code paths:

| Package | Sev | Advisory | Reachable here? | Action |
|---|---|---|---|---|
| **body-parser** 1.20.8 | high | DoS via trailing bytes after a compressed body | Only via `@react-router/serve` → `express` when running `npm start`. The app's embedded/admin requests are small and come through Shopify; the proxy JSON endpoints cap bodies at 4–16 KB and do their own parsing (not body-parser). Low practical reachability, but trivially fixable. | **Fixed**: override `body-parser@1.20.9` (semver-compatible). |
| **qs** 6.16.0 | moderate | `qs.stringify` arrayFormat 'comma' DoS on a non-callable `toString` | The app does not call `qs.stringify` with `arrayFormat:'comma'`; `qs` is a transitive express dep used for query parsing. Not reachable from app code. | **Fixed**: override `qs@6.17.1` (semver-compatible). |
| **zod** 3.x | high | memory exhaustion validating oversized constrained collections | `zod` validates small, fixed-shape admin/settings inputs here (never attacker-supplied giant collections; proxy inputs are size-capped and validated without zod). Low reachability. Fix is **zod 4 (major)**. | **Proposed, NOT applied** (needs approval) — see below. |
| **prisma / @prisma/config / deepmerge-ts** | high | deepmerge-ts stack exhaustion merging recursive graphs (used by Prisma CLI config) | `deepmerge-ts` is pulled by the **Prisma CLI/config** (build/migration tooling), not the runtime query path. Not reachable at request time. Fix is **prisma 7 (major)**. | **Proposed, NOT applied** (needs approval). |
| **@shopify/shopify-app-session-storage-prisma** | high | via prisma | Session storage adapter; fix shown by npm is a **downgrade to 6.0.9** — needs verification that it is compatible with `@shopify/shopify-app-react-router` v3. | **Proposed, NOT applied**; verify compatibility first. |

### Semver-compatible fixes applied
`package.json` `overrides`: `body-parser@1.20.9`, `qs@6.17.1`. The full suite
passes with the overrides in place (see PHASE14_REPORT STATUS line).

### Major-upgrade plan (requires explicit approval — NOT applied)
1. **zod 3 → 4**: breaking API changes (error formatting, some method renames).
   Risk: our zod schemas are small; migration is mechanical but touches every
   validation module. Recommend a dedicated branch + full suite + manual review.
2. **prisma 6 → 7**: major; client API + config changes, and our
   exec-abstraction/RLS transaction code (`withShop`) must be re-verified against
   the Live-Prisma CI workflow. Recommend doing this with the session-storage
   adapter bump together.
3. **@shopify/shopify-app-session-storage-prisma**: verify the npm-suggested
   version against the installed `@shopify/shopify-app-react-router` v3 before
   changing; a blind downgrade risks breaking OAuth/session persistence.

A **non-blocking** `npm audit --omit=dev` summary step is added to the existing
workflow (informational only; does not fail the build).
