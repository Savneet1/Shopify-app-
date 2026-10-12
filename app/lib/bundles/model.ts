import type { Exec } from "~/lib/db/executor";
import { Params } from "~/lib/search/filters";
import { classifyRef } from "~/lib/recommend/refs";

/**
 * Phase 10.1 — bundle definitions: CRUD + validation.
 *
 * A bundle has 2..10 slots. For a FIXED bundle every slot is a required item;
 * for a MIX_AND_MATCH bundle the slots are the M candidate products and the
 * shopper picks `mixPickCount` (N) of the available ones. Each slot references a
 * product by gid or handle with either a fixed variant or "customer picks", and
 * a quantity 1..10. Everything is bounded and validated; errors are clear.
 * Duplicate products across slots are REJECTED (documented). Slots are ordered
 * deterministically by (position, id).
 */

export type BundleType = "fixed" | "mix_and_match";
export type BundleStatus = "draft" | "active" | "archived";
export type VariantMode = "fixed" | "customer_picks";
export type IntendedDiscountType = "percent" | "fixed_amount" | "fixed_price";

export const MIN_SLOTS = 2;
export const MAX_SLOTS = 10;
export const MAX_QTY = 10;
export const MAX_NAME = 200;
export const MAX_DESC = 2000;
export const MAX_BUNDLES_PER_SHOP = 500;

/** Strict ProductVariant GID (merchant-entered fixed variant / cart add). */
const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d{1,20}$/;
export function isVariantGid(v: unknown): boolean {
  return typeof v === "string" && VARIANT_GID_RE.test(v);
}
/** Numeric id from a ProductVariant GID, or null. Used by the Ajax cart add. */
export function variantNumericId(gid: unknown): string | null {
  if (!isVariantGid(gid)) return null;
  return String(gid).split("/").pop() ?? null;
}

export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleValidationError";
  }
}

export interface SlotInput {
  productRefKind: "gid" | "handle";
  productRefValue: string;
  variantMode: VariantMode;
  variantGid?: string | null;
  quantity: number;
}

export interface BundleInput {
  name: string;
  description?: string;
  bundleType: BundleType;
  status?: BundleStatus;
  mixPickCount?: number | null;
  placement?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  timezone?: string | null;
  intendedDiscountType?: IntendedDiscountType | null;
  intendedDiscountValue?: number | null;
  intendedDiscountNote?: string;
  slots: SlotInput[];
}

export interface BundleSlotRow {
  id: string;
  position: number;
  product_ref_kind: "gid" | "handle";
  product_ref_value: string;
  variant_mode: VariantMode;
  variant_gid: string | null;
  quantity: number;
}

export interface BundleRow {
  id: string;
  name: string;
  description: string;
  bundle_type: BundleType;
  status: BundleStatus;
  mix_pick_count: number | null;
  placement: string;
  position: number;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  intended_discount_type: IntendedDiscountType | null;
  intended_discount_value: string | null;
  intended_discount_note: string;
  created_at: string;
  updated_at: string;
}

export interface BundleWithSlots extends BundleRow {
  slots: BundleSlotRow[];
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Validate + normalise a bundle input. Throws BundleValidationError. */
export function normalizeBundleInput(input: BundleInput): {
  bundle: Omit<BundleRow, "id" | "created_at" | "updated_at">;
  slots: Required<SlotInput>[];
} {
  const name = str(input.name).trim();
  if (name.length === 0) throw new BundleValidationError("Bundle name is required.");
  if (name.length > MAX_NAME) throw new BundleValidationError(`Bundle name too long (max ${MAX_NAME}).`);

  const description = str(input.description).trim();
  if (description.length > MAX_DESC) throw new BundleValidationError(`Description too long (max ${MAX_DESC}).`);

  const bundleType = input.bundleType;
  if (bundleType !== "fixed" && bundleType !== "mix_and_match") {
    throw new BundleValidationError("Bundle type must be 'fixed' or 'mix_and_match'.");
  }

  const status: BundleStatus = input.status ?? "draft";
  if (!["draft", "active", "archived"].includes(status)) throw new BundleValidationError("Invalid status.");

  const slotsIn = Array.isArray(input.slots) ? input.slots : [];
  if (slotsIn.length < MIN_SLOTS) throw new BundleValidationError(`A bundle needs at least ${MIN_SLOTS} slots.`);
  if (slotsIn.length > MAX_SLOTS) throw new BundleValidationError(`A bundle allows at most ${MAX_SLOTS} slots.`);

  const seen = new Set<string>();
  const slots: Required<SlotInput>[] = [];
  slotsIn.forEach((s, i) => {
    const kind = s.productRefKind;
    if (kind !== "gid" && kind !== "handle") throw new BundleValidationError(`Slot ${i + 1}: product ref kind must be 'gid' or 'handle'.`);
    const ref = classifyRef(s.productRefValue);
    if (!ref || (ref.kind !== "gid" && ref.kind !== "handle") || ref.kind !== kind) {
      throw new BundleValidationError(`Slot ${i + 1}: invalid product ${kind} "${str(s.productRefValue)}".`);
    }
    // Duplicate product across slots → rejected (documented).
    const dedupeKey = `${ref.kind}:${ref.value}`;
    if (seen.has(dedupeKey)) throw new BundleValidationError(`Slot ${i + 1}: product "${ref.value}" is already used by another slot (duplicates are not allowed).`);
    seen.add(dedupeKey);

    const variantMode = s.variantMode;
    if (variantMode !== "fixed" && variantMode !== "customer_picks") throw new BundleValidationError(`Slot ${i + 1}: variant mode must be 'fixed' or 'customer_picks'.`);
    let variantGid: string | null = null;
    if (variantMode === "fixed") {
      if (!isVariantGid(s.variantGid)) throw new BundleValidationError(`Slot ${i + 1}: a fixed variant needs a valid ProductVariant GID.`);
      variantGid = String(s.variantGid);
    }
    const quantity = Math.floor(Number(s.quantity));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_QTY) throw new BundleValidationError(`Slot ${i + 1}: quantity must be 1..${MAX_QTY}.`);

    slots.push({ productRefKind: ref.kind, productRefValue: ref.value, variantMode, variantGid, quantity });
  });

  // Mix-and-match pick count.
  let mixPickCount: number | null = null;
  if (bundleType === "mix_and_match") {
    const n = Math.floor(Number(input.mixPickCount));
    if (!Number.isFinite(n) || n < 1) throw new BundleValidationError("Mix-and-match needs a pick count (N) of at least 1.");
    if (n > slots.length) throw new BundleValidationError(`Pick count (${n}) cannot exceed the number of candidate products (${slots.length}).`);
    mixPickCount = n;
  }

  // Schedule.
  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (startsAt && isNaN(startsAt.getTime())) throw new BundleValidationError("Invalid start date.");
  if (endsAt && isNaN(endsAt.getTime())) throw new BundleValidationError("Invalid end date.");
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) throw new BundleValidationError("Start must be before end.");
  const timezone = input.timezone ? str(input.timezone).slice(0, 64) : null;
  const placement = (str(input.placement).trim() || "product").slice(0, 64);

  // Intended (never-applied) discount.
  let intendedDiscountType: IntendedDiscountType | null = null;
  let intendedDiscountValue: string | null = null;
  if (input.intendedDiscountType != null && str(input.intendedDiscountType) !== "") {
    const t = input.intendedDiscountType;
    if (!["percent", "fixed_amount", "fixed_price"].includes(t)) throw new BundleValidationError("Invalid intended discount type.");
    const v = Number(input.intendedDiscountValue);
    if (!Number.isFinite(v) || v < 0) throw new BundleValidationError("Intended discount value must be ≥ 0.");
    if (t === "percent" && v > 100) throw new BundleValidationError("Percent discount cannot exceed 100.");
    intendedDiscountType = t;
    intendedDiscountValue = v.toFixed(2);
  }
  const intendedDiscountNote = str(input.intendedDiscountNote).slice(0, 500);

  return {
    bundle: {
      name, description, bundle_type: bundleType, status, mix_pick_count: mixPickCount,
      placement, position: 100,
      starts_at: startsAt ? startsAt.toISOString() : null,
      ends_at: endsAt ? endsAt.toISOString() : null,
      timezone,
      intended_discount_type: intendedDiscountType,
      intended_discount_value: intendedDiscountValue,
      intended_discount_note: intendedDiscountNote,
    },
    slots,
  };
}

/**
 * M2(a): reject two slots that resolve to the SAME product even when entered by
 * different refs (e.g. one by gid, one by handle). Resolution prefers the active
 * index version's visible docs; with no active version it falls back to the
 * catalog `product` table. Unresolvable refs are allowed (a draft bundle may
 * reference a product not yet visible) — only refs that resolve to a shared
 * product_id are rejected. (Identical normalised refs are already rejected by
 * normalizeBundleInput.)
 */
export async function assertNoDuplicateResolvedProducts(
  exec: Exec, shopId: string, slots: Required<SlotInput>[],
): Promise<void> {
  const gids: string[] = [];
  const handlesLower: string[] = [];
  for (const s of slots) {
    if (s.productRefKind === "gid") gids.push(s.productRefValue);
    else handlesLower.push(s.productRefValue.toLowerCase());
  }
  if (gids.length === 0 && handlesLower.length === 0) return;

  const active = await exec.rows<{ id: string }>(
    `SELECT id FROM index_version WHERE shop_id=$1::uuid AND status='active'`, [shopId],
  );
  const byGid = new Map<string, string>();
  const byHandleLower = new Map<string, string>();

  const pb = new Params();
  const sid = pb.add(shopId);
  const gidsParam = gids.length ? pb.add(gids) : null;
  const handlesParam = handlesLower.length ? pb.add(handlesLower) : null;
  // WHERE uses the real column expressions (not SELECT aliases).
  const orClause = (gidExpr: string, handleExpr: string): string => {
    const parts: string[] = [];
    if (gidsParam) parts.push(`${gidExpr} = ANY(${gidsParam}::text[])`);
    if (handlesParam) parts.push(`${handleExpr} = ANY(${handlesParam}::text[])`);
    return parts.join(" OR ");
  };
  let rows: { product_id: string; gidcol: string; handle_l: string | null }[];
  if (active[0]) {
    const vid = pb.add(active[0].id);
    rows = await exec.rows(
      `SELECT product_id, shopify_product_gid AS gidcol, lower(doc->>'handle') AS handle_l
       FROM product_search_doc
       WHERE shop_id=${sid}::uuid AND index_version_id=${vid}::uuid
         AND published=true AND status='ACTIVE' AND (${orClause("shopify_product_gid", "lower(doc->>'handle')")})`,
      pb.values,
    );
  } else {
    rows = await exec.rows(
      `SELECT id AS product_id, shopify_product_gid AS gidcol, lower(handle) AS handle_l
       FROM product WHERE shop_id=${sid}::uuid AND deleted_at IS NULL AND (${orClause("shopify_product_gid", "lower(handle)")})`,
      pb.values,
    );
  }
  for (const r of rows) {
    byGid.set(r.gidcol, r.product_id);
    if (r.handle_l) byHandleLower.set(r.handle_l, r.product_id);
  }

  const byProduct = new Map<string, number[]>();
  slots.forEach((s, i) => {
    const pid = s.productRefKind === "gid" ? byGid.get(s.productRefValue) : byHandleLower.get(s.productRefValue.toLowerCase());
    if (!pid) return; // unresolvable → allowed
    const arr = byProduct.get(pid) ?? [];
    arr.push(i + 1); // 1-based slot number
    byProduct.set(pid, arr);
  });
  for (const [, positions] of byProduct) {
    if (positions.length > 1) {
      throw new BundleValidationError(`Slots ${positions.join(" and ")} refer to the same product (duplicates are not allowed, even entered as different gid/handle).`);
    }
  }
}

export async function createBundle(exec: Exec, shopId: string, input: BundleInput): Promise<string> {
  const { bundle, slots } = normalizeBundleInput(input);
  await assertNoDuplicateResolvedProducts(exec, shopId, slots);
  const count = (await exec.rows<{ n: number }>(`SELECT count(*)::int AS n FROM bundle WHERE shop_id=$1::uuid`, [shopId]))[0].n;
  if (count >= MAX_BUNDLES_PER_SHOP) throw new BundleValidationError(`Bundle limit reached (${MAX_BUNDLES_PER_SHOP}).`);
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO bundle
       (shop_id, name, description, bundle_type, status, mix_pick_count, placement, position,
        starts_at, ends_at, timezone, intended_discount_type, intended_discount_value, intended_discount_note)
     VALUES ($1::uuid,$2,$3,$4,$5,$6::int,$7,$8::int,$9::timestamptz,$10::timestamptz,$11,$12,$13::numeric,$14)
     RETURNING id`,
    [shopId, bundle.name, bundle.description, bundle.bundle_type, bundle.status, bundle.mix_pick_count,
     bundle.placement, bundle.position, bundle.starts_at, bundle.ends_at, bundle.timezone,
     bundle.intended_discount_type, bundle.intended_discount_value, bundle.intended_discount_note],
  );
  const bundleId = rows[0].id;
  await insertSlots(exec, shopId, bundleId, slots);
  return bundleId;
}

async function insertSlots(exec: Exec, shopId: string, bundleId: string, slots: Required<SlotInput>[]): Promise<void> {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    await exec.run(
      `INSERT INTO bundle_slot (shop_id, bundle_id, position, product_ref_kind, product_ref_value, variant_mode, variant_gid, quantity)
       VALUES ($1::uuid,$2::uuid,$3::int,$4,$5,$6,$7,$8::int)`,
      [shopId, bundleId, i + 1, s.productRefKind, s.productRefValue, s.variantMode, s.variantGid, s.quantity],
    );
  }
}

/** Replace a bundle's fields + slots (within the caller's tenant transaction). */
export async function updateBundle(exec: Exec, shopId: string, id: string, input: BundleInput): Promise<number> {
  const { bundle, slots } = normalizeBundleInput(input);
  await assertNoDuplicateResolvedProducts(exec, shopId, slots);
  const n = await exec.run(
    `UPDATE bundle SET
       name=$3, description=$4, bundle_type=$5, status=$6, mix_pick_count=$7::int, placement=$8,
       starts_at=$9::timestamptz, ends_at=$10::timestamptz, timezone=$11,
       intended_discount_type=$12, intended_discount_value=$13::numeric, intended_discount_note=$14,
       updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, bundle.name, bundle.description, bundle.bundle_type, bundle.status, bundle.mix_pick_count,
     bundle.placement, bundle.starts_at, bundle.ends_at, bundle.timezone,
     bundle.intended_discount_type, bundle.intended_discount_value, bundle.intended_discount_note],
  );
  if (n === 0) return 0;
  await exec.run(`DELETE FROM bundle_slot WHERE shop_id=$1::uuid AND bundle_id=$2::uuid`, [shopId, id]);
  await insertSlots(exec, shopId, id, slots);
  return n;
}

export async function setBundleStatus(exec: Exec, shopId: string, id: string, status: BundleStatus): Promise<number> {
  if (!["draft", "active", "archived"].includes(status)) throw new BundleValidationError("Invalid status.");
  return exec.run(`UPDATE bundle SET status=$3, updated_at=now() WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id, status]);
}

export async function deleteBundle(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM bundle WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

export async function listBundles(exec: Exec, shopId: string): Promise<(BundleRow & { slot_count: number })[]> {
  return exec.rows<BundleRow & { slot_count: number }>(
    `SELECT b.*, (SELECT count(*)::int FROM bundle_slot s WHERE s.shop_id=b.shop_id AND s.bundle_id=b.id) AS slot_count
     FROM bundle b WHERE b.shop_id=$1::uuid ORDER BY b.position ASC, b.created_at DESC, b.id ASC`,
    [shopId],
  );
}

export async function getBundle(exec: Exec, shopId: string, id: string): Promise<BundleWithSlots | null> {
  const rows = await exec.rows<BundleRow>(`SELECT * FROM bundle WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
  if (!rows[0]) return null;
  const slots = await exec.rows<BundleSlotRow>(
    `SELECT id, position, product_ref_kind, product_ref_value, variant_mode, variant_gid, quantity
     FROM bundle_slot WHERE shop_id=$1::uuid AND bundle_id=$2::uuid ORDER BY position ASC, id ASC`,
    [shopId, id],
  );
  return { ...rows[0], slots };
}
