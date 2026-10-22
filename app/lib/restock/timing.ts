/**
 * Phase 12.1 Q2 — deterministic response-time floor for public restock routes.
 *
 * Several public routes do a different amount of work depending on whether a
 * subscription / token exists (subscribe: "created" vs "exists"; confirm /
 * unsubscribe: known vs unknown/used/expired token). To stop that difference
 * being an existence/timing oracle, every outcome is padded to a FIXED minimum
 * wall-clock time. The floor is deterministic (a plain timer, NO randomness).
 *
 * Residual: this masks the sub-millisecond difference between cheap outcomes; it
 * does not hide gross effects (it never shortens a response, and extreme DB
 * contention could still push a response past the floor). It intentionally adds
 * no outbound I/O — the confirmation email is sent asynchronously by the worker.
 */
export const RESPONSE_FLOOR_MS = 150;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until at least `floorMs` has elapsed since `startedMs`. */
export async function applyResponseFloor(startedMs: number, floorMs: number = RESPONSE_FLOOR_MS): Promise<void> {
  const remaining = floorMs - (Date.now() - startedMs);
  if (remaining > 0) await sleep(remaining);
}
