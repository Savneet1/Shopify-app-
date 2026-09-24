import type { Exec } from "~/lib/db/executor";

/** True if the shop row exists and is not uninstalled. Used to DROP (not retry)
 * background jobs for shops that have been removed/redacted. */
export async function isShopInstalled(exec: Exec, shopId: string): Promise<boolean> {
  const rows = await exec.rows<{ uninstalled_at: string | null }>(
    `SELECT uninstalled_at FROM shop WHERE id=$1::uuid`,
    [shopId],
  );
  return rows.length > 0 && rows[0].uninstalled_at == null;
}
