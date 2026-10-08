import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { listBanners, createBanner, deleteBanner, setBannerEnabled, MAX_BANNERS_PER_SHOP } from "~/lib/merch/banners";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const rows = await withShopExec(shopId, (e) => listBanners(e, shopId));
  return { rows };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "delete") {
      await withShopExec(shopId, (e) => deleteBanner(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    if (intent === "toggle") {
      await withShopExec(shopId, (e) => setBannerEnabled(e, shopId, String(form.get("id")), String(form.get("enabled")) === "true"));
      return { ok: true };
    }
    await withShopExec(shopId, (e) => createBanner(e, shopId, {
      scopeType: String(form.get("scopeType")) as any,
      scopeValue: String(form.get("scopeValue") || ""),
      title: String(form.get("title") || ""),
      body: String(form.get("body") || ""),
      imageUrl: String(form.get("imageUrl") || "") || null,
      linkPath: String(form.get("linkPath") || "") || null,
      priority: Number(form.get("priority") || 100),
      startsAt: String(form.get("startsAt") || "") || null,
      endsAt: String(form.get("endsAt") || "") || null,
    }));
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Banners() {
  const { rows } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <>
      <TitleBar title="Banners" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 820 }}>
        <h1 style={{ marginTop: 0 }}>Search &amp; collection banners</h1>
        <p style={{ color: "#555" }}>
          A content block shown above results for a query or collection. Image URL must be
          https on <code>cdn.shopify.com</code> or your shop&rsquo;s domain; link must be a
          same-site path (starting with <code>/</code>); text is rendered as plain text only.
          Max {MAX_BANNERS_PER_SHOP}.
        </p>
        <Form method="post" style={{ display: "grid", gap: 8, maxWidth: 560, marginBottom: 20, border: "1px solid #e3e3e3", borderRadius: 8, padding: 14 }}>
          <strong>New banner</strong>
          <label>Scope{" "}
            <select name="scopeType"><option value="query_exact">query (exact)</option><option value="query_contains">query (contains)</option><option value="collection">collection (gid)</option></select>
          </label>
          <input name="scopeValue" placeholder="query text or collection gid" />
          <input name="title" placeholder="title" maxLength={120} />
          <textarea name="body" placeholder="body text (optional)" rows={2} maxLength={500} />
          <input name="imageUrl" placeholder="https://cdn.shopify.com/... (optional)" />
          <input name="linkPath" placeholder="/collections/sale (optional, same-site)" />
          <div style={{ display: "flex", gap: 8 }}>
            <label>priority <input name="priority" type="number" defaultValue={100} style={{ width: 80 }} /></label>
            <label>starts <input name="startsAt" type="datetime-local" /></label>
            <label>ends <input name="endsAt" type="datetime-local" /></label>
          </div>
          <button type="submit" disabled={busy}>Add banner</button>
        </Form>
        <h2>Existing ({rows.length})</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {rows.map((b) => (
            <li key={b.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <strong>{b.title}</strong> · <code>{b.scope_type}: {b.scope_value}</code>{!b.enabled ? " · (disabled)" : ""}
              {b.body ? <div style={{ color: "#555" }}>{b.body}</div> : null}
              {b.image_url ? <div style={{ color: "#888", fontSize: 12 }}>img: {b.image_url}</div> : null}
              {b.link_path ? <div style={{ color: "#888", fontSize: 12 }}>link: {b.link_path}</div> : null}
              <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                <Form method="post"><input type="hidden" name="intent" value="toggle" /><input type="hidden" name="id" value={b.id} /><input type="hidden" name="enabled" value={(!b.enabled).toString()} /><button disabled={busy}>{b.enabled ? "disable" : "enable"}</button></Form>
                <Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={b.id} /><button disabled={busy}>delete</button></Form>
              </div>
            </li>
          ))}
          {rows.length === 0 && <li>None yet.</li>}
        </ul>
      </main>
    </>
  );
}
