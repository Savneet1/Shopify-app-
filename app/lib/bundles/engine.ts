import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { classifyRef } from "~/lib/recommend/refs";
import { getActiveVersion } from "~/lib/index/engine";
import { getBundle, variantNumericId, type BundleWithSlots, type BundleSlotRow } from "./model";
import { scaleOf, lineTotalAtScale, sumAtScale, toMinorAtScale, fromMinorAtScale } from "./money";

/** Candidate bundles resolved per storefront request are hard-capped (M3). */
export const MAX_RESOLVED_BUNDLES = 50;

/**
 * Phase 10.2 — bundle visibility / availability resolution + storefront payload.
 *
 * A bundle is shown to shoppers ONLY if it is active and in schedule AND its
 * required slots resolve to products that are VISIBLE in the active index
 * version's docs (published + ACTIVE) and AVAILABLE (≥1 purchasable variant).
 * Otherwise the bundle is hidden ENTIRELY (never a partial/broken bundle) and
 * the admin is told exactly which slot blocks it. Variant price/availability
 * come from the catalog `variant` table joined to the visible docs — docInsertSql
 * is NOT changed. Unknown/foreign ids simply resolve to "not visible" → hidden,
 * never an error, never a cross-shop leak. Follows index swap/rollback because it
 * always reads whichever version it is given (the active one). Phase 8 search
 * HIDE rules do NOT apply to bundles (merchant-curated) — see docs/PHASE10.md.
 */

export interface VariantOption {
  variantGid: string;
  variantId: string; // numeric id for the Ajax cart add
  title: string | null;
  price: string | null;
  available: boolean;
}

export interface BundleItem {
  slotId: string;
  position: number;
  quantity: number;
  variantMode: "fixed" | "customer_picks";
  product: {
    id: string;
    gid: string;
    title: string | null;
    handle: string | null;
    url: string | null;
    image: { url: string | null; alt: string | null };
    vendor: string | null;
    available: boolean;
  };
  variants: VariantOption[];
  defaultVariantId: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
}

export interface BundlePayload {
  id: string;
  name: string;
  description: string;
  bundleType: "fixed" | "mix_and_match";
  mixPickCount: number | null;
  // card shape (Phase 7.1 handling applies on the storefront)
  title: string;
  url: string | null;
  image: { url: string | null; alt: string | null };
  vendor: string | null;
  priceMin: string | null;
  priceMax: string | null;
  available: boolean;
  total: string | null;
  placement: string;
  items: BundleItem[];
}

export interface BlockedSlot {
  slotId: string;
  position: number;
  product: string;
  reason: string;
}

export interface ResolveResult {
  shown: boolean;
  reason: string | null;
  payload: BundlePayload | null;
  blocked: BlockedSlot[];
}

/** Active + within [starts, ends) using an injected clock. */
export function scheduleActive(b: { status: string; starts_at: string | null; ends_at: string | null }, now: Date): boolean {
  if (b.status !== "active") return false;
  const t = now.getTime();
  if (b.starts_at && t < new Date(b.starts_at).getTime()) return false;
  if (b.ends_at && t >= new Date(b.ends_at).getTime()) return false;
  return true;
}

interface ResolvedSlot {
  slot: BundleSlotRow;
  ok: boolean;
  reason: string | null;
  item: BundleItem | null;
}

// ---- Batched slot resolution (M3): docs + variants loaded in bulk ----------
interface DocRow { product_id: string; gid: string; doc: any; handle_l: string | null }
interface VariantRow { product_id: string; gid: string; title: string | null; price: string | null; available: boolean }
export interface SlotMaps {
  byGid: Map<string, DocRow>;
  byHandleLower: Map<string, DocRow>;
  variantsByProduct: Map<string, VariantRow[]>;
}

/** Load the visible docs + purchasable variants for a set of slots in at most
 * two queries. Products are matched by gid OR lowercased handle. */
export async function buildSlotMaps(
  exec: Exec, shopId: string, versionId: string, slots: BundleSlotRow[],
): Promise<SlotMaps> {
  const byGid = new Map<string, DocRow>();
  const byHandleLower = new Map<string, DocRow>();
  const variantsByProduct = new Map<string, VariantRow[]>();
  const gids: string[] = [];
  const handlesLower: string[] = [];
  for (const s of slots) {
    if (s.product_ref_kind === "gid") gids.push(s.product_ref_value);
    else handlesLower.push(s.product_ref_value.toLowerCase());
  }
  if (gids.length === 0 && handlesLower.length === 0) return { byGid, byHandleLower, variantsByProduct };

  const pb = new Params();
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const ors: string[] = [];
  if (gids.length) ors.push(`shopify_product_gid = ANY(${pb.add(gids)}::text[])`);
  if (handlesLower.length) ors.push(`lower(doc->>'handle') = ANY(${pb.add(handlesLower)}::text[])`);
  const docs = await exec.rows<DocRow>(
    `SELECT product_id, shopify_product_gid AS gid, doc, lower(doc->>'handle') AS handle_l
     FROM product_search_doc
     WHERE shop_id=${sid}::uuid AND index_version_id=${vid}::uuid
       AND published=true AND status='ACTIVE' AND (${ors.join(" OR ")})`,
    pb.values,
  );
  const pids: string[] = [];
  for (const row of docs) {
    byGid.set(row.gid, row);
    if (row.handle_l) byHandleLower.set(row.handle_l, row);
    pids.push(row.product_id);
  }
  if (pids.length) {
    const vpb = new Params();
    const vsid = vpb.add(shopId);
    const vrows = await exec.rows<VariantRow>(
      `SELECT product_id, shopify_variant_gid AS gid, title, price::text AS price, COALESCE(available_for_sale,false) AS available
       FROM variant
       WHERE shop_id=${vsid}::uuid AND product_id = ANY(${vpb.add(pids)}::uuid[]) AND deleted_at IS NULL
       ORDER BY product_id, position ASC NULLS LAST, id ASC`,
      vpb.values,
    );
    for (const v of vrows) {
      const arr = variantsByProduct.get(v.product_id) ?? [];
      arr.push(v);
      variantsByProduct.set(v.product_id, arr);
    }
  }
  return { byGid, byHandleLower, variantsByProduct };
}

/** Resolve one slot from the batched maps (no DB access). */
function resolveSlotFromMaps(slot: BundleSlotRow, maps: SlotMaps): ResolvedSlot {
  const row = slot.product_ref_kind === "gid"
    ? maps.byGid.get(slot.product_ref_value)
    : maps.byHandleLower.get(slot.product_ref_value.toLowerCase());
  const label = slot.product_ref_value;
  if (!row) return { slot, ok: false, reason: `Product "${label}" is unpublished or not in the catalog.`, item: null };
  const d = row.doc ?? {};
  const img = d.image ?? {};
  const variantsAll = maps.variantsByProduct.get(row.product_id) ?? [];
  const purchasable = variantsAll.filter((v) => v.available && v.price != null && variantNumericId(v.gid) != null);
  const product = {
    id: row.product_id, gid: row.gid, title: d.title ?? null, handle: d.handle ?? null,
    url: d.url ?? null, image: { url: img.url ?? null, alt: img.alt ?? null },
    vendor: d.vendor ?? null, available: Boolean(d.available),
  };
  if (purchasable.length === 0) {
    return { slot, ok: false, reason: `Product "${label}" is out of stock.`, item: null };
  }
  let options: VariantOption[];
  if (slot.variant_mode === "fixed") {
    const match2 = purchasable.find((v) => v.gid === slot.variant_gid);
    if (!match2) return { slot, ok: false, reason: `The selected variant of "${label}" is unavailable.`, item: null };
    options = [toOption(match2)];
  } else {
    options = purchasable.map(toOption);
  }
  const item: BundleItem = {
    slotId: slot.id, position: slot.position, quantity: slot.quantity, variantMode: slot.variant_mode,
    product, variants: options, defaultVariantId: options[0]?.variantId ?? null,
    unitPrice: options[0]?.price ?? null, lineTotal: null, // lineTotal filled by buildPayload (exact decimal)
  };
  return { slot, ok: true, reason: null, item };
}

function toOption(v: { gid: string; title: string | null; price: string | null; available: boolean }): VariantOption {
  return { variantGid: v.gid, variantId: variantNumericId(v.gid) as string, title: v.title, price: v.price, available: v.available };
}

/** Resolve a bundle from pre-built maps (pure, no DB). */
export function resolveBundleWithMaps(bundle: BundleWithSlots, maps: SlotMaps, now: Date = new Date()): ResolveResult {
  const resolved: ResolvedSlot[] = bundle.slots.map((slot) => resolveSlotFromMaps(slot, maps));
  const blocked: BlockedSlot[] = resolved
    .filter((r) => !r.ok)
    .map((r) => ({ slotId: r.slot.id, position: r.slot.position, product: r.slot.product_ref_value, reason: r.reason! }));

  let okItems = resolved.filter((r) => r.ok).map((r) => r.item!);

  // M2(b): two slots that resolve to the SAME product → never show duplicate
  // lines; block the bundle and name every duplicated slot.
  const byProduct = new Map<string, ResolvedSlot[]>();
  for (const r of resolved) {
    if (!r.ok || !r.item) continue;
    const arr = byProduct.get(r.item.product.id) ?? [];
    arr.push(r);
    byProduct.set(r.item.product.id, arr);
  }
  let hasDuplicate = false;
  for (const [, group] of byProduct) {
    if (group.length <= 1) continue;
    hasDuplicate = true;
    const positions = group.map((g) => g.slot.position).sort((a, b) => a - b);
    for (const g of group) {
      blocked.push({
        slotId: g.slot.id, position: g.slot.position, product: g.slot.product_ref_value,
        reason: `Resolves to the same product as slot(s) ${positions.filter((p) => p !== g.slot.position).join(", ")} — duplicate lines are not allowed.`,
      });
    }
  }
  if (hasDuplicate) {
    const dupIds = new Set<string>();
    for (const [pid, group] of byProduct) if (group.length > 1) dupIds.add(pid);
    okItems = okItems.filter((it) => !dupIds.has(it.product.id));
  }

  // Gating.
  const scheduled = scheduleActive(bundle, now);
  let shown = scheduled;
  let reason: string | null = scheduled ? null : (bundle.status !== "active" ? `Bundle status is '${bundle.status}'.` : "Outside the scheduled window.");

  if (bundle.bundle_type === "fixed") {
    if (blocked.length > 0) { shown = false; reason = reason ?? "A required product is unavailable."; }
  } else {
    // mix_and_match: need at least N available candidates.
    const n = bundle.mix_pick_count ?? 1;
    if (okItems.length < n) { shown = false; reason = reason ?? `Only ${okItems.length} of the ${n} required candidates are available.`; }
  }

  if (!shown) return { shown: false, reason, payload: null, blocked };

  // Items shown: fixed → all (all ok); mix → the available candidates.
  const items = bundle.bundle_type === "fixed" ? okItems : okItems;
  const payload = buildPayload(bundle, items);
  return { shown: true, reason: null, payload, blocked };
}

/** Compare two decimal strings numerically (exact, via a shared scale). */
function cmpDecimal(a: string, b: string, scale: number): number {
  const av = toMinorAtScale(a, scale);
  const bv = toMinorAtScale(b, scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function buildPayload(bundle: BundleWithSlots, items: BundleItem[]): BundlePayload {
  const first = items[0];
  // M4(b): exact decimal arithmetic. Scale = max decimals across default unit
  // prices (min 2); line totals / sums / ranges use integer (BigInt) math.
  const scale = scaleOf(items.map((it) => it.unitPrice));
  for (const it of items) it.lineTotal = lineTotalAtScale(it.unitPrice, it.quantity, scale);

  let total: string | null = null;
  let priceMin: string | null = null;
  let priceMax: string | null = null;

  if (bundle.bundle_type === "fixed") {
    const complete = items.every((it) => it.lineTotal != null);
    if (complete) { total = sumAtScale(items.map((it) => it.lineTotal), scale); priceMin = total; priceMax = total; }
  } else {
    // mix: the card price RANGE = sum of the N cheapest / N dearest line totals.
    const n = bundle.mix_pick_count ?? 1;
    const totals = items.map((it) => it.lineTotal).filter((x): x is string => x != null).sort((a, b) => cmpDecimal(a, b, scale));
    if (totals.length >= n) {
      priceMin = sumAtScale(totals.slice(0, n), scale);
      priceMax = sumAtScale(totals.slice(totals.length - n), scale);
      // total stays null — the real total depends on the shopper's N picks.
    }
  }

  return {
    id: bundle.id, name: bundle.name, description: bundle.description,
    bundleType: bundle.bundle_type, mixPickCount: bundle.mix_pick_count,
    title: bundle.name,
    url: first?.product.url ?? null,
    image: first?.product.image ?? { url: null, alt: null },
    vendor: first?.product.vendor ?? null,
    priceMin, priceMax, available: true, total,
    placement: bundle.placement, items,
  };
}

/** Resolve a single bundle (builds its own maps). Back-compat signature. */
export async function resolveBundle(
  exec: Exec, shopId: string, versionId: string, bundle: BundleWithSlots, now: Date = new Date(),
): Promise<ResolveResult> {
  const maps = await buildSlotMaps(exec, shopId, versionId, bundle.slots);
  return resolveBundleWithMaps(bundle, maps, now);
}

/** Resolve one bundle by id for the storefront (hidden → null). */
export async function resolveBundleForStorefront(
  exec: Exec, shopId: string, bundleId: string, now: Date = new Date(),
): Promise<BundlePayload | null> {
  const active = await getActiveVersion(exec, shopId);
  if (!active) return null;
  const bundle = await getBundle(exec, shopId, bundleId);
  if (!bundle) return null;
  const res = await resolveBundle(exec, shopId, active.id, bundle, now);
  return res.shown ? res.payload : null;
}

interface ResolvedProductRef { productId: string; gid: string; handleLower: string | null }

/**
 * M1: resolve an incoming product ref (gid or handle, handle case-insensitive)
 * to a VISIBLE doc's identity in the active version. Returns null when the ref
 * is invalid or does not resolve (→ caller returns [], never "all bundles").
 */
async function resolveProductRef(
  exec: Exec, shopId: string, versionId: string, rawRef: string,
): Promise<ResolvedProductRef | null> {
  const ref = classifyRef(rawRef);
  if (!ref || (ref.kind !== "gid" && ref.kind !== "handle")) return null;
  const pb = new Params();
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const match = ref.kind === "gid"
    ? `shopify_product_gid = ${pb.add(ref.value)}`
    : `lower(doc->>'handle') = ${pb.add(ref.value.toLowerCase())}`;
  const rows = await exec.rows<{ product_id: string; gid: string; handle_l: string | null }>(
    `SELECT product_id, shopify_product_gid AS gid, lower(doc->>'handle') AS handle_l
     FROM product_search_doc
     WHERE shop_id=${sid}::uuid AND index_version_id=${vid}::uuid
       AND published=true AND status='ACTIVE' AND ${match} LIMIT 1`,
    pb.values,
  );
  if (!rows[0]) return null;
  return { productId: rows[0].product_id, gid: rows[0].gid, handleLower: rows[0].handle_l };
}

/**
 * All shown bundles for the shop (M1/M3). With a productRef, the ref is resolved
 * to a product identity and only bundles whose slots reference that product (by
 * gid OR lowercased handle) are loaded — matched in SQL, so a no-match lookup
 * costs a small constant number of queries (≤3) regardless of bundle count, and
 * a matching lookup costs a small constant (≤7: active version, resolve ref,
 * candidate ids, bundles, slots, docs, variants) independent of how many bundles
 * exist. The candidate set is hard-capped at MAX_RESOLVED_BUNDLES.
 */
export async function listVisibleBundles(
  exec: Exec, shopId: string, opts: { productRef?: string | null; limit?: number; now?: Date } = {},
): Promise<BundlePayload[]> {
  const active = await getActiveVersion(exec, shopId); // query 1
  if (!active) return [];
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(MAX_RESOLVED_BUNDLES, Math.floor(opts.limit ?? 20)));

  // Candidate bundle ids (active), optionally pre-filtered to a product.
  let candidateIds: string[];
  if (opts.productRef != null && opts.productRef !== "") {
    const resolved = await resolveProductRef(exec, shopId, active.id, opts.productRef); // query 2
    if (!resolved) return []; // ref did not resolve → never "all bundles"
    const pb = new Params();
    const sid = pb.add(shopId);
    const pGid = pb.add(resolved.gid);
    const pHandle = resolved.handleLower != null ? pb.add(resolved.handleLower) : null;
    const slotMatch = [
      `(s.product_ref_kind='gid' AND s.product_ref_value = ${pGid})`,
      pHandle != null ? `(s.product_ref_kind='handle' AND lower(s.product_ref_value) = ${pHandle})` : null,
    ].filter(Boolean).join(" OR ");
    const pCap = pb.add(MAX_RESOLVED_BUNDLES);
    const rows = await exec.rows<{ id: string }>( // query 3
      `SELECT b.id FROM bundle b
       WHERE b.shop_id=${sid}::uuid AND b.status='active'
         AND EXISTS (SELECT 1 FROM bundle_slot s WHERE s.shop_id=b.shop_id AND s.bundle_id=b.id AND (${slotMatch}))
       ORDER BY b.position ASC, b.created_at DESC, b.id ASC
       LIMIT ${pCap}::int`,
      pb.values,
    );
    candidateIds = rows.map((r) => r.id);
  } else {
    const pb = new Params();
    const sid = pb.add(shopId);
    const pCap = pb.add(MAX_RESOLVED_BUNDLES);
    const rows = await exec.rows<{ id: string }>(
      `SELECT id FROM bundle WHERE shop_id=${sid}::uuid AND status='active'
       ORDER BY position ASC, created_at DESC, id ASC LIMIT ${pCap}::int`,
      pb.values,
    );
    candidateIds = rows.map((r) => r.id);
  }
  if (candidateIds.length === 0) return [];

  // Batch-load the candidate bundles + all their slots (2 queries).
  const bpb = new Params();
  const bsid = bpb.add(shopId);
  const bids = bpb.add(candidateIds);
  const bundleRows = await exec.rows<BundleWithSlots>(
    `SELECT * FROM bundle WHERE shop_id=${bsid}::uuid AND id = ANY(${bids}::uuid[])`,
    bpb.values,
  );
  const spb = new Params();
  const ssid = spb.add(shopId);
  const sids = spb.add(candidateIds);
  const slotRows = await exec.rows<BundleSlotRow & { bundle_id: string }>(
    `SELECT id, bundle_id, position, product_ref_kind, product_ref_value, variant_mode, variant_gid, quantity
     FROM bundle_slot WHERE shop_id=${ssid}::uuid AND bundle_id = ANY(${sids}::uuid[])
     ORDER BY bundle_id, position ASC, id ASC`,
    spb.values,
  );
  const slotsByBundle = new Map<string, BundleSlotRow[]>();
  const allSlots: BundleSlotRow[] = [];
  for (const s of slotRows) {
    const arr = slotsByBundle.get(s.bundle_id) ?? [];
    arr.push(s);
    slotsByBundle.set(s.bundle_id, arr);
    allSlots.push(s);
  }

  // One docs query + one variants query for ALL slots across all candidates.
  const maps = await buildSlotMaps(exec, shopId, active.id, allSlots);

  // Preserve the candidate (deterministic) order.
  const bundleById = new Map(bundleRows.map((b) => [b.id, b]));
  const out: BundlePayload[] = [];
  for (const id of candidateIds) {
    if (out.length >= limit) break;
    const b = bundleById.get(id);
    if (!b) continue;
    const bundle: BundleWithSlots = { ...b, slots: slotsByBundle.get(id) ?? [] };
    const res = resolveBundleWithMaps(bundle, maps, now);
    if (res.shown && res.payload) out.push(res.payload);
  }
  return out;
}
