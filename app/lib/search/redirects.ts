import type { Exec } from "~/lib/db/executor";
import { normalizeQuery } from "./text";

/**
 * Redirects (Phase 5.4). Per-shop query → destination, matched on the NORMALIZED
 * query (case/whitespace/punctuation) with EXACT match only. The API returns the
 * redirect in the response payload; the server never issues a 30x.
 *
 * Destination must be a same-shop RELATIVE path or an absolute https URL on the
 * shop's OWN domain. External hosts, protocol-relative "//host", and
 * javascript:/data:/vbscript:/file: schemes are rejected (open-redirect
 * protection). Validated at BOTH write time and read time (fail closed).
 */

export const MAX_REDIRECTS_PER_SHOP = 2000;

export class RedirectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectValidationError";
  }
}

export interface RedirectRow {
  id: string;
  query_normalized: string;
  destination: string;
}

/**
 * Validate a destination against the shop's own domain. Returns the safe
 * destination string, or throws RedirectValidationError.
 */
export function validateDestination(destRaw: string, shopDomain: string): string {
  const dest = (destRaw ?? "").trim();
  if (dest.length === 0) throw new RedirectValidationError("destination is empty");
  if (dest.length > 2048) throw new RedirectValidationError("destination too long");
  // Reject control characters (defeats "java\nscript:" style bypasses).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(dest)) throw new RedirectValidationError("destination has control characters");

  // Relative path: must start with a single "/", not "//" or "/\" (which browsers
  // treat as protocol-relative / host-changing).
  if (dest.startsWith("/")) {
    if (dest.startsWith("//") || dest.startsWith("/\\")) {
      throw new RedirectValidationError("protocol-relative destination not allowed");
    }
    return dest;
  }

  // Otherwise it must be an absolute https URL on the shop's own host.
  let url: URL;
  try {
    url = new URL(dest);
  } catch {
    throw new RedirectValidationError("destination must be a relative path or an absolute URL on this shop's domain");
  }
  if (url.protocol !== "https:") {
    throw new RedirectValidationError(`scheme '${url.protocol}' not allowed (https only)`);
  }
  if (url.hostname.toLowerCase() !== shopDomain.toLowerCase()) {
    throw new RedirectValidationError("destination host must be this shop's own domain");
  }
  return url.toString();
}

async function shopDomainOf(exec: Exec, shopId: string): Promise<string> {
  const rows = await exec.rows<{ shop_domain: string }>(
    `SELECT shop_domain FROM shop WHERE id=$1::uuid`, [shopId],
  );
  if (!rows[0]) throw new Error(`shop ${shopId} not found`);
  return rows[0].shop_domain;
}

export async function listRedirects(exec: Exec, shopId: string): Promise<RedirectRow[]> {
  return exec.rows<RedirectRow>(
    `SELECT id, query_normalized, destination FROM search_redirect WHERE shop_id=$1::uuid ORDER BY query_normalized`,
    [shopId],
  );
}

export async function addRedirect(
  exec: Exec,
  shopId: string,
  query: string,
  destination: string,
): Promise<RedirectRow> {
  const qn = normalizeQuery(query);
  if (qn.length === 0) throw new RedirectValidationError("query is empty after normalisation");
  const domain = await shopDomainOf(exec, shopId);
  const safe = validateDestination(destination, domain); // throws on invalid

  const count = (await exec.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM search_redirect WHERE shop_id=$1::uuid`, [shopId],
  ))[0].n;
  if (count >= MAX_REDIRECTS_PER_SHOP) {
    throw new RedirectValidationError(`redirect limit reached (${MAX_REDIRECTS_PER_SHOP})`);
  }

  const rows = await exec.rows<RedirectRow>(
    `INSERT INTO search_redirect (shop_id, query_normalized, destination)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (shop_id, query_normalized) DO UPDATE SET destination=EXCLUDED.destination
     RETURNING id, query_normalized, destination`,
    [shopId, qn, safe],
  );
  return rows[0];
}

export async function deleteRedirect(exec: Exec, shopId: string, id: string): Promise<number> {
  return exec.run(`DELETE FROM search_redirect WHERE shop_id=$1::uuid AND id=$2::uuid`, [shopId, id]);
}

/** Look up a redirect for a raw query. Re-validates the destination (fail closed). */
export async function matchRedirect(
  exec: Exec,
  shopId: string,
  rawQuery: string,
): Promise<string | null> {
  const qn = normalizeQuery(rawQuery);
  if (qn.length === 0) return null;
  const rows = await exec.rows<{ destination: string }>(
    `SELECT destination FROM search_redirect WHERE shop_id=$1::uuid AND query_normalized=$2 LIMIT 1`,
    [shopId, qn],
  );
  if (!rows[0]) return null;
  try {
    const domain = await shopDomainOf(exec, shopId);
    return validateDestination(rows[0].destination, domain);
  } catch {
    return null; // stored value no longer valid -> do not emit
  }
}
