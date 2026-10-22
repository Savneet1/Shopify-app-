import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { resolveShopId, withShopExec } from "~/lib/tenant.server";
import { loadEmailSettingsView, saveEmailSettings, claimSendTest } from "~/lib/email/settings";
import { DestinationPolicyError } from "~/lib/email/destination";
import { getEmailProvider } from "~/lib/email/factory";
import { EncryptionKeyMissingError } from "~/lib/crypto/secret.server";
import { loadRestockSettings, saveRestockSettings, MAX_NOTIFIED_RETENTION_DAYS } from "~/lib/restock/settings";
import {
  subscriptionCounts, notificationStats, listSubscriptions, deleteSubscription, deleteAllForEmail,
} from "~/lib/restock/admin";
import {
  listPreorderRules, createPreorderRule, updatePreorderRule, deletePreorderRule, type PreorderMatchType,
} from "~/lib/preorder/rules";
import {
  listCountdownRules, createCountdownRule, deleteCountdownRule, type CountdownScope,
} from "~/lib/countdown/rules";

/**
 * Phase 12.6 — restock admin: email (SMTP) settings with a write-only password +
 * send-test, subscriptions (counts, exact-email search with masked display,
 * per-row + per-email delete), notification stats, pre-order + countdown rule
 * CRUD, and retention settings. Emails are shown MASKED. CSV export is the
 * sibling resource route (app.restock.export).
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const url = new URL(request.url);
  const emailQuery = url.searchParams.get("q");
  return withShopExec(shopId, async (e) => ({
    email: await loadEmailSettingsView(e, shopId),
    restock: await loadRestockSettings(e, shopId),
    counts: await subscriptionCounts(e, shopId),
    notifications: await notificationStats(e, shopId),
    subscriptions: await listSubscriptions(e, shopId, { emailQuery, limit: 100 }),
    preorder: await listPreorderRules(e, shopId),
    countdown: await listCountdownRules(e, shopId),
    emailQuery: emailQuery ?? "",
  }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = await resolveShopId(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const str = (k: string) => { const v = form.get(k); return v == null || v === "" ? null : String(v); };

  try {
    switch (intent) {
      case "save-email": {
        await withShopExec(shopId, (e) => saveEmailSettings(e, shopId, {
          host: str("host"), port: str("port") ? Number(str("port")) : null,
          security: (str("security") as "none" | "starttls" | "tls") ?? "starttls",
          username: str("username"), fromEmail: str("fromEmail"), fromName: str("fromName"),
          replyTo: str("replyTo"),
          // write-only: only set when a non-empty value is posted
          password: str("password") ?? undefined,
          clearPassword: form.get("clearPassword") === "on",
        }));
        return { ok: true, msg: "Email settings saved." };
      }
      case "send-test": {
        // Q4(b): the cooldown is DB-backed (claimSendTest stamps last_test_email_at
        // atomically) so it holds across instances/restarts, not a per-process Map.
        const res = await withShopExec(shopId, async (e) => {
          const view = await loadEmailSettingsView(e, shopId);
          if (!view.configured || !view.fromEmail) return { error: "Email is not fully configured." };
          if (!(await claimSendTest(e, shopId))) return { error: "Please wait a minute between test emails." };
          const { provider } = await getEmailProvider(e, shopId);
          await provider.send({
            to: view.fromEmail, // own shop's configured address only
            subject: "Test email from your store's back-in-stock alerts",
            text: "This is a test email confirming your SMTP settings work.",
            html: "<p>This is a test email confirming your SMTP settings work.</p>",
          });
          return { ok: true };
        });
        if ("error" in res) return res;
        return { ok: true, msg: "Test email sent to your configured From address." };
      }
      case "save-restock-settings": {
        await withShopExec(shopId, (e) => saveRestockSettings(e, shopId, {
          perEmailDailyCap: Number(form.get("perEmailDailyCap")),
          perShopDailyCap: Number(form.get("perShopDailyCap")),
          sendRatePerRun: Number(form.get("sendRatePerRun")),
          notifiedRetentionDays: Number(form.get("notifiedRetentionDays")),
        }));
        return { ok: true, msg: "Retention & caps saved." };
      }
      case "delete-subscription": {
        await withShopExec(shopId, (e) => deleteSubscription(e, shopId, String(form.get("id"))));
        return { ok: true, msg: "Subscription deleted." };
      }
      case "delete-all-email": {
        const n = await withShopExec(shopId, (e) => deleteAllForEmail(e, shopId, String(form.get("email") ?? "")));
        return { ok: true, msg: `Deleted ${n} subscription(s) for that email.` };
      }
      case "preorder-create": {
        const r = await withShopExec(shopId, (e) => createPreorderRule(e, shopId, {
          matchType: String(form.get("matchType")) as PreorderMatchType,
          matchValue: String(form.get("matchValue") ?? ""),
          message: str("message"), releaseAt: str("releaseAt"), startsAt: str("startsAt"), endsAt: str("endsAt"),
          enabled: form.get("enabled") !== "off",
        }));
        return "error" in r ? { error: r.error } : { ok: true, msg: "Pre-order rule created." };
      }
      case "preorder-delete": {
        await withShopExec(shopId, (e) => deletePreorderRule(e, shopId, String(form.get("id"))));
        return { ok: true, msg: "Pre-order rule deleted." };
      }
      case "preorder-toggle": {
        const r = await withShopExec(shopId, (e) => updatePreorderRule(e, shopId, String(form.get("id")), {
          matchType: String(form.get("matchType")) as PreorderMatchType,
          matchValue: String(form.get("matchValue") ?? ""),
          message: str("message"), releaseAt: str("releaseAt"), startsAt: str("startsAt"), endsAt: str("endsAt"),
          enabled: form.get("enabled") === "on",
        }));
        return "error" in r ? { error: r.error } : { ok: true, msg: "Pre-order rule updated." };
      }
      case "countdown-create": {
        const r = await withShopExec(shopId, (e) => createCountdownRule(e, shopId, {
          scope: String(form.get("scope")) as CountdownScope,
          matchValue: str("matchValue"), label: str("label"),
          endsAt: String(form.get("endsAt") ?? ""), startsAt: str("startsAt"),
          expiredMessage: str("expiredMessage"), enabled: form.get("enabled") !== "off",
        }));
        return "error" in r ? { error: r.error } : { ok: true, msg: "Countdown created." };
      }
      case "countdown-delete": {
        await withShopExec(shopId, (e) => deleteCountdownRule(e, shopId, String(form.get("id"))));
        return { ok: true, msg: "Countdown deleted." };
      }
      default:
        return { error: "Unknown action." };
    }
  } catch (err) {
    if (err instanceof EncryptionKeyMissingError) {
      return { error: "Cannot save a password: the server email-encryption key (EMAIL_ENCRYPTION_KEY) is not configured. Other settings were not saved." };
    }
    if (err instanceof DestinationPolicyError) {
      return { error: `SMTP settings not saved: ${err.message}. Use a public mail host with port 25, 465, 587 or 2525 (465 requires implicit TLS; credentials require TLS).` };
    }
    return { error: err instanceof Error ? err.message : "failed" };
  }
};

export default function Restock() {
  const d = useLoaderData<typeof loader>();
  const a = useActionData<typeof action>() as { ok?: boolean; msg?: string; error?: string } | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const box = { border: "1px solid #e3e3e3", borderRadius: 8, padding: 14, marginBottom: 16 } as const;

  return (
    <>
      <TitleBar title="Back in stock & messaging" />
      <main style={{ fontFamily: "system-ui", padding: "1.5rem", maxWidth: 960 }}>
        <h1 style={{ marginTop: 0 }}>Back in stock, pre-order & countdowns</h1>
        <p style={{ color: "#555" }}>
          Collect back-in-stock requests (double opt-in), notify shoppers by your own SMTP server when an
          item returns, and show pre-order / countdown messaging. Emails are shown masked. This app does
          <strong> not</strong> make an out-of-stock product purchasable — that is configured in Shopify.
        </p>
        {a?.error && <p role="alert" style={{ color: "#b00020" }}>{a.error}</p>}
        {a?.ok && a?.msg && <p style={{ color: "#0a7a0a" }}>{a.msg}</p>}

        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Email (SMTP)</h2>
          <p style={{ color: "#555", fontSize: 13 }}>
            Status: {d.email.configured
              ? <strong style={{ color: "#0a7a0a" }}>configured</strong>
              : <strong style={{ color: "#a15c00" }}>not configured — subscriptions are still collected, but nothing is sent</strong>}
            {d.email.passwordSet && <> · password set{d.email.passwordLast2 ? ` (…${d.email.passwordLast2})` : ""}</>}
            {!d.email.encryptionAvailable && <> · <span style={{ color: "#b00020" }}>encryption key missing: passwords cannot be saved</span></>}
          </p>
          <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
            <input type="hidden" name="intent" value="save-email" />
            <label>Host<input name="host" defaultValue={d.email.host ?? ""} /></label>
            <label>Port<input name="port" type="number" min={1} max={65535} defaultValue={d.email.port ?? 587} /></label>
            <label>Security
              <select name="security" defaultValue={d.email.security}>
                <option value="starttls">STARTTLS</option>
                <option value="tls">Implicit TLS</option>
                <option value="none">None</option>
              </select>
            </label>
            <label>Username<input name="username" defaultValue={d.email.username ?? ""} autoComplete="off" /></label>
            <label>Password (write-only)<input name="password" type="password" placeholder={d.email.passwordSet ? "•••••• (unchanged)" : ""} autoComplete="new-password" /></label>
            <label style={{ alignSelf: "end" }}><input type="checkbox" name="clearPassword" /> Clear stored password</label>
            <label>From email<input name="fromEmail" type="email" defaultValue={d.email.fromEmail ?? ""} /></label>
            <label>From name<input name="fromName" defaultValue={d.email.fromName ?? ""} /></label>
            <label>Reply-To<input name="replyTo" type="email" defaultValue={d.email.replyTo ?? ""} /></label>
            <button type="submit" disabled={busy} style={{ alignSelf: "end" }}>Save email settings</button>
          </Form>
          <Form method="post" style={{ marginTop: 10 }}>
            <input type="hidden" name="intent" value="send-test" />
            <button type="submit" disabled={busy || !d.email.configured}>Send test email (to your From address)</button>
          </Form>
        </section>

        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Subscriptions</h2>
          <p style={{ fontSize: 13 }}>
            pending {d.counts.pending} · confirmed {d.counts.confirmed} · notified {d.counts.notified} ·
            unsubscribed {d.counts.unsubscribed} · bounced {d.counts.bounced} · total {d.counts.total}
            <br />notifications — pending {d.notifications.pending} · sent {d.notifications.sent} · bounced {d.notifications.bounced} · skipped {d.notifications.skipped}
          </p>
          <Form method="get" style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input name="q" type="email" placeholder="exact email" defaultValue={d.emailQuery} />
            <button type="submit" disabled={busy}>Search</button>
            <a href="/app/restock/export" style={{ alignSelf: "center" }}>Export CSV (masked)</a>
          </Form>
          {d.emailQuery && (
            <Form method="post" style={{ marginBottom: 8 }}>
              <input type="hidden" name="intent" value="delete-all-email" />
              <input type="hidden" name="email" value={d.emailQuery} />
              <button type="submit" disabled={busy}>Delete ALL subscriptions for {d.emailQuery}</button>
            </Form>
          )}
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>Email</th><th>Status</th><th>Product</th><th>Variant</th><th>Created</th><th></th>
            </tr></thead>
            <tbody>
              {d.subscriptions.map((s) => (
                <tr key={s.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td>{s.maskedEmail}</td><td>{s.status}</td><td>{s.shopifyProductGid.split("/").pop()}</td>
                  <td>{s.variantGid ? s.variantGid.split("/").pop() : "—"}</td>
                  <td>{new Date(s.createdAt).toISOString().slice(0, 10)}</td>
                  <td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-subscription" />
                      <input type="hidden" name="id" value={s.id} />
                      <button type="submit" disabled={busy}>Delete</button>
                    </Form>
                  </td>
                </tr>
              ))}
              {d.subscriptions.length === 0 && <tr><td colSpan={6} style={{ color: "#999" }}>No subscriptions.</td></tr>}
            </tbody>
          </table>
        </section>

        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Retention & caps</h2>
          <Form method="post" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <input type="hidden" name="intent" value="save-restock-settings" />
            <label>Per-email daily cap<input name="perEmailDailyCap" type="number" min={1} max={1000} defaultValue={d.restock.perEmailDailyCap} style={{ width: 90 }} /></label>
            <label>Per-shop daily cap<input name="perShopDailyCap" type="number" min={1} max={1000000} defaultValue={d.restock.perShopDailyCap} style={{ width: 110 }} /></label>
            <label>Send rate / run<input name="sendRatePerRun" type="number" min={1} max={10000} defaultValue={d.restock.sendRatePerRun} style={{ width: 90 }} /></label>
            <label>Notified retention (days, max {MAX_NOTIFIED_RETENTION_DAYS})<input name="notifiedRetentionDays" type="number" min={1} max={MAX_NOTIFIED_RETENTION_DAYS} defaultValue={d.restock.notifiedRetentionDays} style={{ width: 90 }} /></label>
            <button type="submit" disabled={busy}>Save</button>
          </Form>
        </section>

        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Pre-order rules (display only)</h2>
          <Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginBottom: 10 }}>
            <input type="hidden" name="intent" value="preorder-create" />
            <label>Match
              <select name="matchType" defaultValue="tag"><option value="tag">tag</option><option value="handle">handle</option><option value="gid">product gid</option><option value="collection">collection gid</option></select>
            </label>
            <label>Value<input name="matchValue" required /></label>
            <label>Message<input name="message" placeholder="Pre-order — ships soon" /></label>
            <label>Ships on<input name="releaseAt" type="datetime-local" /></label>
            <button type="submit" disabled={busy}>Add</button>
          </Form>
          <ul style={{ fontSize: 13 }}>
            {d.preorder.map((r) => (
              <li key={r.id} style={{ marginBottom: 4 }}>
                <strong>{r.matchType}</strong>={r.matchValue} {r.enabled ? "" : "(disabled)"} {r.message ? `— "${r.message}"` : ""} {r.releaseAt ? `· ships ${new Date(r.releaseAt).toISOString().slice(0, 10)}` : ""}
                <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                  <input type="hidden" name="intent" value="preorder-delete" /><input type="hidden" name="id" value={r.id} />
                  <button type="submit" disabled={busy}>Delete</button>
                </Form>
              </li>
            ))}
            {d.preorder.length === 0 && <li style={{ color: "#999" }}>No pre-order rules.</li>}
          </ul>
        </section>

        <section style={box}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Countdowns (display only)</h2>
          <Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginBottom: 10 }}>
            <input type="hidden" name="intent" value="countdown-create" />
            <label>Scope
              <select name="scope" defaultValue="global"><option value="global">global</option><option value="product">product</option><option value="collection">collection</option></select>
            </label>
            <label>Value (gid/handle)<input name="matchValue" /></label>
            <label>Label<input name="label" placeholder="Sale ends in" /></label>
            <label>Ends at<input name="endsAt" type="datetime-local" required /></label>
            <label>Expired message<input name="expiredMessage" placeholder="This sale has ended" /></label>
            <button type="submit" disabled={busy}>Add</button>
          </Form>
          <ul style={{ fontSize: 13 }}>
            {d.countdown.map((r) => (
              <li key={r.id} style={{ marginBottom: 4 }}>
                <strong>{r.scope}</strong>{r.matchValue ? `=${r.matchValue}` : ""} · ends {new Date(r.endsAt).toISOString().slice(0, 16).replace("T", " ")} {r.enabled ? "" : "(disabled)"} {r.label ? `· "${r.label}"` : ""}
                <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                  <input type="hidden" name="intent" value="countdown-delete" /><input type="hidden" name="id" value={r.id} />
                  <button type="submit" disabled={busy}>Delete</button>
                </Form>
              </li>
            ))}
            {d.countdown.length === 0 && <li style={{ color: "#999" }}>No countdowns.</li>}
          </ul>
        </section>

        <p style={{ color: "#777", fontSize: 12 }}>
          Deliverability (SPF/DKIM/DMARC) and whether a pre-order product can actually be purchased are the
          merchant's responsibility in Shopify and with their mail provider — see docs/PHASE12.md.
        </p>
      </main>
    </>
  );
}
