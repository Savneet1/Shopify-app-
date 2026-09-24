import { withShopExec } from "~/lib/tenant.server";
import { rollbackToVersion } from "./engine";
import { enqueueFullSync } from "~/lib/jobs/queue";

/**
 * Roll back to a retained prior index version, then schedule a fresh full
 * rebuild. Retained versions are STALE relative to the current catalog (they
 * were built from an older snapshot), so rollback is a stop-gap: it restores a
 * known-good index immediately while a new correct version is rebuilt in the
 * background (build -> validate -> atomic swap). See docs/PHASE2.md.
 */
export async function rollbackAndScheduleRebuild(
  shopId: string,
  targetVersionId: string,
): Promise<void> {
  await withShopExec(shopId, (e) => rollbackToVersion(e, shopId, targetVersionId));
  await enqueueFullSync(shopId).catch(() => {
    /* enqueue is best-effort; a manual "Run full sync" also rebuilds */
  });
}
