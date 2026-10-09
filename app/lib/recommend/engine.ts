import type { Exec } from "~/lib/db/executor";
import { getActiveVersion } from "~/lib/index/engine";
import { loadMerchPlan } from "~/lib/merch/rules";
import { classifyRef, parseRecentRefs } from "./refs";
import {
  recommendContent, resolveRefsToProductIds, cardsByProductIds,
  MAX_REC_LIMIT, type ContentCard, type ContentKind,
} from "./content";
import { trending } from "./signals";
import { frequentlyBoughtTogether, DEFAULT_MIN_SUPPORT, DEFAULT_MIN_CONFIDENCE, type FbtRanking } from "./cooccurrence";
import { loadSettings, type RecommendationSettings } from "./settings";

/**
 * Phase 9 recommendations orchestrator. One entry point for every type; applies
 * the shop's settings (enable flags, OOS policy, diversification, FBT fallback,
 * trending half-life), the Phase 8 GLOBAL hide rules (a globally-hidden product
 * is never recommended), and the client-supplied "recently viewed" list (as an
 * exclusion, and as the source for type=recent). Reads ONLY the active index
 * version's visible docs. Never throws for bad input — bad seeds yield [].
 */

export type RecType = "similar" | "related" | "trending" | "fbt" | "recent";
export const REC_TYPES: readonly RecType[] = ["similar", "related", "trending", "fbt", "recent"];

export function normalizeRecType(v: unknown): RecType | null {
  return REC_TYPES.includes(v as RecType) ? (v as RecType) : null;
}

export interface RecRequest {
  type: RecType;
  seed?: unknown;
  recent?: unknown;
  limit?: number;
  explain?: boolean;
  fbtRanking?: FbtRanking;
  now?: Date;
}

export interface RecResponse {
  type: RecType;
  seed: string | null;
  products: ContentCard[];
  fellBackTo: RecType | null;
  reason: string | null;
}

function clampLimit(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 12;
  return v > MAX_REC_LIMIT ? MAX_REC_LIMIT : v;
}

async function contentFor(
  exec: Exec, shopId: string, versionId: string, kind: ContentKind, seedRaw: unknown,
  limit: number, settings: RecommendationSettings, hideIds: string[], excludeProductIds: string[], explain: boolean,
): Promise<ContentCard[]> {
  const ref = classifyRef(seedRaw);
  if (!ref) return [];
  return recommendContent(exec, shopId, versionId, [ref], {
    kind, limit, includeOutOfStock: settings.includeOutOfStock,
    diversifyPerVendor: settings.diversifyPerVendor, hideIds, excludeProductIds, explain,
  });
}

export async function getRecommendations(
  exec: Exec, shopId: string, req: RecRequest,
): Promise<RecResponse> {
  const limit = clampLimit(req.limit);
  const explain = req.explain === true;
  const now = req.now ?? new Date();
  const seedRef = classifyRef(req.seed);
  const seedEcho = seedRef ? seedRef.value : null;
  const empty = (reason: string | null, fellBackTo: RecType | null = null): RecResponse => ({
    type: req.type, seed: seedEcho, products: [], fellBackTo, reason,
  });

  // Bound every recommendation query (never hang the storefront proxy).
  const timeout = Math.max(100, Math.min(Number(process.env.SEARCH_STATEMENT_TIMEOUT_MS || 3000), 10000));
  await exec.run(`SET LOCAL statement_timeout = ${timeout}`);

  const active = await getActiveVersion(exec, shopId);
  if (!active) return empty("no-active");
  const versionId = active.id;

  const settings = await loadSettings(exec, shopId);

  // Phase 8 GLOBAL hide rules (q="" / collection=null → only global hides match).
  const merch = await loadMerchPlan(exec, shopId, versionId, { q: "", collectionGid: null, now, token: null });
  const hideIds = merch.hideIds;

  // Recently-viewed (client-supplied) → product ids, used as exclusions and as
  // the source for type=recent. The server stores NOTHING.
  const recentRefs = parseRecentRefs(req.recent);
  const recentIds = recentRefs.length
    ? await resolveRefsToProductIds(exec, shopId, versionId, recentRefs)
    : [];
  // Exclude already-viewed and the seed itself from generated shelves.
  const seedId = seedRef ? (await resolveRefsToProductIds(exec, shopId, versionId, [seedRef]))[0] ?? null : null;
  const baseExclude = [...new Set([...recentIds, ...(seedId ? [seedId] : [])])];

  switch (req.type) {
    case "similar": {
      if (!settings.similarEnabled) return empty("disabled");
      const products = await contentFor(exec, shopId, versionId, "similar", req.seed, limit, settings, hideIds, recentIds, explain);
      return { type: "similar", seed: seedEcho, products, fellBackTo: null, reason: products.length ? null : "empty" };
    }
    case "related": {
      if (!settings.relatedEnabled) return empty("disabled");
      const products = await contentFor(exec, shopId, versionId, "related", req.seed, limit, settings, hideIds, recentIds, explain);
      return { type: "related", seed: seedEcho, products, fellBackTo: null, reason: products.length ? null : "empty" };
    }
    case "trending": {
      if (!settings.trendingEnabled) return empty("disabled");
      const products = await trending(exec, shopId, versionId, {
        limit, includeOutOfStock: settings.includeOutOfStock, hideIds,
        excludeProductIds: baseExclude, halfLifeDays: settings.trendingHalfLifeDays, now,
      });
      return { type: "trending", seed: seedEcho, products, fellBackTo: null, reason: products.length ? null : "empty" };
    }
    case "fbt": {
      // No approved orders source → fbtEnabled defaults false. When disabled or
      // when enabled-but-no-data, degrade to related products if the merchant
      // opted into the fallback; otherwise return [].
      const runFbt = settings.fbtEnabled
        ? await frequentlyBoughtTogether(exec, shopId, versionId, req.seed, {
            limit, minSupport: DEFAULT_MIN_SUPPORT, minConfidence: DEFAULT_MIN_CONFIDENCE,
            ranking: req.fbtRanking === "lift" ? "lift" : "confidence",
            includeOutOfStock: settings.includeOutOfStock, hideIds, excludeProductIds: recentIds,
          })
        : [];
      if (runFbt.length > 0) {
        return { type: "fbt", seed: seedEcho, products: runFbt, fellBackTo: null, reason: null };
      }
      if (settings.fbtFallbackRelated && settings.relatedEnabled) {
        const rel = await contentFor(exec, shopId, versionId, "related", req.seed, limit, settings, hideIds, recentIds, explain);
        return { type: "fbt", seed: seedEcho, products: rel, fellBackTo: "related", reason: settings.fbtEnabled ? "fbt-no-data" : "fbt-disabled" };
      }
      return empty(settings.fbtEnabled ? "fbt-no-data" : "fbt-disabled");
    }
    case "recent": {
      if (!settings.recentEnabled) return empty("disabled");
      // List the recently-viewed products themselves (in order), excluding the
      // current seed. Server stores nothing — the ids came from the request.
      const ids = recentIds.filter((id) => id !== seedId).slice(0, limit);
      const products = await cardsByProductIds(exec, shopId, versionId, ids, {
        includeOutOfStock: settings.includeOutOfStock, hideIds,
      });
      return { type: "recent", seed: seedEcho, products, fellBackTo: null, reason: products.length ? null : "empty" };
    }
    default:
      return empty("unknown-type");
  }
}
