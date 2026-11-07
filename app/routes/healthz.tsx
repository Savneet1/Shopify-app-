import type { LoaderFunctionArgs } from "react-router";
import { getPrisma } from "~/db.server";

/*
 * Phase 14.4i — cheap liveness/readiness probe. Checks DATABASE CONNECTIVITY
 * ONLY (a trivial `SELECT 1`); it never reads tenant data, requires no auth, and
 * returns no secrets. 200 when the DB answers, 503 otherwise. Safe to expose to
 * a load balancer / uptime monitor.
 */
export async function loader(_args: LoaderFunctionArgs) {
  try {
    await getPrisma().$queryRawUnsafe("SELECT 1");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
}
