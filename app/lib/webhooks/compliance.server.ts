import { withShop, type TenantTx } from "~/lib/tenant.server";
import { logger } from "~/lib/logger.server";
import { emailHash } from "~/lib/crypto/secret.server";
import { normalizeEmail } from "~/lib/restock/email";
import crypto from "node:crypto";

/** Q3: get-or-create this shop's email-hash pepper via the tenant tx (race-safe:
 * INSERT ... ON CONFLICT DO NOTHING then SELECT → one pepper). */
async function getPepper(tx: TenantTx, shopId: string): Promise<string> {
  const candidate = crypto.randomBytes(32).toString("hex");
  await tx.$executeRawUnsafe(
    `INSERT INTO restock_hash_pepper (shop_id, pepper) VALUES ($1::uuid, $2) ON CONFLICT (shop_id) DO NOTHING`,
    shopId, candidate,
  );
  const rows = (await tx.$queryRawUnsafe(
    `SELECT pepper FROM restock_hash_pepper WHERE shop_id=$1::uuid`, shopId,
  )) as Array<{ pepper: string }>;
  return rows[0].pepper;
}

export type ComplianceTopic =
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

export interface ComplianceInput {
  shopId: string;
  topic: ComplianceTopic;
  shopifyCustomerId?: string | null;
  customerEmail?: string | null;
  payload: unknown;
}

/**
 * Process a mandatory privacy webhook, tenant-scoped.
 *
 * Phase 1 data reality: this app stores NO customer personal data yet (no
 * access scopes, no catalog/customer sync — those arrive in later phases). So:
 *
 *  - customers/data_request : record the request; there is no customer PII to
 *    return, so it is marked "no_data".
 *  - customers/redact       : record; nothing to erase -> "no_data".
 *  - shop/redact            : record; erase this shop's tenant-owned rows and
 *    tombstone the shop (uninstalledAt). The shop row itself is removed by an
 *    owner-run maintenance job (runtime role has no DELETE policy on `shop`).
 *
 * Every write is RLS-bound to `shopId` via withShop.
 */
export async function processCompliance(input: ComplianceInput): Promise<void> {
  const { shopId, topic } = input;
  await withShop(shopId, async (tx) => {
    // Phase 12: this app now stores shopper emails (back-in-stock). The request
    // email is normalised and matched by its KEYED HASH — never by plaintext.
    const norm = normalizeEmail(input.customerEmail);
    // Q3: the email hash is keyed by this shop's pepper (obtained in-tenant),
    // not SHOPIFY_API_SECRET, so it matches the stored hashes after a secret
    // rotation.
    const hash = norm.valid && norm.email ? emailHash(await getPepper(tx, shopId), shopId, norm.email) : null;

    let status: string = topic === "shop/redact" ? "processing" : "no_data";
    let held = 0;

    if (topic === "customers/data_request" && hash) {
      held = await countSubscriptions(tx, shopId, hash);
      status = held > 0 ? "processed" : "no_data"; // do NOT mark no_data when rows exist
    } else if (topic === "customers/redact" && hash) {
      held = await redactEmail(tx, shopId, hash); // idempotent delete
      status = "processed";
    }

    await tx.dataDeletionRequest.create({
      data: {
        shopId,
        topic,
        shopifyCustomerId: input.shopifyCustomerId ?? null,
        customerEmail: input.customerEmail ?? null,
        // Record WHAT is/was held (count only; no plaintext email in the record).
        payload: { ...(typeof input.payload === "object" && input.payload ? input.payload : {}), restockSubscriptions: held } as object,
        status,
        processedAt: topic === "shop/redact" ? null : new Date(),
      },
    });

    if (topic === "shop/redact") {
      await eraseShopData(tx, shopId);
    }
  });

  logger.info({ shopId, topic }, "processed compliance webhook");
}

/** Count back-in-stock subscriptions held for a (hashed) email. */
async function countSubscriptions(tx: TenantTx, shopId: string, emailHashHex: string): Promise<number> {
  const rows = (await tx.$queryRawUnsafe(
    `SELECT count(*)::bigint n FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND email_hash=$2`,
    shopId, emailHashHex,
  )) as Array<{ n: bigint }>;
  return Number(rows[0]?.n ?? 0);
}

/** Delete every subscription (and, via FK cascade, its notification ledger rows)
 * for a (hashed) email, plus any suppression record. Idempotent. Returns the
 * number of subscription rows removed. */
async function redactEmail(tx: TenantTx, shopId: string, emailHashHex: string): Promise<number> {
  const n = await countSubscriptions(tx, shopId, emailHashHex);
  // restock_notification has ON DELETE CASCADE from the subscription FK.
  await tx.$executeRawUnsafe(
    `DELETE FROM back_in_stock_subscription WHERE shop_id=$1::uuid AND email_hash=$2`,
    shopId, emailHashHex,
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM restock_suppression WHERE shop_id=$1::uuid AND email_hash=$2`,
    shopId, emailHashHex,
  );
  return n;
}

/**
 * Delete this shop's tenant-owned data (RLS ensures only this shop's rows are
 * affected). `shop` itself is tombstoned rather than deleted here.
 */
async function eraseShopData(tx: TenantTx, shopId: string): Promise<void> {
  await tx.appSetting.deleteMany({ where: { shopId } });
  await tx.market.deleteMany({ where: { shopId } });
  await tx.themeCompatReport.deleteMany({ where: { shopId } });
  await tx.billingSubscription.deleteMany({ where: { shopId } });
  // Phase 11: analytics rows are not Prisma-modelled (raw SQL, RLS-bound). Wipe
  // them explicitly on shop/redact. (The FK is ON DELETE CASCADE too, so an
  // owner-run shop-row delete also clears them — this is the belt-and-braces
  // explicit path within the shop's tenant context.)
  await tx.$executeRawUnsafe(`DELETE FROM analytics_event WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM analytics_rollup_daily WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM analytics_settings WHERE shop_id = $1::uuid`, shopId);
  // Phase 12: back-in-stock / email / messaging tables (raw SQL, RLS-bound). The
  // FK cascade would also clear these on an owner shop-row delete; this is the
  // explicit in-tenant erase path. restock_notification cascades from the
  // subscription delete, and availability has an FK to product.
  await tx.$executeRawUnsafe(`DELETE FROM back_in_stock_subscription WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM restock_notification WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM restock_suppression WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM restock_availability WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM preorder_rule WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM countdown_rule WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM restock_setting WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM restock_hash_pepper WHERE shop_id = $1::uuid`, shopId);
  await tx.$executeRawUnsafe(`DELETE FROM email_setting WHERE shop_id = $1::uuid`, shopId);
  // webhook_receipt + data_deletion_request are audit records; retained.
  await tx.shop.update({
    where: { id: shopId },
    data: { uninstalledAt: new Date() },
  });
}
