import type { Exec } from "~/lib/db/executor";
import { normalizeQuery } from "~/lib/search/text";
import { listRunningExperiments, assignmentsFor } from "./experiments";
import type { Variant } from "./assign";

/**
 * Merchandising rules (Phase 8.1/8.2). Rule-based, deterministic.
 *
 * action ∈ pin | boost | demote | hide. Applied INSIDE the one query planner
 * (never a post-filter): hide → hard WHERE exclusion (shared by products,
 * totals, facets, predictive, suggest); pin → a global ORDER BY key (stable
 * across pagination); boost/demote → a bounded score delta applied AFTER the
 * match class (so a boost can never outrank a higher match class, e.g. an
 * exact-SKU hit). Pins/boosts/demotes apply to the RELEVANCE sort only (price /
 * newest are explicit user choices); hide applies to every sort.
 *
 * Conflict resolution (documented): per product, action precedence is
 * hide > pin > boost > demote; among rules of the winning action, the lowest
 * `priority` wins, ties broken by rule id. Each product ends with at most one
 * effective action.
 *
 * Visibility is never overridden: a pin/boost of a draft / unpublished /
 * deleted / other-shop product has NO effect, because the planner's hard
 * visibility WHERE removes it from the base set before ordering.
 */

export type MerchAction = "pin" | "boost" | "demote" | "hide";
export type MerchScopeType = "query_exact" | "query_contains" | "collection" | "global";

export const MAX_RULES_PER_SHOP = 500;
export const MAX_TARGETS_PER_RULE = 200;
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 90; // < the 100 class gap in ranking.ts → stays within class
export const WEIGHT_DEFAULT = 50;
export const POSITION_MAX = 1000;

export interface MerchTargetInput { kind: "gid" | "handle"; value: string; }

export interface MerchRuleRow {
  id: string;
  action: MerchAction;
  scope_type: MerchScopeType;
  scope_value: string | null;
  priority: number;
  position: number | null;
  weight: number | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  enabled: boolean;
  experiment_id: string | null;
  variant: "A" | "B" | null;
  created_at: string;
}

export interface MerchRuleWithTargets extends MerchRuleRow {
  targets: MerchTargetInput[];
}

export interface MerchAnnotation {
  action: MerchAction;
  ruleId: string;
  position?: number;
  delta?: number;
}

export interface MerchPlan {
  hideIds: string[];
  pinIds: string[]; // product_ids in final pin order
  deltaIds: string[]; // product_ids with a boost/demote
  deltaVals: number[]; // signed deltas aligned with deltaIds
  annotations: Record<string, MerchAnnotation>;
  assignments: { experimentId: string; variant: Variant }[];
}

export const EMPTY_MERCH_PLAN: MerchPlan = {
  hideIds: [], pinIds: [], deltaIds: [], deltaVals: [], annotations: {}, assignments: [],
};

export function isMerchPlanEmpty(p: MerchPlan | null | undefined): boolean {
  return !p || (p.hideIds.length === 0 && p.pinIds.length === 0 && p.deltaIds.length === 0);
}

// ---- CRUD ------------------------------------------------------------------

export async function listRules(exec: Exec, shopId: string): Promise<MerchRuleWithTargets[]> {
  const rules = await exec.rows<MerchRuleRow>(
    `SELECT id, action, scope_type, scope_value, priority, position, weight,
            starts_at, ends_at, timezone, enabled, experiment_id, variant, created_at
     FROM merch_rule WHERE shop_id=$1::uuid ORDER BY priority ASC, created_at ASC`,
    [shopId],
  );
  if (rules.length === 0) return [];
  const targets = await exec.rows<{ rule_id: string; target_kind: "gid" | "handle"; target_value: string }>(
    `SELECT rule_id, target_kind, target_value FROM merch_rule_target WHERE shop_id=$1::uuid`,
    [shopId],
  );
  const byRule = new Map<string, MerchTargetInput[]>();
  for (const t of targets) {
    const arr = byRule.get(t.rule_id) ?? [];
    arr.push({ kind: t.target_kind, value: t.target_value });
    byRule.set(t.rule_id, arr);
  }
  return rules.map((r) => ({ ...r, targets: byRule.get(r.id) ?? [] }));
}

export interface CreateRuleInput {
  action: MerchAction;
  scopeType: MerchScopeType;
  scopeValue?: string | null;
  priority?: number;
  position?: number | null;
  weight?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  timezone?: string | null;
  experimentId?: string | null;
  variant?: "A" | "B" | null;
  targets: MerchTargetInput[];
}

function validateRule(input: CreateRuleInput): {
  scopeValue: string | null; priority: number; position: number | null; weight: number | null;
  startsAt: string | null; endsAt: string | null; targets: MerchTargetInput[];
} {
  if (!["pin", "boost", "demote", "hide"].includes(input.action)) throw new Error("invalid action");
  if (!["query_exact", "query_contains", "collection", "global"].includes(input.scopeType)) throw new Error("invalid scope");
  let scopeValue: string | null = input.scopeValue != null ? String(input.scopeValue).trim() : null;
  if (input.scopeType === "global") scopeValue = null;
  else if (!scopeValue) throw new Error(`scope '${input.scopeType}' needs a value`);
  if (scopeValue && scopeValue.length > 255) throw new Error("scope value too long (max 255)");

  const targets = (input.targets || [])
    .map((t) => ({ kind: t.kind === "handle" ? "handle" : "gid", value: String(t.value ?? "").trim() } as MerchTargetInput))
    .filter((t) => t.value.length > 0 && t.value.length <= 255);
  if (targets.length === 0) throw new Error("at least one target product is required");
  if (targets.length > MAX_TARGETS_PER_RULE) throw new Error(`too many targets (max ${MAX_TARGETS_PER_RULE})`);

  let priority = Math.floor(Number(input.priority));
  if (!Number.isFinite(priority)) priority = 100;
  priority = Math.max(0, Math.min(1_000_000, priority));

  let position: number | null = null;
  if (input.action === "pin") {
    position = Math.floor(Number(input.position ?? 1));
    if (!Number.isFinite(position) || position < 1) position = 1;
    position = Math.min(position, POSITION_MAX);
  }
  let weight: number | null = null;
  if (input.action === "boost" || input.action === "demote") {
    weight = Math.floor(Number(input.weight ?? WEIGHT_DEFAULT));
    if (!Number.isFinite(weight)) weight = WEIGHT_DEFAULT;
    weight = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, weight));
  }
  const startsAt = input.startsAt ? new Date(input.startsAt).toISOString() : null;
  const endsAt = input.endsAt ? new Date(input.endsAt).toISOString() : null;
  if (startsAt && endsAt && new Date(startsAt) >= new Date(endsAt)) throw new Error("start must be before end");
  return { scopeValue, priority, position, weight, startsAt, endsAt, targets };
}

export async function createRule(exec: Exec, shopId: string, input: CreateRuleInput): Promise<string> {
  const v = validateRule(input);
  const count = (await exec.rows<{ n: number }>(`SELECT count(*)::int AS n FROM merch_rule WHERE shop_id=$1::uuid`, [shopId]))[0].n;
  if (count >= MAX_RULES_PER_SHOP) throw new Error(`rule limit reached (${MAX_RULES_PER_SHOP})`);
  const variant = input.variant === "A" || input.variant === "B" ? input.variant : null;
  const experimentId = input.experimentId ? String(input.experimentId) : null;
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO merch_rule (shop_id, action, scope_type, scope_value, priority, position, weight,
       starts_at, ends_at, timezone, enabled, experiment_id, variant)
     VALUES ($1::uuid,$2,$3,$4,$5::int,$6::int,$7::int,$8::timestamptz,$9::timestamptz,$10,true,$11::uuid,$12)
     RETURNING id`,
    [shopId, input.action, input.scopeType, v.scopeValue, v.priority, v.position, v.weight,
      v.startsAt, v.endsAt, input.timezone ?? null, experimentId, variant],
  );
  const ruleId = rows[0].id;
  for (const t of v.targets) {
    await exec.run(
      `INSERT INTO merch_rule_target (shop_id, rule_id, target_kind, target_value) VALUES ($1::uuid,$2::uuid,$3,$4)`,
      [shopId, ruleId, t.kind, t.value],
    );
  }
  return ruleId;
}

export async function setRuleEnabled(exec: Exec, shopId: string, id: string, enabled: boolean): Promise<number> {
  return exec.run(`UPDATE merch_rule SET enabled=$3 WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id, enabled]);
}

export async function deleteRule(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM merch_rule WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

// ---- Plan resolution -------------------------------------------------------

export interface MerchContext {
  q: string;
  collectionGid: string | null;
  now: Date;
  token: string | null;
}

interface LoadedRule extends MerchRuleRow { targets: MerchTargetInput[]; }

/** True when a rule's scope matches the request (normalized, deterministic). */
export function ruleScopeMatches(rule: { scope_type: MerchScopeType; scope_value: string | null }, q: string, collectionGid: string | null): boolean {
  if (rule.scope_type === "global") return true;
  if (rule.scope_type === "collection") return !!collectionGid && rule.scope_value === collectionGid;
  const nq = normalizeQuery(q);
  const nv = normalizeQuery(rule.scope_value ?? "");
  if (nv.length === 0) return false;
  if (rule.scope_type === "query_exact") return nq === nv;
  return nq.includes(nv); // query_contains
}

const ACTION_RANK: Record<MerchAction, number> = { hide: 0, pin: 1, boost: 2, demote: 3 };

/**
 * Build the MerchPlan for a request. Pure given the rows it loads: one `now`
 * drives the schedule window (in SQL), deterministic A/B assignment drives
 * variant gating, and conflict resolution is fully ordered.
 */
export async function loadMerchPlan(
  exec: Exec, shopId: string, versionId: string, ctx: MerchContext,
): Promise<MerchPlan> {
  const running = await listRunningExperiments(exec, shopId);
  const assignMap = assignmentsFor(shopId, running, ctx.token);
  const overrideByExp = new Map(running.map((e) => [e.id, e]));

  // Enabled + schedule-active rules (single `now`), with their targets.
  const rows = await exec.rows<LoadedRule & { target_kind: "gid" | "handle" | null; target_value: string | null }>(
    `SELECT r.id, r.action, r.scope_type, r.scope_value, r.priority, r.position, r.weight,
            r.starts_at, r.ends_at, r.timezone, r.enabled, r.experiment_id, r.variant, r.created_at,
            t.target_kind, t.target_value
     FROM merch_rule r
     LEFT JOIN merch_rule_target t ON t.rule_id = r.id AND t.shop_id = r.shop_id
     WHERE r.shop_id=$1::uuid AND r.enabled=true
       AND (r.starts_at IS NULL OR r.starts_at <= $2::timestamptz)
       AND (r.ends_at IS NULL OR $2::timestamptz < r.ends_at)`,
    [shopId, ctx.now.toISOString()],
  );

  // Group targets per rule, keeping only rules whose scope + variant gate pass.
  const ruleMap = new Map<string, LoadedRule>();
  for (const row of rows) {
    let r = ruleMap.get(row.id);
    if (!r) {
      r = { ...row, targets: [] };
      ruleMap.set(row.id, r);
    }
    if (row.target_value) r.targets.push({ kind: row.target_kind as "gid" | "handle", value: row.target_value });
  }

  const activeRules: LoadedRule[] = [];
  for (const r of ruleMap.values()) {
    if (!ruleScopeMatches(r, ctx.q, ctx.collectionGid)) continue;
    if (r.variant) {
      // Variant rule: only when its experiment is running and the visitor is in
      // that variant. Stopped/draft experiments → variant rules are inert.
      if (!r.experiment_id || assignMap.get(r.experiment_id) !== r.variant) continue;
    }
    if (r.targets.length > 0) activeRules.push(r);
  }

  if (activeRules.length === 0) {
    return { ...EMPTY_MERCH_PLAN, assignments: [...assignMap].map(([experimentId, variant]) => ({ experimentId, variant })) };
  }

  // Resolve all target refs → product_ids (active-version docs; visibility is
  // enforced later by the planner, so drafts resolve but have no effect).
  const gids = [...new Set(activeRules.flatMap((r) => r.targets.filter((t) => t.kind === "gid").map((t) => t.value)))];
  const handles = [...new Set(activeRules.flatMap((r) => r.targets.filter((t) => t.kind === "handle").map((t) => t.value)))];
  const resolved = await exec.rows<{ product_id: string; gid: string; handle: string | null }>(
    `SELECT product_id, shopify_product_gid AS gid, doc->>'handle' AS handle
     FROM product_search_doc
     WHERE shop_id=$1::uuid AND index_version_id=$2::uuid
       AND (shopify_product_gid = ANY($3::text[]) OR doc->>'handle' = ANY($4::text[]))`,
    [shopId, versionId, gids.length ? gids : [""], handles.length ? handles : [""]],
  );
  const byGid = new Map<string, string>();
  const byHandle = new Map<string, string>();
  for (const r of resolved) {
    byGid.set(r.gid, r.product_id);
    if (r.handle) byHandle.set(r.handle, r.product_id);
  }
  const resolveTarget = (t: MerchTargetInput): string | undefined =>
    t.kind === "gid" ? byGid.get(t.value) : byHandle.get(t.value);

  // Per product, keep the winning candidate (action precedence, then priority,
  // then rule id). deterministic.
  interface Cand { action: MerchAction; ruleId: string; priority: number; position: number; delta: number; }
  const winner = new Map<string, Cand>();
  const better = (a: Cand, b: Cand): boolean => {
    if (ACTION_RANK[a.action] !== ACTION_RANK[b.action]) return ACTION_RANK[a.action] < ACTION_RANK[b.action];
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.ruleId < b.ruleId;
  };
  for (const r of activeRules) {
    const override = r.variant && r.experiment_id
      ? (r.variant === "A" ? overrideByExp.get(r.experiment_id)?.weight_override_a : overrideByExp.get(r.experiment_id)?.weight_override_b) ?? 0
      : 0;
    let delta = 0;
    if (r.action === "boost") delta = (r.weight ?? WEIGHT_DEFAULT) + override;
    else if (r.action === "demote") delta = -(r.weight ?? WEIGHT_DEFAULT) + override;
    delta = Math.max(-WEIGHT_MAX, Math.min(WEIGHT_MAX, delta));
    for (const t of r.targets) {
      const pid = resolveTarget(t);
      if (!pid) continue;
      const cand: Cand = { action: r.action, ruleId: r.id, priority: r.priority, position: r.position ?? 1, delta };
      const cur = winner.get(pid);
      if (!cur || better(cand, cur)) winner.set(pid, cand);
    }
  }

  const hideIds: string[] = [];
  const pins: { pid: string; position: number; priority: number; ruleId: string }[] = [];
  const deltaIds: string[] = [];
  const deltaVals: number[] = [];
  const annotations: Record<string, MerchAnnotation> = {};
  for (const [pid, c] of winner) {
    if (c.action === "hide") { hideIds.push(pid); annotations[pid] = { action: "hide", ruleId: c.ruleId }; }
    else if (c.action === "pin") { pins.push({ pid, position: c.position, priority: c.priority, ruleId: c.ruleId }); annotations[pid] = { action: "pin", ruleId: c.ruleId, position: c.position }; }
    else { deltaIds.push(pid); deltaVals.push(c.delta); annotations[pid] = { action: c.action, ruleId: c.ruleId, delta: c.delta }; }
  }
  pins.sort((a, b) => a.position - b.position || a.priority - b.priority || a.ruleId.localeCompare(b.ruleId));

  return {
    hideIds,
    pinIds: pins.map((p) => p.pid),
    deltaIds,
    deltaVals,
    annotations,
    assignments: [...assignMap].map(([experimentId, variant]) => ({ experimentId, variant })),
  };
}
