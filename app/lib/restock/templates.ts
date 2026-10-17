/**
 * Phase 12 — generic, merchant-localisable email bodies (en + fr). Pure. All
 * interpolated values are HTML-escaped in the html part. Content is generic
 * (no shopper PII beyond the recipient's own address in the envelope) and names
 * the shop's identity. The product title/URL come from the caller (the VISIBLE
 * active-version doc only).
 */

export type Locale = "en" | "fr";

export function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return "en";
  return raw.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface EmailBody { subject: string; text: string; html: string; }

interface ConfirmData { shopName: string; productTitle: string; confirmUrl: string; unsubscribeUrl: string; }
interface RestockData { shopName: string; productTitle: string; productUrl: string | null; unsubscribeUrl: string; }

const STR: Record<Locale, {
  confirmSubject: (p: string) => string;
  confirmLead: (s: string, p: string) => string;
  confirmCta: string;
  restockSubject: (p: string) => string;
  restockLead: (s: string, p: string) => string;
  viewProduct: string;
  unsubscribe: string;
  ignore: string;
}> = {
  en: {
    confirmSubject: (p) => `Confirm your back-in-stock alert for ${p}`,
    confirmLead: (s, p) => `You asked ${s} to notify you when "${p}" is back in stock. Please confirm this request.`,
    confirmCta: "Confirm my alert",
    restockSubject: (p) => `${p} is back in stock`,
    restockLead: (s, p) => `Good news — "${p}" is available again at ${s}.`,
    viewProduct: "View product",
    unsubscribe: "Unsubscribe from these alerts",
    ignore: "If you did not request this, you can ignore this email.",
  },
  fr: {
    confirmSubject: (p) => `Confirmez votre alerte de réapprovisionnement pour ${p}`,
    confirmLead: (s, p) => `Vous avez demandé à ${s} de vous prévenir lorsque « ${p} » sera de nouveau en stock. Veuillez confirmer cette demande.`,
    confirmCta: "Confirmer mon alerte",
    restockSubject: (p) => `${p} est de nouveau en stock`,
    restockLead: (s, p) => `Bonne nouvelle — « ${p} » est de nouveau disponible chez ${s}.`,
    viewProduct: "Voir le produit",
    unsubscribe: "Se désabonner de ces alertes",
    ignore: "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.",
  },
};

export function confirmEmail(locale: Locale, d: ConfirmData): EmailBody {
  const t = STR[locale];
  const subject = t.confirmSubject(d.productTitle);
  const text = [
    t.confirmLead(d.shopName, d.productTitle),
    "",
    `${t.confirmCta}: ${d.confirmUrl}`,
    "",
    t.ignore,
    `${t.unsubscribe}: ${d.unsubscribeUrl}`,
  ].join("\n");
  const html = [
    `<p>${escapeHtml(t.confirmLead(d.shopName, d.productTitle))}</p>`,
    `<p><a href="${escapeHtml(d.confirmUrl)}">${escapeHtml(t.confirmCta)}</a></p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(t.ignore)}<br>`,
    `<a href="${escapeHtml(d.unsubscribeUrl)}">${escapeHtml(t.unsubscribe)}</a></p>`,
  ].join("\n");
  return { subject, text, html };
}

export function restockEmail(locale: Locale, d: RestockData): EmailBody {
  const t = STR[locale];
  const subject = t.restockSubject(d.productTitle);
  const lines = [t.restockLead(d.shopName, d.productTitle), ""];
  if (d.productUrl) lines.push(`${t.viewProduct}: ${d.productUrl}`, "");
  lines.push(`${t.unsubscribe}: ${d.unsubscribeUrl}`);
  const text = lines.join("\n");
  const htmlParts = [`<p>${escapeHtml(t.restockLead(d.shopName, d.productTitle))}</p>`];
  if (d.productUrl) htmlParts.push(`<p><a href="${escapeHtml(d.productUrl)}">${escapeHtml(t.viewProduct)}</a></p>`);
  htmlParts.push(`<p style="color:#666;font-size:12px"><a href="${escapeHtml(d.unsubscribeUrl)}">${escapeHtml(t.unsubscribe)}</a></p>`);
  return { subject, text, html: htmlParts.join("\n") };
}
