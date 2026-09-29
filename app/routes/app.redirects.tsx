import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { listRedirects, addRedirect, deleteRedirect } from "~/lib/search/redirects";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const rows = await withShopExec(shopId, (e) => listRedirects(e, shopId));
  return { rows };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  try {
    if (form.get("intent") === "delete") {
      await withShopExec(shopId, (e) => deleteRedirect(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    await withShopExec(shopId, (e) => addRedirect(e, shopId, String(form.get("query") || ""), String(form.get("destination") || "")));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Redirects() {
  const { rows } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <>
      <TitleBar title="Redirects" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 760 }}>
        <h1 style={{ marginTop: 0 }}>Search redirects</h1>
        <p style={{ color: "#555" }}>When a shopper's (normalized) query matches exactly, the API returns this destination. The destination must be a same-shop relative path (e.g. <code>/collections/sale</code>) or an https URL on your own domain. External and javascript:/data: destinations are rejected.</p>
        <Form method="post" style={{ display: "grid", gap: 8, maxWidth: 520, marginBottom: 16 }}>
          <input name="query" placeholder="query (e.g. sale)" />
          <input name="destination" placeholder="/collections/sale" />
          <button type="submit" disabled={busy}>Add redirect</button>
        </Form>
        <h2>Existing ({rows.length})</h2>
        <ul>
          {rows.map((r) => (
            <li key={r.id}><strong>{r.query_normalized}</strong> → {r.destination}
              <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={r.id} />
                <button type="submit" disabled={busy}>delete</button>
              </Form>
            </li>
          ))}
          {rows.length === 0 && <li>None.</li>}
        </ul>
      </main>
    </>
  );
}
