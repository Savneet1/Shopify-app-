import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { listStopwords, addStopwordOverride, deleteStopwordOverride, DEFAULT_STOPWORDS } from "~/lib/search/stopwords";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const rows = await withShopExec(shopId, (e) => listStopwords(e, shopId));
  return { rows, defaults: DEFAULT_STOPWORDS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  try {
    if (form.get("intent") === "delete") {
      await withShopExec(shopId, (e) => deleteStopwordOverride(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    const mode = String(form.get("mode")) === "remove" ? "remove" : "add";
    await withShopExec(shopId, (e) => addStopwordOverride(e, shopId, String(form.get("word") || ""), mode));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Stopwords() {
  const { rows, defaults } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <>
      <TitleBar title="Stop words" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 760 }}>
        <h1 style={{ marginTop: 0 }}>Stop words</h1>
        <p style={{ color: "#555" }}>Ignored in matching when at least one non-stop term remains. Add a custom stop word, or remove a default one for this shop.</p>
        <Form method="post" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input name="word" placeholder="word" />
          <select name="mode"><option value="add">add (make it a stop word)</option><option value="remove">remove (un-stop a default)</option></select>
          <button type="submit" disabled={busy}>Save</button>
        </Form>
        <h2>Overrides ({rows.length})</h2>
        <ul>
          {rows.map((r) => (
            <li key={r.id}><code>{r.mode}</code> {r.word}
              <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={r.id} />
                <button type="submit" disabled={busy}>delete</button>
              </Form>
            </li>
          ))}
          {rows.length === 0 && <li>None.</li>}
        </ul>
        <details style={{ marginTop: 12 }}>
          <summary>Default stop words ({defaults.length})</summary>
          <p style={{ color: "#888", fontSize: 13 }}>{defaults.join(", ")}</p>
        </details>
      </main>
    </>
  );
}
