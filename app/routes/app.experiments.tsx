import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import {
  listExperiments, createExperiment, setExperimentStatus, deleteExperiment, exposureReport,
  MAX_EXPERIMENTS_PER_SHOP, WEIGHT_OVERRIDE_BOUND,
} from "~/lib/merch/experiments";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const [experiments, report] = await withShopExec(shopId, async (e) => [
    await listExperiments(e, shopId),
    await exposureReport(e, shopId),
  ] as const);
  return { experiments, report };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "delete") {
      await withShopExec(shopId, (e) => deleteExperiment(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    if (intent === "status") {
      await withShopExec(shopId, (e) => setExperimentStatus(e, shopId, String(form.get("id")), String(form.get("status")) as any));
      return { ok: true };
    }
    await withShopExec(shopId, (e) => createExperiment(e, shopId, {
      name: String(form.get("name") || ""),
      splitPct: Number(form.get("splitPct") || 50),
      weightOverrideA: form.get("weightOverrideA"),
      weightOverrideB: form.get("weightOverrideB"),
    }));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Experiments() {
  const { experiments, report } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const byExp = new Map<string, typeof report>();
  for (const r of report) {
    const arr = byExp.get(r.experiment_id) ?? [];
    arr.push(r);
    byExp.set(r.experiment_id, arr);
  }
  return (
    <>
      <TitleBar title="A/B experiments" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 860 }}>
        <h1 style={{ marginTop: 0 }}>A/B experiments</h1>
        <p style={{ color: "#555" }}>
          Assign visitors deterministically to variant A or B (a rule set, optionally with a
          bounded ranking-weight override of ±{WEIGHT_OVERRIDE_BOUND}); visitors with no token are
          control. Tag merchandising rules with a variant to include them. Only aggregate
          exposures and clicks are recorded — no per-visitor data, no significance testing.
          Stopping an experiment restores the default rule set immediately. Max {MAX_EXPERIMENTS_PER_SHOP}.
        </p>

        <Form method="post" style={{ display: "grid", gap: 8, maxWidth: 520, marginBottom: 20, border: "1px solid #e3e3e3", borderRadius: 8, padding: 14 }}>
          <strong>New experiment</strong>
          <input name="name" placeholder="name" maxLength={120} />
          <label>split % to B <input name="splitPct" type="number" defaultValue={50} min={0} max={100} style={{ width: 80 }} /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <label>weight override A <input name="weightOverrideA" type="number" style={{ width: 80 }} /></label>
            <label>weight override B <input name="weightOverrideB" type="number" style={{ width: 80 }} /></label>
          </div>
          <button type="submit" disabled={busy}>Create (draft)</button>
        </Form>

        <h2>Experiments ({experiments.length})</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {experiments.map((x) => {
            const rows = byExp.get(x.id) ?? [];
            return (
              <li key={x.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <strong>{x.name}</strong> · <code>{x.status}</code> · {x.split_pct}% → B
                {x.weight_override_a != null ? ` · A override ${x.weight_override_a}` : ""}
                {x.weight_override_b != null ? ` · B override ${x.weight_override_b}` : ""}
                <table style={{ marginTop: 6, fontSize: 13, borderCollapse: "collapse" }}>
                  <thead><tr><th style={{ textAlign: "left", paddingRight: 12 }}>variant</th><th style={{ paddingRight: 12 }}>exposures</th><th style={{ paddingRight: 12 }}>clicks</th><th>CTR</th></tr></thead>
                  <tbody>
                    {rows.filter((r) => r.variant).map((r) => (
                      <tr key={r.variant}>
                        <td>{r.variant}</td><td style={{ textAlign: "right" }}>{r.exposures}</td><td style={{ textAlign: "right" }}>{r.clicks}</td>
                        <td style={{ textAlign: "right" }}>{r.exposures > 0 ? ((r.clicks / r.exposures) * 100).toFixed(1) + "%" : "—"}</td>
                      </tr>
                    ))}
                    {rows.filter((r) => r.variant).length === 0 && <tr><td colSpan={4} style={{ color: "#999" }}>no exposures yet</td></tr>}
                  </tbody>
                </table>
                <div style={{ color: "#a15c00", fontSize: 12 }}>Not statistically tested — exposures/clicks/CTR only (conversion &amp; revenue arrive with Phase 11 analytics).</div>
                <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                  {(["draft", "running", "stopped"] as const).map((s) => (
                    <Form method="post" key={s}><input type="hidden" name="intent" value="status" /><input type="hidden" name="id" value={x.id} /><input type="hidden" name="status" value={s} /><button disabled={busy || x.status === s}>{s}</button></Form>
                  ))}
                  <Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={x.id} /><button disabled={busy}>delete</button></Form>
                </div>
              </li>
            );
          })}
          {experiments.length === 0 && <li>None yet.</li>}
        </ul>
      </main>
    </>
  );
}
