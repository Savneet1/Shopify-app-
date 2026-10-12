import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { getActiveVersion } from "~/lib/index/engine";
import { getBundle, variantNumericId, type BundleWithSlots, type BundleSlotRow } from "./model";

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

async function resolveSlot(
  exec: Exec, shopId: string, versionId: string, slot: BundleSlotRow,
): Promise<ResolvedSlot> {
  // 1) product must be a VISIBLE doc in the active version.
  const pb = new Params();
  const sid = pb.add(shopId);
  const vid = pb.add(versionId);
  const match = slot.product_ref_kind === "gid"
    ? `shopify_product_gid = ${pb.add(slot.product_ref_value)}`
    : `doc->>'handle' = ${pb.add(slot.product_ref_value)}`;
  const docs = await exec.rows<{ product_id: string; gid: string; doc: any }>(
    `SELECT product_id, shopify_product_gid AS gid, doc FROM product_search_doc
     WHERE shop_id=${sid}::uuid AND index_version_id=${vid}::uuid
       AND published=true AND status='ACTIVE' AND ${match} LIMIT 1`,
    pb.values,
  );
  const label = slot.product_ref_value;
  if (!docs[0]) {
    return { slot, ok: false, reason: `Product "${label}" is unpublished or not in the catalog.`, item: null };
  }
  const row = docs[0];
  const d = row.doc ?? {};
  const img = d.image ?? {};

  // 2) purchasable variants from the catalog variant table (not docInsertSql).
  const vpb = new Params();
  const vsid = vpb.add(shopId);
  const vpid = vpb.add(row.product_id);
  const variantsAll = await exec.rows<{ gid: string; title: string | null; price: string | null; available: boolean }>(
    `SELECT shopify_variant_gid AS gid, title, price::text AS price, COALESCE(available_for_sale,false) AS available
     FROM variant
     WHERE shop_id=${vsid}::uuid AND product_id=${vpid}::uuid AND deleted_at IS NULL
     ORDER BY position ASC NULLS LAST, id ASC`,
    vpb.values,
  );
  // purchasable = available AND has a price AND a valid numeric variant gid.
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
    if (!match2) {
      return { slot, ok: false, reason: `The selected variant of "${label}" is unavailable.`, item: null };
    }
    options = [toOption(match2)];
  } else {
    options = purchasable.map(toOption);
  }

  const defaultVariantId = options[0]?.variantId ?? null;
  const unitPrice = options[0]?.price ?? null;
  const lineTotal = unitPrice != null ? (Number(unitPrice) * slot.quantity).toFixed(2) : null;

  const item: BundleItem = {
    slotId: slot.id, position: slot.position, quantity: slot.quantity, variantMode: slot.variant_mode,
    product, variants: options, defaultVariantId, unitPrice, lineTotal,
  };
  return { slot, ok: true, reason: null, item };
}

function toOption(v: { gid: string; title: string | null; price: string | null; available: boolean }): VariantOption {
  return { variantGid: v.gid, variantId: variantNumericId(v.gid) as string, title: v.title, price: v.price, available: v.available };
}

/** Resolve a bundle to a storefront payload (or hidden with per-slot reasons). */
export async function resolveBundle(
  exec: Exec, shopId: string, versionId: string, bundle: BundleWithSlots, now: Date = new Date(),
): Promise<ResolveResult> {
  const resolved: ResolvedSlot[] = [];
  for (const slot of bundle.slots) resolved.push(await resolveSlot(exec, shopId, versionId, slot));
  const blocked: BlockedSlot[] = resolved
    .filter((r) => !r.ok)
    .map((r) => ({ slotId: r.slot.id, position: r.slot.position, product: r.slot.product_ref_value, reason: r.reason! }));

  const okItems = resolved.filter((r) => r.ok).map((r) => r.item!);

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

function buildPayload(bundle: BundleWithSlots, items: BundleItem[]): BundlePayload {
  const first = items[0];
  let total: string | null = null;
  let priceMin: string | null = null;
  let priceMax: string | null = null;

  if (bundle.bundle_type === "fixed") {
    // Sum of regular line totals (default selection).
    let sum = 0; let complete = true;
    for (const it of items) {
      if (it.lineTotal == null) { complete = false; break; }
      sum += Number(it.lineTotal);
    }
    if (complete) { total = sum.toFixed(2); priceMin = total; priceMax = total; }
  } else {
    // mix: the card price RANGE = sum of the N cheapest / N dearest line totals.
    const n = bundle.mix_pick_count ?? 1;
    const totals = items.map((it) => (it.lineTotal != null ? Number(it.lineTotal) : null)).filter((x): x is number => x != null).sort((a, b) => a - b);
    if (totals.length >= n) {
      const cheapest = totals.slice(0, n).reduce((a, b) => a + b, 0);
      const dearest = totals.slice(totals.length - n).reduce((a, b) => a + b, 0);
      priceMin = cheapest.toFixed(2);
      priceMax = dearest.toFixed(2);
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

/** All shown bundles for the shop (optionally filtered to a product ref). */
export async function listVisibleBundles(
  exec: Exec, shopId: string, opts: { productRef?: string | null; limit?: number; now?: Date } = {},
): Promise<BundlePayload[]> {
  const active = await getActiveVersion(exec, shopId);
  if (!active) return [];
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 20)));
  // Candidate bundles: active status only (schedule re-checked in resolve).
  const rows = await exec.rows<{ id: string }>(
    `SELECT id FROM bundle WHERE shop_id=$1::uuid AND status='active' ORDER BY position ASC, created_at DESC, id ASC`,
    [shopId],
  );
  const out: BundlePayload[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const bundle = await getBundle(exec, shopId, r.id);
    if (!bundle) continue;
    // Optional product filter: only bundles that reference the given product ref.
    if (opts.productRef) {
      const refd = bundle.slots.some((s) => s.product_ref_value === opts.productRef);
      if (!refd) continue;
    }
    const res = await resolveBundle(exec, shopId, active.id, bundle, now);
    if (res.shown && res.payload) out.push(res.payload);
  }
  return out;
}
