import type { Exec } from "~/lib/db/executor";

/**
 * Phase 12.4 — pre-order MESSAGING rules (DISPLAY ONLY). A rule makes the
 * storefront show a "Pre-order / ships on <date>" badge + note; it does NOT
 * change inventory policy, selling plans or checkout. Whether an out-of-stock
 * product can actually be bought is configured by the merchant in Shopify
 * (continue-selling / selling plans) = Requires Verification.
 */

export type PreorderMatchType = "tag" | "handle" | "gid" | "collection";

export interface PreorderRule {
  id: string;
  matchType: PreorderMatchType;
  matchValue: string;
  message: string | null;
  releaseAt: string | null; // ISO UTC
  startsAt: string | null;
  endsAt: string | null;
  enabled: boolean;
}

export interface PreorderProduct {
  gid: string;
  handle: string | null;
  tags: string[];
  collectionGids: string[];
}

export interface PreorderBadge {
  preorder: true;
  message: string | null;
  releaseAt: string | null; // ISO UTC; the theme formats with the shop IANA tz
}

/** Schedule window: start-inclusive, end-exclusive; null bounds are open. */
export function scheduleApplies(rule: PreorderRule, now: Date): boolean {
  const t = now.getTime();
  if (rule.startsAt && t < new Date(rule.startsAt).getTime()) return false;
  if (rule.endsAt && t >= new Date(rule.endsAt).getTime()) return false;
  return true;
}

export function ruleMatchesProduct(rule: PreorderRule, p: PreorderProduct): boolean {
  switch (rule.matchType) {
    case "gid": return rule.matchValue === p.gid;
    case "handle": return p.handle != null && rule.matchValue.toLowerCase() === p.handle.toLowerCase();
    case "tag": {
      const v = rule.matchValue.toLowerCase();
      return p.tags.some((t) => t.toLowerCase() === v);
    }
    case "collection": return p.collectionGids.includes(rule.matchValue);
    default: return false;
  }
}

// Specificity order so the most specific matching rule wins deterministically.
const SPECIFICITY: Record<PreorderMatchType, number> = { gid: 0, handle: 1, collection: 2, tag: 3 };

/** The pre-order badge for a product, or null when no enabled, in-window rule
 * matches. Pure. */
export function preorderForProduct(
  rules: PreorderRule[], p: PreorderProduct, now: Date,
): PreorderBadge | null {
  const matches = rules
    .filter((r) => r.enabled && scheduleApplies(r, now) && ruleMatchesProduct(r, p))
    .sort((a, b) => SPECIFICITY[a.matchType] - SPECIFICITY[b.matchType]);
  const r = matches[0];
  if (!r) return null;
  return { preorder: true, message: r.message, releaseAt: r.releaseAt };
}

// ---- storage -------------------------------------------------------------

function mapRow(r: any): PreorderRule {
  return {
    id: r.id, matchType: r.match_type, matchValue: r.match_value, message: r.message,
    releaseAt: r.release_at ? new Date(r.release_at).toISOString() : null,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    enabled: r.enabled,
  };
}

export async function listPreorderRules(exec: Exec, shopId: string): Promise<PreorderRule[]> {
  const rows = await exec.rows<any>(
    `SELECT id, match_type, match_value, message, release_at, starts_at, ends_at, enabled
     FROM preorder_rule WHERE shop_id=$1::uuid ORDER BY created_at ASC`,
    [shopId],
  );
  return rows.map(mapRow);
}

export async function loadEnabledPreorderRules(exec: Exec, shopId: string): Promise<PreorderRule[]> {
  const rows = await exec.rows<any>(
    `SELECT id, match_type, match_value, message, release_at, starts_at, ends_at, enabled
     FROM preorder_rule WHERE shop_id=$1::uuid AND enabled=true ORDER BY created_at ASC`,
    [shopId],
  );
  return rows.map(mapRow);
}

export interface PreorderRuleInput {
  matchType: PreorderMatchType;
  matchValue: string;
  message?: string | null;
  releaseAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  enabled?: boolean;
}

const MATCH_TYPES = new Set(["tag", "handle", "gid", "collection"]);

function validateInput(input: PreorderRuleInput): { ok: true } | { ok: false; error: string } {
  if (!MATCH_TYPES.has(input.matchType)) return { ok: false, error: "invalid match_type" };
  if (!input.matchValue || input.matchValue.length < 1 || input.matchValue.length > 500) return { ok: false, error: "invalid match_value" };
  if (input.message != null && input.message.length > 300) return { ok: false, error: "message too long" };
  for (const d of [input.releaseAt, input.startsAt, input.endsAt]) {
    if (d != null && d !== "" && Number.isNaN(new Date(d).getTime())) return { ok: false, error: "invalid date" };
  }
  return { ok: true };
}

export async function createPreorderRule(exec: Exec, shopId: string, input: PreorderRuleInput): Promise<{ id: string } | { error: string }> {
  const v = validateInput(input);
  if (!v.ok) return { error: v.error };
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO preorder_rule (shop_id, match_type, match_value, message, release_at, starts_at, ends_at, enabled)
     VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8)
     RETURNING id`,
    [shopId, input.matchType, input.matchValue, nz(input.message), nz(input.releaseAt), nz(input.startsAt), nz(input.endsAt), input.enabled !== false],
  );
  return { id: rows[0].id };
}

export async function updatePreorderRule(exec: Exec, shopId: string, id: string, input: PreorderRuleInput): Promise<{ ok: boolean } | { error: string }> {
  const v = validateInput(input);
  if (!v.ok) return { error: v.error };
  const n = await exec.run(
    `UPDATE preorder_rule SET match_type=$3, match_value=$4, message=$5, release_at=$6::timestamptz,
       starts_at=$7::timestamptz, ends_at=$8::timestamptz, enabled=$9, updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, input.matchType, input.matchValue, nz(input.message), nz(input.releaseAt), nz(input.startsAt), nz(input.endsAt), input.enabled !== false],
  );
  return { ok: n > 0 };
}

export async function deletePreorderRule(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM preorder_rule WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

function nz(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}
