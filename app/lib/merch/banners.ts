import type { Exec } from "~/lib/db/executor";
import { normalizeQuery } from "~/lib/search/text";

/**
 * Merchandising banners / content blocks (Phase 8.3). Per-query or per-collection,
 * scheduled. image_url and link_path are validated server-side here (defense in
 * depth) and AGAIN in the storefront via the Phase 7.1 allowlist (which knows the
 * shop's real domains); text is bounded and rendered only via textContent.
 */

export const MAX_BANNERS_PER_SHOP = 200;
export const MAX_TITLE = 120;
export const MAX_BODY = 500;
export const MAX_ACTIVE_BANNERS = 3;

export type BannerScopeType = "query_exact" | "query_contains" | "collection";

export interface BannerRow {
  id: string;
  scope_type: BannerScopeType;
  scope_value: string;
  title: string;
  body: string;
  image_url: string | null;
  link_path: string | null;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
  created_at: string;
}

/** Public banner shape returned in the search payload. */
export interface Banner {
  title: string;
  body: string;
  imageUrl: string | null;
  linkPath: string | null;
}

/** Same-site path check (mirrors boost-core toSameSitePath's relative rule). */
export function isSameSitePath(p: string): boolean {
  if (!p) return false;
  if (p.charAt(0) !== "/") return false;
  if (p.charAt(1) === "/" || p.charAt(1) === "\\") return false;
  if (/[\u0000-\u001f]/.test(p) || /%0[9ad]/i.test(p)) return false;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(p)) return false;
  return true;
}

/** https image URL on an allowed host (cdn.shopify.com / *.myshopify.com), or a
 * same-site path. The storefront re-checks against the shop's real domains. */
export function isAllowedBannerImage(u: string): boolean {
  if (!u) return false;
  if (u.charAt(0) === "/") return isSameSitePath(u);
  let parsed: URL | null = null;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname.indexOf("%") >= 0) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return host === "cdn.shopify.com" || host.endsWith(".myshopify.com") || host.endsWith(".shopify.com");
}

export async function listBanners(exec: Exec, shopId: string): Promise<BannerRow[]> {
  return exec.rows<BannerRow>(
    `SELECT id, scope_type, scope_value, title, body, image_url, link_path, priority,
            starts_at, ends_at, enabled, created_at
     FROM merch_banner WHERE shop_id=$1::uuid ORDER BY priority ASC, created_at ASC`,
    [shopId],
  );
}

export interface CreateBannerInput {
  scopeType: BannerScopeType;
  scopeValue: string;
  title: string;
  body?: string;
  imageUrl?: string | null;
  linkPath?: string | null;
  priority?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

export async function createBanner(exec: Exec, shopId: string, input: CreateBannerInput): Promise<string> {
  if (!["query_exact", "query_contains", "collection"].includes(input.scopeType)) throw new Error("invalid scope");
  const scopeValue = String(input.scopeValue ?? "").trim();
  if (!scopeValue) throw new Error("scope value is required");
  if (scopeValue.length > 255) throw new Error("scope value too long");
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title is required");
  if (title.length > MAX_TITLE) throw new Error(`title too long (max ${MAX_TITLE})`);
  const body = String(input.body ?? "").trim();
  if (body.length > MAX_BODY) throw new Error(`body too long (max ${MAX_BODY})`);
  const imageUrl = input.imageUrl ? String(input.imageUrl).trim() : null;
  if (imageUrl && !isAllowedBannerImage(imageUrl)) throw new Error("image URL must be https on cdn.shopify.com / your shop domain, or a same-site path");
  const linkPath = input.linkPath ? String(input.linkPath).trim() : null;
  if (linkPath && !isSameSitePath(linkPath)) throw new Error("link must be a same-site path (starting with /)");

  const count = (await exec.rows<{ n: number }>(`SELECT count(*)::int AS n FROM merch_banner WHERE shop_id=$1::uuid`, [shopId]))[0].n;
  if (count >= MAX_BANNERS_PER_SHOP) throw new Error(`banner limit reached (${MAX_BANNERS_PER_SHOP})`);
  let priority = Math.floor(Number(input.priority));
  if (!Number.isFinite(priority)) priority = 100;
  const startsAt = input.startsAt ? new Date(input.startsAt).toISOString() : null;
  const endsAt = input.endsAt ? new Date(input.endsAt).toISOString() : null;
  if (startsAt && endsAt && new Date(startsAt) >= new Date(endsAt)) throw new Error("start must be before end");

  const rows = await exec.rows<{ id: string }>(
    `INSERT INTO merch_banner (shop_id, scope_type, scope_value, title, body, image_url, link_path, priority, starts_at, ends_at, enabled)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::int,$9::timestamptz,$10::timestamptz,true)
     RETURNING id`,
    [shopId, input.scopeType, scopeValue, title, body, imageUrl, linkPath, priority, startsAt, endsAt],
  );
  return rows[0].id;
}

export async function deleteBanner(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM merch_banner WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

export async function setBannerEnabled(exec: Exec, shopId: string, id: string, enabled: boolean): Promise<number> {
  return exec.run(`UPDATE merch_banner SET enabled=$3 WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id, enabled]);
}

/** Active banners for a request (scope + schedule), top N by priority. */
export async function loadActiveBanners(
  exec: Exec, shopId: string, ctx: { q: string; collectionGid: string | null; now: Date },
): Promise<Banner[]> {
  const rows = await exec.rows<BannerRow>(
    `SELECT id, scope_type, scope_value, title, body, image_url, link_path, priority, starts_at, ends_at, enabled, created_at
     FROM merch_banner
     WHERE shop_id=$1::uuid AND enabled=true
       AND (starts_at IS NULL OR starts_at <= $2::timestamptz)
       AND (ends_at IS NULL OR $2::timestamptz < ends_at)
     ORDER BY priority ASC, created_at ASC`,
    [shopId, ctx.now.toISOString()],
  );
  const nq = normalizeQuery(ctx.q);
  const out: Banner[] = [];
  for (const b of rows) {
    const nv = normalizeQuery(b.scope_value);
    let match = false;
    if (b.scope_type === "collection") match = !!ctx.collectionGid && b.scope_value === ctx.collectionGid;
    else if (b.scope_type === "query_exact") match = nv.length > 0 && nq === nv;
    else match = nv.length > 0 && nq.includes(nv);
    if (!match) continue;
    // Re-validate stored URLs before emitting (defense in depth).
    const imageUrl = b.image_url && isAllowedBannerImage(b.image_url) ? b.image_url : null;
    const linkPath = b.link_path && isSameSitePath(b.link_path) ? b.link_path : null;
    out.push({ title: b.title, body: b.body, imageUrl, linkPath });
    if (out.length >= MAX_ACTIVE_BANNERS) break;
  }
  return out;
}
