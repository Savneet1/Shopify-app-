-- Migration 0017 — Phase 13.0 carry-over. Applied by app_owner. Additive +
-- idempotent (ADD COLUMN IF NOT EXISTS). No new scope/extension/dependency,
-- NO SECURITY DEFINER function, no RLS change (existing tenant table).
--
-- The Phase 12.2 lost-confirmation sweeper churned: a shop with NO SMTP (or a
-- down host) re-enqueued every stranded pending row on EVERY hourly tick, and
-- the rows never cleared (the job returns "not-configured" without stamping
-- confirm_sent_at). These two columns add bounded, backed-off attempt tracking
-- so the sweeper re-enqueues a given row at most a few times, with exponential
-- spacing, and only for shops whose email is actually configured.
ALTER TABLE "back_in_stock_subscription"
  ADD COLUMN IF NOT EXISTS "confirm_sweep_count"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "back_in_stock_subscription"
  ADD COLUMN IF NOT EXISTS "confirm_last_sweep_at" TIMESTAMPTZ;
