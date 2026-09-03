-- 004-receipt-job-reclaim.sql
-- Append-only migration adding stale receipt-job recovery.
-- Idempotent: CREATE OR REPLACE, safe to run multiple times.
--
-- Problem: claim_receipt_job() moves a receipt_outbox row to 'processing'
-- and increments attempts, but if the calling request dies before
-- complete_receipt_job()/fail_receipt_job() runs (function timeout, crash,
-- deploy restart), the row is stuck in 'processing' forever — no existing
-- code path ever revisits it.
--
-- Fix: reclaim_stale_receipt_jobs() resets any row that has been in
-- 'processing' for more than 10 minutes back to 'pending' (so the next
-- claim_receipt_job() call picks it up again), or to 'failed' if it has
-- already reached the existing 5-attempt cap. attempts is NOT reset here —
-- claim_receipt_job() already incremented it when the row was claimed, so
-- the cap enforced by fail_receipt_job() continues to apply unchanged.
--
-- Scope: touches only receipt_outbox. Never modifies 'sent' rows, and never
-- touches payment_reservations, purchases, credit_ledger, or companies.

CREATE OR REPLACE FUNCTION reclaim_stale_receipt_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.receipt_outbox
  SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END
  WHERE status = 'processing'
    AND last_attempt_at < NOW() - INTERVAL '10 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Same access model as the other receipt RPCs (9a/9b/9c in migration 003):
-- service_role only, everyone else explicitly revoked.
GRANT EXECUTE ON FUNCTION reclaim_stale_receipt_jobs() TO service_role;
REVOKE EXECUTE ON FUNCTION reclaim_stale_receipt_jobs() FROM anon;
REVOKE EXECUTE ON FUNCTION reclaim_stale_receipt_jobs() FROM authenticated;
REVOKE EXECUTE ON FUNCTION reclaim_stale_receipt_jobs() FROM PUBLIC;
