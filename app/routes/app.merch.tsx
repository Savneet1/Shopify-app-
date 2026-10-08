import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import {
  listRules, createRule, deleteRule, setRuleEnabled,
  MAX_RULES_PER_SHOP, WEIGHT_DEFAULT, type MerchTargetInput,
} from "~/lib/merch/rules";
import { listExperiments } from "~/lib/merch/experiments";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const [rules, experiments] = await withShopExec(shopId, async (e) => [
    await listRules(e, shopId),
    await listExperiments(e, shopId),
  ] as const);
  return { rules, experiments };
};

function parseTargets(raw: string): MerchTargetInput[] {
  return String(raw || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith("gid://") ? { kind: "gid", value: v } : { kind: "handle", value: v.replace(/^handle:/, "") } as MerchTargetInput));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "delete") {
      await withShopExec(shopId, (e) => deleteRule(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    if (intent === "toggle") {
      await withShopExec(shopId, (e) => setRuleEnabled(e, shopId, String(form.get("id")), String(form.get("enabled")) === "true"));
      return { ok: true };
    }
    const variantRaw = String(form.get("variant") || "");
    await withShopExec(shopId, (e) => createRule(e, shopId, {
      action: String(form.get("action")) as any,
      scopeType: String(form.get("scopeType")) as any,
      scopeValue: String(form.get("scopeValue") || ""),
      priority: Number(form.get("priority") || 100),
      position: Number(form.get("position") || 1),
      weight: Number(form.get("weight") || WEIGHT_DEFAULT),
      startsAt: String(form.get("startsAt") || "") || null,
      endsAt: String(form.get("endsAt") || "") || null,
      timezone: String(form.get("timezone") || "") || null,
      experimentId: String(form.get("experimentId") || "") || null,
      variant: variantRaw === "A" || variantRaw === "B" ? variantRaw : null,
      targets: parseTargets(String(form.get("targets") || "")),
    }));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Merch() {
  const { rules, experiments } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <>
      <TitleBar title="Merchandising" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 900 }}>
        <h1 style={{ marginTop: 0 }}>Merchandising rules</h1>
        <p style={{ color: "#555" }}>
          Pin, boost, demote or hide products for a query, a collection, or globally.
          Pin/boost/demote affect the <strong>relevance</strong> sort only; hide applies
          to every sort and removes the product from results, facet counts, predictive and
          suggestions (never from product pages). A pin/boost of a hidden, draft or
          out-of-scope product has no effect. <strong>Pin order</strong> sets the order
          among pinned products (1 = first); pinned products always appear at the top —
          pinning to an absolute Nth slot is not supported. Conflict order: hide &gt; pin
          &gt; boost &gt; demote, then lower priority wins. Max {MAX_RULES_PER_SHOP} rules.
        </p>

        <Form method="post" style={{ display: "grid", gap: 8, maxWidth: 640, marginBottom: 20, border: "1px solid #e3e3e3", borderRadius: 8, padding: 14 }}>
          <strong>New rule</strong>
          <label>Action{" "}
            <select name="action"><option value="pin">pin</option><option value="boost">boost</option><option value="demote">demote</option><option value="hide">hide</option></select>
          </label>
          <label>Scope{" "}
            <select name="scopeType"><option value="query_exact">query (exact)</option><option value="query_contains">query (contains)</option><option value="collection">collection (gid)</option><option value="global">global</option></select>
          </label>
          <input name="scopeValue" placeholder="scope value (query text or collection gid; blank for global)" />
          <textarea name="targets" placeholder="target products — one per line; gid://shopify/Product/123 or a product handle" rows={3} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label>priority <input name="priority" type="number" defaultValue={100} style={{ width: 80 }} /></label>
            <label title="1 = first among pinned products; pinned products always appear at the top">pin order <input name="position" type="number" defaultValue={1} style={{ width: 70 }} /></label>
            <label>weight (boost/demote 1–90) <input name="weight" type="number" defaultValue={WEIGHT_DEFAULT} style={{ width: 70 }} /></label>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label>starts <input name="startsAt" type="datetime-local" /></label>
            <label>ends <input name="endsAt" type="datetime-local" /></label>
            <input name="timezone" placeholder="IANA tz (e.g. Asia/Kolkata)" style={{ width: 160 }} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label>experiment{" "}
              <select name="experimentId"><option value="">— none —</option>{experiments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            </label>
            <label>variant{" "}
              <select name="variant"><option value="">always-on</option><option value="A">A</option><option value="B">B</option></select>
            </label>
          </div>
          <button type="submit" disabled={busy}>Add rule</button>
        </Form>

        <h2>Existing ({rules.length})</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {rules.map((r) => (
            <li key={r.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <code>{r.action}</code>{" · "}
              <code>{r.scope_type}{r.scope_value ? `: ${r.scope_value}` : ""}</code>{" · "}
              priority {r.priority}
              {r.action === "pin" && r.position != null ? ` · pin order ${r.position}` : ""}
              {(r.action === "boost" || r.action === "demote") && r.weight != null ? ` · weight ${r.weight}` : ""}
              {r.variant ? ` · variant ${r.variant}` : ""}
              {(r.starts_at || r.ends_at) ? ` · ${r.starts_at ?? "…"} → ${r.ends_at ?? "…"}` : ""}
              {!r.enabled ? " · (disabled)" : ""}
              <div style={{ color: "#666", fontSize: 13 }}>targets: {r.targets.map((t) => t.value).join(", ") || "—"}</div>
              <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                <Form method="post"><input type="hidden" name="intent" value="toggle" /><input type="hidden" name="id" value={r.id} /><input type="hidden" name="enabled" value={(!r.enabled).toString()} /><button disabled={busy}>{r.enabled ? "disable" : "enable"}</button></Form>
                <Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={r.id} /><button disabled={busy}>delete</button></Form>
              </div>
            </li>
          ))}
          {rules.length === 0 && <li>None yet.</li>}
        </ul>
        <p style={{ color: "#777", fontSize: 13 }}>
          Preview a rule&rsquo;s effect in the <a href="/app/search" target="_top">Search playground</a> —
          each result shows whether it was pinned, boosted or demoted and by which rule.
        </p>
      </main>
    </>
  );
}
