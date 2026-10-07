import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import {
  listAttributeTerms, addAttributeTerm, deleteAttributeTerm,
  DEFAULT_ATTRIBUTES, type AttrFacet,
} from "~/lib/search/attributes";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const rows = await withShopExec(shopId, (e) => listAttributeTerms(e, shopId));
  return { rows, defaults: Object.entries(DEFAULT_ATTRIBUTES).map(([phrase, m]) => ({ phrase, ...m })) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  try {
    if (form.get("intent") === "delete") {
      await withShopExec(shopId, (e) => deleteAttributeTerm(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    const facet = String(form.get("facet")) as AttrFacet;
    await withShopExec(shopId, (e) => addAttributeTerm(e, shopId, String(form.get("phrase") || ""), facet, String(form.get("value") || "")));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Attributes() {
  const { rows, defaults } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <>
      <TitleBar title="Attribute dictionary" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 820 }}>
        <h1 style={{ marginTop: 0 }}>Attribute dictionary (NL search)</h1>
        <p style={{ color: "#555" }}>
          Maps words in a shopper's natural-language query onto an existing facet. For
          example “red” → tag <code>red</code>, “cotton” → material metafield. Per-shop
          entries override the English defaults by phrase. Values are applied through the
          same filter validation as manual filters.
        </p>
        <Form method="post" style={{ display: "grid", gap: 8, maxWidth: 560, marginBottom: 16 }}>
          <input name="phrase" placeholder="phrase (e.g. crimson)" />
          <label>Facet:{" "}
            <select name="facet">
              <option value="tags">tags</option>
              <option value="metafield">metafield (material)</option>
              <option value="product_type">product type</option>
              <option value="vendor">vendor</option>
            </select>
          </label>
          <input name="value" placeholder="value (e.g. red)" />
          <button type="submit" disabled={busy}>Add / override</button>
        </Form>
        <h2>Shop overrides ({rows.length})</h2>
        <ul>
          {rows.map((r) => (
            <li key={r.id}><strong>{r.phrase}</strong> → <code>{r.facet}</code> = {r.value}
              <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={r.id} />
                <button type="submit" disabled={busy}>delete</button>
              </Form>
            </li>
          ))}
          {rows.length === 0 && <li>None — the English defaults below apply.</li>}
        </ul>
        <details style={{ marginTop: 12 }}>
          <summary>Built-in defaults ({defaults.length})</summary>
          <ul style={{ color: "#777", fontSize: 13 }}>
            {defaults.map((d) => <li key={d.phrase}>{d.phrase} → {d.facet} = {d.value}</li>)}
          </ul>
        </details>
      </main>
    </>
  );
}
