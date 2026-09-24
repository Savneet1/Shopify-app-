import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import { enqueueFullSync } from "~/lib/jobs/queue";
import { listDeadLetters, retryDeadLetter } from "~/lib/jobs/status.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);

  const dash = await withShopExec(shopId, async (e) => {
    const active = await getActiveVersion(e, shopId);
    const productCount = (
      await e.rows<{ n: number }>("SELECT count(*)::int n FROM product WHERE shop_id=$1::uuid AND deleted_at IS NULL", [shopId])
    )[0].n;
    const lastRun =
      (await e.rows<any>(
        `SELECT type, status, object_count, product_count, warning, started_at, finished_at, error
         FROM sync_run WHERE shop_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,
        [shopId],
      ))[0] ?? null;
    const versions = await e.rows<any>(
      `SELECT version, status, doc_count, activated_at FROM index_version WHERE shop_id=$1::uuid ORDER BY version DESC LIMIT 5`,
      [shopId],
    );
    const failures = await e.rows<any>(
      `SELECT stage, error, created_at FROM sync_failure WHERE shop_id=$1::uuid ORDER BY created_at DESC LIMIT 5`,
      [shopId],
    );
    const failedJobs = await e.rows<any>(
      `SELECT queue, dedupe_key, attempt, error, updated_at FROM job_audit WHERE shop_id=$1::uuid AND status='failed' ORDER BY updated_at DESC LIMIT 5`,
      [shopId],
    );
    return { active, productCount, lastRun, versions, failures, failedJobs };
  });

  const deadLetters = await listDeadLetters(shopId, 10);
  return { ...dash, deadLetters };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "retry") {
    const ok = await retryDeadLetter(shopId, String(form.get("jobId")));
    return { retried: ok };
  }
  await enqueueFullSync(shopId);
  return { queued: true };
};

export default function SyncDashboard() {
  const { productCount, active, lastRun, versions, failures, failedJobs, deadLetters } =
    useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <>
      <TitleBar title="Catalog sync & index" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 860 }}>
        <h1 style={{ marginTop: 0 }}>Catalog sync &amp; search index</h1>
        <p>
          Synced products: <strong>{productCount}</strong>. Active index:{" "}
          <strong>{active ? `v${active.version} (${active.doc_count} docs)` : "none yet"}</strong>.
        </p>
        <Form method="post">
          <button type="submit" disabled={busy}>{busy ? "Working…" : "Run full catalog sync"}</button>
        </Form>

        <h2>Last sync run</h2>
        {lastRun ? (
          <p>
            {lastRun.type} — <strong>{lastRun.status}</strong>
            {lastRun.product_count != null ? ` · ${lastRun.product_count} products` : ""}
            {lastRun.warning ? ` · ⚠ ${lastRun.warning}` : ""}
            {lastRun.error ? ` · ${lastRun.error}` : ""}
          </p>
        ) : (
          <p>No sync has run yet.</p>
        )}

        <h2>Recent index versions</h2>
        <ul>
          {versions.map((v: any) => (
            <li key={v.version}>v{v.version} — {v.status} — {v.doc_count} docs</li>
          ))}
          {versions.length === 0 && <li>None</li>}
        </ul>

        <h2>Failures</h2>
        {failures.length === 0 && failedJobs.length === 0 ? (
          <p>No recent failures.</p>
        ) : (
          <ul>
            {failedJobs.map((j: any, i: number) => (
              <li key={"j" + i}>job {j.queue} (attempt {j.attempt}) — {j.error}</li>
            ))}
            {failures.map((f: any, i: number) => (
              <li key={"f" + i}>sync {f.stage} — {f.error}</li>
            ))}
          </ul>
        )}

        <h2>Dead-letter queue ({deadLetters.length})</h2>
        {deadLetters.length === 0 ? (
          <p>Empty.</p>
        ) : (
          <ul>
            {deadLetters.map((d) => (
              <li key={d.id}>
                {d.name} — {d.data?.entity ?? "full-sync"} {d.data?.gid ?? ""}
                <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                  <input type="hidden" name="intent" value="retry" />
                  <input type="hidden" name="jobId" value={d.id} />
                  <button type="submit" disabled={busy}>Retry</button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
