import type { Exec } from "~/lib/db/executor";
import { weightedTsvSql } from "~/lib/search/config";

/**
 * Versioned search index engine.
 *
 * Lifecycle: building -> validating -> validated -> active (prior active ->
 * superseded); failed; rolled_back. A partial unique index enforces at most one
 * active version per shop.
 *
 * Phase 2.1 hardening:
 *  - `snapshot_at` records when buildDocs read the catalog. Activation locks the
 *    shop's index rows, CATCHES UP every product changed/deleted since the
 *    snapshot into the version being activated, then flips status — so a webhook
 *    applied between build and activate survives (no lost update / build race).
 *  - Validation compares the index against the freshly-synced snapshot product
 *    count (passed in), not just docs-vs-DB.
 *  - Explicit ::uuid/::timestamptz casts for the Prisma raw-SQL path.
 *
 * Still Phase 2 scope: builds/versions search DOCUMENTS only (no FTS/ranking/
 * typo/synonyms — Phase 3+).
 */

export type IndexStatus =
  | "building"
  | "validating"
  | "validated"
  | "active"
  | "failed"
  | "superseded"
  | "rolled_back";

export interface IndexVersionRow {
  id: string;
  version: number;
  status: IndexStatus;
  source: string;
  doc_count: number;
  expected_count: number | null;
}

// Shared document projection. `$1` = shopId, `$2` = index version id; the WHERE
// fragment may use `$3`. Kept in one place so full build, single-product refresh
// and activation catch-up all produce identical documents — including the
// weighted tsvector (Phase 3), so build / in-place refresh / activation catch-up
// never diverge in what is searchable.
//
// Weighting (config in app/lib/search/config.ts):
//   A = title;  B = vendor, product type, SKU + barcode;
//   C = tags, collection titles, variant titles;  D = description.
// The whole vector is accent-folded via immutable_unaccent() before to_tsvector.
function docInsertSql(whereFrag: string): string {
  const tsv = weightedTsvSql(
    /* A */ "p.title",
    /* B */ "concat_ws(' ', p.vendor, p.product_type, v.variant_sku_text)",
    /* C */ "concat_ws(' ', pt.tags_text, v.variant_title_text, c.collection_text)",
    /* D */ "p.description",
  );
  return `
    WITH built AS (
      SELECT
        p.shop_id, p.id AS product_id, p.shopify_product_gid,
        p.title AS title, p.status AS status,
        (p.online_store_url IS NOT NULL) AS published,
        COALESCE(v.any_available, false) AS available,
        v.variant_sku_text AS sku_text,
        ${tsv} AS tsv,
        jsonb_build_object(
          'title', p.title, 'description', p.description, 'vendor', p.vendor,
          'productType', p.product_type, 'handle', p.handle, 'status', p.status,
          'tags', p.tags, 'options', p.options,
          'totalInventory', p.total_inventory, 'tracksInventory', p.tracks_inventory,
          -- Result-card fields (Phase 3).
          'image', jsonb_build_object('url', p.featured_image_url, 'alt', p.featured_image_alt),
          'url', p.online_store_url,
          'published', (p.online_store_url IS NOT NULL),
          'available', COALESCE(v.any_available, false),
          'priceMin', v.price_min, 'priceMax', v.price_max,
          'compareAtMin', v.compare_min, 'compareAtMax', v.compare_max,
          'variants', COALESCE(v.variants, '[]'::jsonb),
          'collections', COALESCE(c.collections, '[]'::jsonb)
        ) AS doc,
        btrim(concat_ws(' ',
          p.title, p.description, p.vendor, p.product_type,
          pt.tags_text, v.variant_text, c.collection_text
        )) AS search_text
      FROM product p
      LEFT JOIN LATERAL (
        SELECT string_agg(t, ' ') AS tags_text
        FROM jsonb_array_elements_text(p.tags) t
      ) pt ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          jsonb_agg(jsonb_build_object('sku', vv.sku, 'barcode', vv.barcode,
            'title', vv.title, 'price', vv.price, 'compareAtPrice', vv.compare_at_price,
            'availableForSale', vv.available_for_sale) ORDER BY vv.position NULLS LAST) AS variants,
          -- Separate streams so tsvector weighting and the sku_text trigram
          -- column stay distinct (B: sku/barcode; C: variant titles).
          string_agg(concat_ws(' ', vv.sku, vv.barcode), ' ') AS variant_sku_text,
          string_agg(vv.title, ' ') AS variant_title_text,
          string_agg(concat_ws(' ', vv.sku, vv.barcode, vv.title), ' ') AS variant_text,
          min(vv.price)  AS price_min,   max(vv.price)  AS price_max,
          min(vv.compare_at_price) AS compare_min, max(vv.compare_at_price) AS compare_max,
          bool_or(COALESCE(vv.available_for_sale, false)) AS any_available
        FROM variant vv WHERE vv.product_id = p.id AND vv.deleted_at IS NULL
      ) v ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(col.title) AS collections, string_agg(col.title, ' ') AS collection_text
        FROM product_collection pc JOIN collection col ON col.id = pc.collection_id AND col.deleted_at IS NULL
        WHERE pc.product_id = p.id
      ) c ON TRUE
      WHERE ${whereFrag}
    )
    INSERT INTO product_search_doc
      (shop_id, index_version_id, product_id, shopify_product_gid, doc, search_text,
       content_hash, tsv, title, sku_text, status, published, available)
    SELECT shop_id, $2::uuid, product_id, shopify_product_gid, doc, COALESCE(search_text,''),
       md5(doc::text), tsv, title, sku_text, status, published, available
    FROM built
    ON CONFLICT (shop_id, index_version_id, product_id) DO UPDATE
      SET doc=EXCLUDED.doc, search_text=EXCLUDED.search_text, content_hash=EXCLUDED.content_hash,
          tsv=EXCLUDED.tsv, title=EXCLUDED.title, sku_text=EXCLUDED.sku_text,
          status=EXCLUDED.status, published=EXCLUDED.published, available=EXCLUDED.available`;
}

export async function createIndexVersion(
  exec: Exec,
  shopId: string,
  source: "full" | "incremental" = "full",
  expectedCount: number | null = null,
): Promise<IndexVersionRow> {
  const rows = await exec.rows<IndexVersionRow>(
    `INSERT INTO index_version (shop_id, version, status, source, expected_count, built_at)
     VALUES ($1::uuid,
       (SELECT COALESCE(MAX(version),0)+1 FROM index_version WHERE shop_id=$1::uuid),
       'building', $2, $3::int, NULL)
     RETURNING id, version, status, source, doc_count, expected_count`,
    [shopId, source, expectedCount],
  );
  return rows[0];
}

export async function buildDocs(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
): Promise<number> {
  // Mark the snapshot boundary BEFORE reading the catalog.
  await exec.run(
    `UPDATE index_version SET snapshot_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, indexVersionId],
  );
  await exec.run(docInsertSql(`p.shop_id=$1::uuid AND p.deleted_at IS NULL`), [
    shopId,
    indexVersionId,
  ]);
  const counted = await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
    [shopId, indexVersionId],
  );
  const docCount = counted[0].n;
  await exec.run(
    `UPDATE index_version SET doc_count=$3::int, status='validating', built_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, indexVersionId, docCount],
  );
  return docCount;
}

export interface ValidationResult {
  pass: boolean;
  dbCount: number;
  indexedCount: number;
  failedCount: number;
  expectedCount: number | null;
}

/**
 * Validate a built version. Integrity requires indexed_count == the number of
 * live products AND (when a snapshot product count is provided) == that
 * expected snapshot count — so a sync that silently dropped products fails
 * validation instead of validating a short index against a short DB.
 */
export async function validateIndexVersion(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
  expectedProductCount: number | null = null,
): Promise<ValidationResult> {
  const dbCount = (
    await exec.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL`,
      [shopId],
    )
  )[0].n;
  const indexedCount = (
    await exec.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
      [shopId, indexVersionId],
    )
  )[0].n;

  const expected = expectedProductCount;
  // Integrity: every live product has exactly one doc. Not-short: the live
  // count did not fall below the snapshot count (a dropped-product sync fails).
  // A HIGHER live count than the snapshot is fine — webhooks may add products
  // concurrently with a full sync.
  const matchesDb = indexedCount === dbCount;
  const notShort = expected == null ? true : dbCount >= expected;
  const pass = matchesDb && notShort;
  const failedCount = matchesDb
    ? (expected == null ? 0 : Math.max(expected - dbCount, 0))
    : Math.max(dbCount - indexedCount, 0);

  await exec.run(
    `INSERT INTO index_consistency_check
      (shop_id, index_version_id, shopify_count, db_count, indexed_count, failed_count, status, details)
     VALUES ($1::uuid,$2::uuid,$3::int,$4::int,$5::int,$6::int,$7,$8::jsonb)`,
    [
      shopId,
      indexVersionId,
      expected,
      dbCount,
      indexedCount,
      failedCount,
      pass ? "pass" : "fail",
      JSON.stringify({ matchesDb, notShort }),
    ],
  );

  if (pass) {
    await exec.run(
      `UPDATE index_version SET status='validated', validated_at=now(), updated_at=now()
       WHERE shop_id=$1::uuid AND id=$2::uuid AND status='validating'`,
      [shopId, indexVersionId],
    );
  } else {
    await exec.run(
      `UPDATE index_version SET status='failed', failed_at=now(), error=$3, updated_at=now()
       WHERE shop_id=$1::uuid AND id=$2::uuid`,
      [shopId, indexVersionId, `validation failed: indexed ${indexedCount}, db ${dbCount}, expected ${expected ?? "n/a"}`],
    );
  }
  return { pass, dbCount, indexedCount, failedCount, expectedCount: expected };
}

/**
 * Atomically activate a validated version. Locks the shop's index rows, catches
 * up every product changed/deleted since the build snapshot into this version,
 * then demotes the current active version and promotes this one. Caller wraps in
 * a single withShop transaction. Throws if the target is not validated.
 */
export async function activateIndexVersion(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
): Promise<void> {
  // Serialize activations for this shop.
  await exec.rows(
    `SELECT id FROM index_version WHERE shop_id=$1::uuid FOR UPDATE`,
    [shopId],
  );

  const target = (
    await exec.rows<{ status: string; snapshot_at: string | null }>(
      `SELECT status, snapshot_at FROM index_version WHERE shop_id=$1::uuid AND id=$2::uuid`,
      [shopId, indexVersionId],
    )
  )[0];
  if (!target || target.status !== "validated") {
    throw new Error(
      `activateIndexVersion: version ${indexVersionId} is not in 'validated' state`,
    );
  }

  // Catch up changes committed after the build snapshot. A safety margin
  // (snapshot_at minus a few seconds) avoids missing a change whose commit
  // timestamp is marginally before the snapshot marker due to clock/commit
  // ordering; catch-up upserts are idempotent, so re-applying a few extra rows
  // is harmless. Configurable via CATCHUP_MARGIN_SECONDS (default 5).
  if (target.snapshot_at) {
    const margin = Number(process.env.CATCHUP_MARGIN_SECONDS || 5);
    const boundary = `($3::timestamptz - ($4 || ' seconds')::interval)`;
    await exec.run(
      docInsertSql(`p.shop_id=$1::uuid AND p.deleted_at IS NULL AND p.updated_at >= ${boundary}`),
      [shopId, indexVersionId, target.snapshot_at, String(margin)],
    );
    await exec.run(
      `DELETE FROM product_search_doc d
       USING product p
       WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid
         AND p.id = d.product_id AND p.deleted_at IS NOT NULL
         AND p.updated_at >= ($3::timestamptz - ($4 || ' seconds')::interval)`,
      [shopId, indexVersionId, target.snapshot_at, String(margin)],
    );
    await exec.run(
      `UPDATE index_version SET doc_count=(
         SELECT count(*)::int FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
       ), updated_at=now() WHERE shop_id=$1::uuid AND id=$2::uuid`,
      [shopId, indexVersionId],
    );
  }

  await exec.run(
    `UPDATE index_version SET status='superseded', superseded_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND status='active'`,
    [shopId],
  );
  const promoted = await exec.run(
    `UPDATE index_version SET status='active', activated_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid AND status='validated'`,
    [shopId, indexVersionId],
  );
  if (promoted !== 1) {
    throw new Error(`activateIndexVersion: failed to promote ${indexVersionId}`);
  }
}

export async function rollbackToVersion(
  exec: Exec,
  shopId: string,
  targetVersionId: string,
): Promise<void> {
  await exec.rows(`SELECT id FROM index_version WHERE shop_id=$1::uuid FOR UPDATE`, [shopId]);
  const target = await exec.rows<{ id: string }>(
    `SELECT id FROM index_version
     WHERE shop_id=$1::uuid AND id=$2::uuid AND status IN ('superseded','validated','rolled_back')`,
    [shopId, targetVersionId],
  );
  if (!target[0]) {
    throw new Error(`rollbackToVersion: ${targetVersionId} is not rollback-eligible`);
  }
  await exec.run(
    `UPDATE index_version SET status='rolled_back', updated_at=now()
     WHERE shop_id=$1::uuid AND status='active'`,
    [shopId],
  );
  await exec.run(
    `UPDATE index_version SET status='active', activated_at=now(), updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, targetVersionId],
  );
}

export async function getActiveVersion(
  exec: Exec,
  shopId: string,
): Promise<IndexVersionRow | null> {
  const rows = await exec.rows<IndexVersionRow>(
    `SELECT id, version, status, source, doc_count, expected_count
     FROM index_version WHERE shop_id=$1::uuid AND status='active'`,
    [shopId],
  );
  return rows[0] ?? null;
}

export async function refreshDocInActiveVersion(
  exec: Exec,
  shopId: string,
  productId: string,
): Promise<"upserted" | "removed" | "no-active"> {
  const active = await getActiveVersion(exec, shopId);
  if (!active) return "no-active";

  const live = await exec.rows<{ id: string }>(
    `SELECT id FROM product WHERE shop_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL`,
    [shopId, productId],
  );
  if (!live[0]) {
    await exec.run(
      `DELETE FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid AND product_id=$3::uuid`,
      [shopId, active.id, productId],
    );
    return "removed";
  }
  await exec.run(
    docInsertSql(`p.shop_id=$1::uuid AND p.id=$3::uuid AND p.deleted_at IS NULL`),
    [shopId, active.id, productId],
  );
  return "upserted";
}

/**
 * Refresh the active-version documents for a set of products (chunked by the
 * caller). Used when a collection rename/delete changes the collection titles
 * embedded in member products' docs.
 */
export async function refreshDocsForProducts(
  exec: Exec,
  shopId: string,
  productIds: string[],
): Promise<number> {
  if (productIds.length === 0) return 0;
  const active = await getActiveVersion(exec, shopId);
  if (!active) return 0;
  await exec.run(
    docInsertSql(`p.shop_id=$1::uuid AND p.deleted_at IS NULL AND p.id = ANY($3::uuid[])`),
    [shopId, active.id, productIds],
  );
  await exec.run(
    `DELETE FROM product_search_doc d USING product p
     WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid
       AND p.id = d.product_id AND p.id = ANY($3::uuid[]) AND p.deleted_at IS NOT NULL`,
    [shopId, active.id, productIds],
  );
  return productIds.length;
}

/**
 * Backfill/rebuild the Phase 3 search columns (tsv/title/sku_text/status/
 * published/available + enriched card doc) for every live product in a given
 * index version, using the SAME docInsertSql as build. Used to migrate docs
 * created before Phase 3 (their tsv is NULL) without a full rebuild. Idempotent.
 * Returns the number of docs re-projected.
 */
export async function reindexVersionDocs(
  exec: Exec,
  shopId: string,
  indexVersionId: string,
): Promise<number> {
  await exec.run(
    docInsertSql(`p.shop_id=$1::uuid AND p.deleted_at IS NULL`),
    [shopId, indexVersionId],
  );
  // Drop any leftover docs whose product is now deleted (keeps the version tidy).
  await exec.run(
    `DELETE FROM product_search_doc d USING product p
     WHERE d.shop_id=$1::uuid AND d.index_version_id=$2::uuid
       AND p.id = d.product_id AND p.deleted_at IS NOT NULL`,
    [shopId, indexVersionId],
  );
  const counted = await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
    [shopId, indexVersionId],
  );
  return counted[0].n;
}

/** Backfill the active version's search columns (convenience wrapper). */
export async function backfillActiveSearchColumns(
  exec: Exec,
  shopId: string,
): Promise<number> {
  const active = await getActiveVersion(exec, shopId);
  if (!active) return 0;
  return reindexVersionDocs(exec, shopId, active.id);
}

export async function recoverInterruptedBuilds(
  exec: Exec,
  shopId: string,
): Promise<number> {
  const stale = await exec.rows<{ id: string }>(
    `SELECT id FROM index_version WHERE shop_id=$1::uuid AND status IN ('building','validating')`,
    [shopId],
  );
  for (const s of stale) {
    await exec.run(
      `DELETE FROM product_search_doc WHERE shop_id=$1::uuid AND index_version_id=$2::uuid`,
      [shopId, s.id],
    );
    await exec.run(
      `UPDATE index_version SET status='failed', failed_at=now(),
         error='recovered: build interrupted', updated_at=now()
       WHERE shop_id=$1::uuid AND id=$2::uuid`,
      [shopId, s.id],
    );
  }
  return stale.length;
}

export async function pruneOldVersions(
  exec: Exec,
  shopId: string,
  keep = 2,
): Promise<number> {
  const doomed = await exec.rows<{ id: string }>(
    `SELECT id FROM index_version
     WHERE shop_id=$1::uuid AND status IN ('superseded','rolled_back','failed')
     ORDER BY version DESC OFFSET $2::int`,
    [shopId, keep],
  );
  for (const d of doomed) {
    await exec.run(`DELETE FROM index_version WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, d.id]);
  }
  return doomed.length;
}
