import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { listSynonyms, addSynonym, deleteSynonym, MAX_SYNONYMS_PER_SHOP } from "~/lib/search/synonyms";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const rows = await withShopExec(shopId, (e) => listSynonyms(e, shopId));
  return { rows };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "delete") {
      await withShopExec(shopId, (e) => deleteSynonym(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    const kind = String(form.get("kind")) === "one_way" ? "one_way" : "two_way";
    const terms = String(form.get("terms") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const fromTerm = String(form.get("fromTerm") || "");
    await withShopExec(shopId, (e) => addSynonym(e, shopId, { kind, fromTerm, terms }));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Synonyms() {
  const { rows } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <>
      <TitleBar title="Synonyms" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 760 }}>
        <h1 style={{ marginTop: 0 }}>Synonyms</h1>
        <p style={{ color: "#555" }}>Applied at query time. Two-way: all terms are equivalent. One-way: the from-term expands to the targets. Terms are comma-separated; multi-word terms are allowed. Max {MAX_SYNONYMS_PER_SHOP} per shop.</p>
        <Form method="post" style={{ display: "grid", gap: 8, maxWidth: 520, marginBottom: 20 }}>
          <label>Kind:{" "}
            <select name="kind"><option value="two_way">two-way (a ⇔ b ⇔ c)</option><option value="one_way">one-way (a → b)</option></select>
          </label>
          <input name="fromTerm" placeholder="from-term (one-way only)" />
          <input name="terms" placeholder="terms, comma-separated (e.g. sofa, couch, settee)" />
          <button type="submit" disabled={busy}>Add synonym</button>
        </Form>
        <h2>Existing ({rows.length})</h2>
        <ul>
          {rows.map((r) => (
            <li key={r.id} style={{ marginBottom: 4 }}>
              <code>{r.kind}</code>{r.from_term ? ` ${r.from_term} →` : ""} {r.terms.join(", ")}
              <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" disabled={busy}>delete</button>
              </Form>
            </li>
          ))}
          {rows.length === 0 && <li>None yet.</li>}
        </ul>
      </main>
    </>
  );
}
