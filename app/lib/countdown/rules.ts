import type { Exec } from "~/lib/db/executor";

/**
 * Phase 12.5 — merchant-defined countdown timers (DISPLAY ONLY; no price or
 * checkout effect). A rule targets a product, a collection, or is global, and
 * counts down to a UTC end timestamp. The server provides the end time AND a
 * server "now" so the client can correct for clock skew; the client shows
 * nothing before the window opens and, after expiry, either nothing or the
 * merchant's expired message.
 */

export type CountdownScope = "product" | "collection" | "global";

export interface CountdownRule {
  id: string;
  scope: CountdownScope;
  matchValue: string | null; // gid/handle (product) or collection gid; null for global
  label: string | null;
  endsAt: string;            // ISO UTC
  startsAt: string | null;
  expiredMessage: string | null;
  enabled: boolean;
}

export interface CountdownTarget { gid: string; handle: string | null; collectionGids: string[]; }

export interface CountdownPayload {
  endsAt: string;
  serverNow: string;
  label: string | null;
  expiredMessage: string | null;
  expired: boolean;
}

/** A countdown is shown once its window has opened (now >= startsAt, or no
 * start). Before that it is hidden. After endsAt it is "expired" (the client
 * shows the expired message or nothing). */
export function windowOpen(rule: CountdownRule, now: Date): boolean {
  if (!rule.enabled) return false;
  if (rule.startsAt && now.getTime() < new Date(rule.startsAt).getTime()) return false;
  return true;
}

function ruleMatches(rule: CountdownRule, t: CountdownTarget): boolean {
  switch (rule.scope) {
    case "global": return true;
    case "product":
      if (!rule.matchValue) return false;
      return rule.matchValue === t.gid || (t.handle != null && rule.matchValue.toLowerCase() === t.handle.toLowerCase());
    case "collection":
      return rule.matchValue != null && t.collectionGids.includes(rule.matchValue);
    default: return false;
  }
}

const SCOPE_SPECIFICITY: Record<CountdownScope, number> = { product: 0, collection: 1, global: 2 };

/** Resolve the single applicable countdown for a target (most specific scope,
 * then soonest end). Returns null when none applies / window not open. Pure. */
export function countdownForTarget(
  rules: CountdownRule[], t: CountdownTarget, now: Date,
): CountdownPayload | null {
  const applicable = rules
    .filter((r) => windowOpen(r, now) && ruleMatches(r, t))
    .sort((a, b) =>
      SCOPE_SPECIFICITY[a.scope] - SCOPE_SPECIFICITY[b.scope] ||
      new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime());
  const r = applicable[0];
  if (!r) return null;
  return {
    endsAt: r.endsAt,
    serverNow: now.toISOString(),
    label: r.label,
    expiredMessage: r.expiredMessage,
    expired: now.getTime() >= new Date(r.endsAt).getTime(),
  };
}

// ---- storage -------------------------------------------------------------

function mapRow(r: any): CountdownRule {
  return {
    id: r.id, scope: r.scope, matchValue: r.match_value, label: r.label,
    endsAt: new Date(r.ends_at).toISOString(),
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    expiredMessage: r.expired_message, enabled: r.enabled,
  };
}

export async function listCountdownRules(exec: Exec, shopId: string): Promise<CountdownRule[]> {
  const rows = await exec.rows<any>(
    `SELECT id, scope, match_value, label, ends_at, starts_at, expired_message, enabled
     FROM countdown_rule WHERE shop_id=$1::uuid ORDER BY created_at ASC`,
    [shopId],
  );
  return rows.map(mapRow);
}

export async function loadEnabledCountdownRules(exec: Exec, shopId: string): Promise<CountdownRule[]> {
  const rows = await exec.rows<any>(
    `SELECT id, scope, match_value, label, ends_at, starts_at, expired_message, enabled
     FROM countdown_rule WHERE shop_id=$1::uuid AND enabled=true ORDER BY created_at ASC`,
    [shopId],
  );
  return rows.map(mapRow);
}

export interface CountdownRuleInput {
  scope: CountdownScope;
  matchValue?: string | null;
  label?: string | null;
  endsAt: string;
  startsAt?: string | null;
  expiredMessage?: string | null;
  enabled?: boolean;
}

const SCOPES = new Set(["product", "collection", "global"]);

function validate(input: CountdownRuleInput): { ok: true } | { ok: false; error: string } {
  if (!SCOPES.has(input.scope)) return { ok: false, error: "invalid scope" };
  if (input.scope !== "global" && (!input.matchValue || input.matchValue.length < 1 || input.matchValue.length > 500)) {
    return { ok: false, error: "match_value required for product/collection scope" };
  }
  if (!input.endsAt || Number.isNaN(new Date(input.endsAt).getTime())) return { ok: false, error: "invalid ends_at" };
  if (input.startsAt != null && input.startsAt !== "" && Number.isNaN(new Date(input.startsAt).getTime())) return { ok: false, error: "invalid starts_at" };
  if (input.label != null && input.label.length > 120) return { ok: false, error: "label too long" };
  if (input.expiredMessage != null && input.expiredMessage.length > 200) return { ok: false, error: "expired_message too long" };
  return { ok: true };
}

export async function createCountdownRule(exec: Exec, shopId: string, input: CountdownRuleInput): Promise<{ id: string } | { error: string }> {
  const v = validate(input);
  if (!v.ok) return { error: v.error };
  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO countdown_rule (shop_id, scope, match_value, label, ends_at, starts_at, expired_message, enabled)
     VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8) RETURNING id`,
    [shopId, input.scope, input.scope === "global" ? null : nz(input.matchValue), nz(input.label),
     input.endsAt, nz(input.startsAt), nz(input.expiredMessage), input.enabled !== false],
  );
  return { id: rows[0].id };
}

export async function updateCountdownRule(exec: Exec, shopId: string, id: string, input: CountdownRuleInput): Promise<{ ok: boolean } | { error: string }> {
  const v = validate(input);
  if (!v.ok) return { error: v.error };
  const n = await exec.run(
    `UPDATE countdown_rule SET scope=$3, match_value=$4, label=$5, ends_at=$6::timestamptz,
       starts_at=$7::timestamptz, expired_message=$8, enabled=$9, updated_at=now()
     WHERE shop_id=$1::uuid AND id=$2::uuid`,
    [shopId, id, input.scope, input.scope === "global" ? null : nz(input.matchValue), nz(input.label),
     input.endsAt, nz(input.startsAt), nz(input.expiredMessage), input.enabled !== false],
  );
  return { ok: n > 0 };
}

export async function deleteCountdownRule(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM countdown_rule WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

function nz(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}
