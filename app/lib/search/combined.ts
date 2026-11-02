import type { Exec } from "~/lib/db/executor";

/**
 * Phase 13.5 — combined-listing display mode (per shop, one `app_setting` row,
 * key `combined_listing_mode`, JSONB string value). READ-ONLY sync (read_products
 * only): we never mutate combined listings, we only choose which role is hidden
 * from the storefront.
 *
 *   - "show_all"       → both parents and children appear (DEFAULT; the planner
 *                        adds NO extra WHERE, so the SQL is byte-identical to a
 *                        shop that never heard of combined listings).
 *   - "hide_children"  → CHILD products excluded everywhere (results, totals,
 *                        facet counts, predictive, suggestions, recommendations).
 *   - "hide_parents"   → PARENT products excluded everywhere.
 *
 * The hide is a HARD WHERE in the one shared planner (buildWhere) plus the
 * standalone doc queries (predictive/suggest/recommend), exactly like the
 * Phase 8 merch hide mechanism. Products with NULL combined_role (not part of
 * any combined listing) are NEVER hidden by this mode.
 */

export type CombinedMode = "show_all" | "hide_children" | "hide_parents";
export const DEFAULT_COMBINED_MODE: CombinedMode = "show_all";
const COMBINED_MODE_KEY = "combined_listing_mode";
const VALID_MODES: ReadonlySet<string> = new Set(["show_all", "hide_children", "hide_parents"]);

/** Pure: map a mode to the buildWhere `combinedHide` discriminant (undefined =
 * no exclusion). Any unrecognised value is treated as show_all (fail-open to the
 * byte-identical path — a bad setting never hides the whole catalog). */
export function combinedHideFor(mode: CombinedMode | string | null | undefined): "child" | "parent" | undefined {
  if (mode === "hide_children") return "child";
  if (mode === "hide_parents") return "parent";
  return undefined;
}

export function normalizeCombinedMode(value: unknown): CombinedMode {
  return typeof value === "string" && VALID_MODES.has(value) ? (value as CombinedMode) : DEFAULT_COMBINED_MODE;
}

/** Load the shop's combined-listing mode, defaulting to show_all when unset or
 * malformed. The value is stored as a JSONB string (to_jsonb(text)). */
export async function loadCombinedMode(exec: Exec, shopId: string): Promise<CombinedMode> {
  const rows = await exec.rows<{ value: unknown }>(
    `SELECT value FROM app_setting WHERE shop_id = $1::uuid AND key = $2`,
    [shopId, COMBINED_MODE_KEY],
  );
  const raw = rows[0]?.value;
  // value comes back already JSON-parsed (a string) from both exec paths.
  return normalizeCombinedMode(typeof raw === "string" ? raw : undefined);
}

/**
 * Phase 13b C4 — count products that HAVE a combined-listing role but whose
 * ACTIVE-version search doc still has a NULL role (i.e. the doc was built before
 * Phase 13 / migration 0018 and has not been re-projected). When a non-default
 * hide mode is set, these products would silently escape the hide, so the admin
 * surfaces this count and enqueues a backfill. Returns 0 when there is no active
 * version. RLS-scoped via the tenant exec.
 */
export async function countStaleCombinedDocs(exec: Exec, shopId: string): Promise<number> {
  const rows = await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM product p
     JOIN index_version iv ON iv.shop_id = p.shop_id AND iv.status = 'active'
     JOIN product_search_doc d ON d.shop_id = p.shop_id AND d.index_version_id = iv.id AND d.product_id = p.id
     WHERE p.shop_id = $1::uuid AND p.deleted_at IS NULL
       AND p.combined_role IS NOT NULL AND d.combined_role IS NULL`,
    [shopId],
  );
  return rows[0]?.n ?? 0;
}

/** Save (upsert) the shop's combined-listing mode. Validated+clamped to the
 * three allowed values; anything else becomes show_all. */
export async function saveCombinedMode(exec: Exec, shopId: string, mode: unknown): Promise<CombinedMode> {
  const next = normalizeCombinedMode(mode);
  await exec.run(
    `INSERT INTO app_setting (shop_id, key, value, created_at, updated_at)
     VALUES ($1::uuid, $2, to_jsonb($3::text), now(), now())
     ON CONFLICT (shop_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [shopId, COMBINED_MODE_KEY, next],
  );
  return next;
}
