import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { getActiveVersion } from "~/lib/index/engine";
import {
  listBundles, createBundle, updateBundle, deleteBundle, setBundleStatus, getBundle,
  MAX_SLOTS, type BundleInput, type SlotInput, BundleValidationError,
} from "~/lib/bundles/model";
import { resolveBundle, type ResolveResult } from "~/lib/bundles/engine";
import { bundleSignalSummary } from "~/lib/bundles/signals";

/**
 * Phase 10.1/10.3/10.6 — Bundles admin. CRUD, the recorded-but-never-applied
 * intended discount, a preview (exact storefront payload + per-slot blocking
 * reasons), and advisory view/click metrics.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const previewId = url.searchParams.get("preview");

  const data = await withShopExec(shopId, async (e) => {
    const bundles = await listBundles(e, shopId);
    const metrics = await bundleSignalSummary(e, shopId, {});
    const active = await getActiveVersion(e, shopId);
    // Per-bundle diagnostics (shown? blocking reasons?) for the active version.
    const diagnostics: Record<string, { shown: boolean; reason: string | null; blocked: { position: number; product: string; reason: string }[] }> = {};
    if (active) {
      for (const b of bundles) {
        const full = await getBundle(e, shopId, b.id);
        if (!full) continue;
        const res = await resolveBundle(e, shopId, active.id, full, new Date());
        diagnostics[b.id] = { shown: res.shown, reason: res.reason, blocked: res.blocked.map((x) => ({ position: x.position, product: x.product, reason: x.reason })) };
      }
    }
    let preview: (ResolveResult & { name: string }) | null = null;
    if (previewId) {
      const full = await getBundle(e, shopId, previewId);
      if (full && active) {
        const res = await resolveBundle(e, shopId, active.id, full, new Date());
        preview = { ...res, name: full.name };
      }
    }
    return { bundles, metrics, hasActive: !!active, diagnostics, preview, previewId };
  });
  return data;
};

function parseSlots(form: FormData): SlotInput[] {
  const slots: SlotInput[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const value = String(form.get(`slot${i}_value`) || "").trim();
    if (!value) continue;
    const kind = String(form.get(`slot${i}_kind`) || "gid") === "handle" ? "handle" : "gid";
    const variantMode = String(form.get(`slot${i}_vmode`) || "customer_picks") === "fixed" ? "fixed" : "customer_picks";
    const variantGid = String(form.get(`slot${i}_vgid`) || "").trim() || null;
    const quantity = Number(form.get(`slot${i}_qty`) || 1);
    slots.push({ productRefKind: kind, productRefValue: value, variantMode, variantGid, quantity });
  }
  return slots;
}

function parseBundleInput(form: FormData): BundleInput {
  return {
    name: String(form.get("name") || ""),
    description: String(form.get("description") || ""),
    bundleType: String(form.get("bundleType") || "fixed") === "mix_and_match" ? "mix_and_match" : "fixed",
    status: (String(form.get("status") || "draft") as BundleInput["status"]),
    mixPickCount: form.get("mixPickCount") ? Number(form.get("mixPickCount")) : null,
    startsAt: String(form.get("startsAt") || "") || null,
    endsAt: String(form.get("endsAt") || "") || null,
    timezone: String(form.get("timezone") || "") || null,
    intendedDiscountType: (String(form.get("intendedDiscountType") || "") || null) as BundleInput["intendedDiscountType"],
    intendedDiscountValue: form.get("intendedDiscountValue") ? Number(form.get("intendedDiscountValue")) : null,
    intendedDiscountNote: String(form.get("intendedDiscountNote") || ""),
    slots: parseSlots(form),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "delete") {
      await withShopExec(shopId, (e) => deleteBundle(e, shopId, String(form.get("id"))));
      return { ok: true };
    }
    if (intent === "status") {
      await withShopExec(shopId, (e) => setBundleStatus(e, shopId, String(form.get("id")), String(form.get("status")) as any));
      return { ok: true };
    }
    if (intent === "update") {
      await withShopExec(shopId, (e) => updateBundle(e, shopId, String(form.get("id")), parseBundleInput(form)));
      return { ok: true };
    }
    await withShopExec(shopId, (e) => createBundle(e, shopId, parseBundleInput(form)));
    return { ok: true };
  } catch (err) {
    if (err instanceof BundleValidationError) return { error: err.message };
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Bundles() {
  const { bundles, metrics, hasActive, diagnostics, preview } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const metricOf = (id: string) => metrics.find((m) => m.bundle_id === id);
  const slotRows = Array.from({ length: 4 }, (_, i) => i); // 4 editable rows in the create form

  return (
    <>
      <TitleBar title="Bundles" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 980 }}>
        <h1 style={{ marginTop: 0 }}>Bundles</h1>
        <p style={{ color: "#555" }}>
          Curated product sets shown on the storefront. A bundle appears only when every required
          product is published, active and in stock in the current search index; otherwise it is
          hidden entirely and the blocking slot is named below. Shoppers always see the
          <strong> sum of regular prices</strong> — this app applies no discount.
        </p>
        {!hasActive && <p style={{ color: "#a15c00" }}>No active search index yet — run a catalog sync; bundles can be defined but won't show until the index is built.</p>}

        <div style={{ background: "#fff8e1", border: "1px solid #ffe08a", borderRadius: 6, padding: 10, fontSize: 13, color: "#7a5b00", marginBottom: 16 }}>
          <strong>Discounts are not applied.</strong> You can record an intended bundle discount for
          planning, but it is <em>never</em> shown to shoppers and never changes the cart — a real
          bundle discount needs a Shopify Function plus the <code>write_discounts</code> scope
          (Requires Verification). See docs/PHASE10.md.
        </div>

        <Form method="post" style={{ display: "grid", gap: 8, border: "1px solid #e3e3e3", borderRadius: 8, padding: 14, marginBottom: 22 }}>
          <strong>New bundle</strong>
          <input name="name" placeholder="name" maxLength={200} />
          <textarea name="description" placeholder="description (optional)" rows={2} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label>type
              <select name="bundleType"><option value="fixed">fixed set</option><option value="mix_and_match">mix &amp; match</option></select>
            </label>
            <label>status
              <select name="status" defaultValue="draft"><option>draft</option><option>active</option><option>archived</option></select>
            </label>
            <label>mix pick N <input name="mixPickCount" type="number" min={1} max={10} style={{ width: 70 }} /></label>
          </div>
          <div style={{ fontSize: 13, color: "#555" }}>Slots (2–10). Leave a row blank to skip. Product by gid or handle.</div>
          {slotRows.map((i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select name={`slot${i}_kind`}><option value="gid">gid</option><option value="handle">handle</option></select>
              <input name={`slot${i}_value`} placeholder="gid://shopify/Product/… or handle" style={{ flex: 1 }} />
              <select name={`slot${i}_vmode`}><option value="customer_picks">customer picks</option><option value="fixed">fixed variant</option></select>
              <input name={`slot${i}_vgid`} placeholder="variant gid (if fixed)" style={{ width: 200 }} />
              <input name={`slot${i}_qty`} type="number" min={1} max={10} defaultValue={1} style={{ width: 60 }} />
            </div>
          ))}
          <fieldset style={{ border: "1px solid #eee", borderRadius: 6 }}>
            <legend style={{ fontSize: 13 }}>Intended discount (recorded only — never applied)</legend>
            <div style={{ display: "flex", gap: 8 }}>
              <select name="intendedDiscountType"><option value="">none</option><option value="percent">percent off</option><option value="fixed_amount">amount off</option><option value="fixed_price">fixed bundle price</option></select>
              <input name="intendedDiscountValue" type="number" step="0.01" min={0} placeholder="value" style={{ width: 120 }} />
              <input name="intendedDiscountNote" placeholder="note" style={{ flex: 1 }} />
            </div>
          </fieldset>
          <button type="submit" disabled={busy} style={{ width: 160 }}>Create bundle</button>
        </Form>

        <h2>Bundles ({bundles.length})</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {bundles.map((b) => {
            const diag = diagnostics[b.id];
            const m = metricOf(b.id);
            return (
              <li key={b.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <strong>{b.name}</strong> · <code>{b.bundle_type}</code> · <code>{b.status}</code> · {b.slot_count} slots
                {b.bundle_type === "mix_and_match" ? ` · pick ${b.mix_pick_count}` : ""}
                {diag && <span style={{ marginLeft: 8, color: diag.shown ? "#1a7f37" : "#b35900" }}>{diag.shown ? "● visible" : "○ hidden"}</span>}
                {b.intended_discount_type && (
                  <div style={{ fontSize: 12, color: "#7a5b00" }}>intended {b.intended_discount_type} {b.intended_discount_value} — not applied (needs Shopify Function; Requires Verification)</div>
                )}
                {diag && !diag.shown && (
                  <ul style={{ fontSize: 12, color: "#b35900", margin: "4px 0" }}>
                    {diag.reason && <li>{diag.reason}</li>}
                    {diag.blocked.map((x, j) => <li key={j}>slot {x.position} — {x.reason}</li>)}
                  </ul>
                )}
                <div style={{ fontSize: 12, color: "#666" }}>
                  advisory: {m ? m.views : 0} views · {m ? m.add_to_cart_clicks : 0} add-to-cart clicks (public beacon — inflatable; Phase 11 analytics supersedes)
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                  {(["draft", "active", "archived"] as const).map((s) => (
                    <Form method="post" key={s}><input type="hidden" name="intent" value="status" /><input type="hidden" name="id" value={b.id} /><input type="hidden" name="status" value={s} /><button disabled={busy || b.status === s}>{s}</button></Form>
                  ))}
                  <Form method="get"><input type="hidden" name="preview" value={b.id} /><button disabled={busy}>preview</button></Form>
                  <Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="id" value={b.id} /><button disabled={busy}>delete</button></Form>
                </div>
              </li>
            );
          })}
          {bundles.length === 0 && <li>None yet.</li>}
        </ul>

        {preview && (
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginTop: 12 }}>
            <h3 style={{ marginTop: 0 }}>Preview — {preview.name}</h3>
            <div style={{ color: preview.shown ? "#1a7f37" : "#b35900" }}>{preview.shown ? "Visible to shoppers" : `Hidden — ${preview.reason ?? ""}`}</div>
            {preview.blocked.length > 0 && (
              <ul style={{ fontSize: 13, color: "#b35900" }}>{preview.blocked.map((x, j) => <li key={j}>slot {x.position} ({x.product}) — {x.reason}</li>)}</ul>
            )}
            <pre style={{ background: "#f6f6f6", padding: 10, borderRadius: 6, overflowX: "auto", fontSize: 12 }}>
              {JSON.stringify(preview.payload, null, 2)}
            </pre>
          </div>
        )}
      </main>
    </>
  );
}
