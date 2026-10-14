import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { validateBatch, type CleanEvent } from "./events";
import { loadAnalyticsSettings } from "./settings";

/**
 * Phase 11.3 — analytics ingestion store. Validates a batch, respects the
 * shop's analytics_mode, and inserts the accepted events with a SERVER-stamped
 * occurred_at (the client timestamp is never used). The current month's
 * partition is ensured to exist (owner-owned definer function) before the
 * insert, so there is no DEFAULT partition and inserts never fail on a missing
 * partition. Never throws on hostile input — invalid events are dropped.
 */

export interface IngestResult {
  accepted: number;
  rejected: number;
  stored: number;
}

/**
 * Ingest a raw batch for a shop under its tenant context (RLS). `now` is
 * injectable for tests; production passes the real clock, and the DB also
 * stamps occurred_at = the same value. Mode gating: off → store nothing
 * (accepted=0); anonymous → strip session ids; consented_sessions → keep the
 * validated session id the storefront supplied.
 */
export async function ingestEvents(
  exec: Exec, shopId: string, rawEvents: unknown, now: Date = new Date(),
): Promise<IngestResult> {
  const settings = await loadAnalyticsSettings(exec, shopId);
  if (settings.mode === "off") {
    // Count how many would-be events arrived (for the honest {rejected}), but
    // store nothing and keep no session ids.
    const n = Array.isArray(rawEvents) ? rawEvents.length : 0;
    return { accepted: 0, rejected: n, stored: 0 };
  }
  const sessionAllowed = settings.mode === "consented_sessions";
  const { clean, rejected } = validateBatch(rawEvents, { sessionAllowed });
  if (clean.length === 0) return { accepted: 0, rejected, stored: 0 };

  // Ensure the current month's partition exists (idempotent; owner definer).
  await exec.run(`SELECT app_ensure_analytics_partition($1::timestamptz)`, [now.toISOString()]);

  const stored = await insertEvents(exec, shopId, clean, now);
  return { accepted: stored, rejected, stored };
}

/** Insert clean events in one multi-row statement. occurred_at = server `now`. */
export async function insertEvents(
  exec: Exec, shopId: string, events: CleanEvent[], now: Date,
): Promise<number> {
  if (events.length === 0) return 0;
  const pb = new Params();
  const sid = pb.add(shopId);
  const ts = pb.add(now.toISOString());
  const tuples: string[] = [];
  for (const e of events) {
    tuples.push(
      `(${sid}::uuid, ${pb.add(e.eventType)}, ${ts}::timestamptz, ${pb.add(e.sessionId)},
        ${pb.add(e.queryNorm)}, ${pb.add(e.queryRedacted)}, ${pb.add(e.resultCount)}::int,
        ${pb.add(e.productGid)}, ${pb.add(e.position)}::int, ${pb.add(e.experimentId)}::uuid,
        ${pb.add(e.variant)}, ${pb.add(e.surface)}, ${pb.add(JSON.stringify(e.properties))}::jsonb)`,
    );
  }
  return exec.run(
    `INSERT INTO analytics_event
       (shop_id, event_type, occurred_at, session_id, query_norm, query_redacted,
        result_count, product_gid, position, experiment_id, variant, surface, properties)
     VALUES ${tuples.join(", ")}`,
    pb.values,
  );
}

/**
 * Delete ALL analytics rows for a shop (admin "Delete all analytics data" and
 * shop/redact). Rows are RLS-scoped; rollups too. Returns rows deleted.
 */
export async function deleteAllAnalytics(exec: Exec, shopId: string): Promise<number> {
  const a = await exec.run(`DELETE FROM analytics_event WHERE shop_id=$1::uuid`, [shopId]);
  const b = await exec.run(`DELETE FROM analytics_rollup_daily WHERE shop_id=$1::uuid`, [shopId]);
  return a + b;
}
