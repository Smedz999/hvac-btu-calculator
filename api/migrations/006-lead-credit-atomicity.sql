-- 006-lead-credit-atomicity.sql
-- Fixes Blocker 3: distributeLead() previously read a company's credits,
-- then later wrote credits = <that stale value> - 1 as a separate
-- statement from the lead assignment/insert — a classic stale
-- read-modify-write race, and non-atomic with the lead row it was
-- supposed to accompany. See the Blocker 3 investigation for the full
-- failure-mode analysis (lost-update double-allocation, credit deducted
-- with no visible lead, visible lead with no credit deducted).
--
-- This migration is purely additive: two new functions and one new
-- index. It does NOT modify companies, leads, credit_ledger, or any
-- existing function (admin_adjust_credits, process_stripe_payment_atomic,
-- and everything else in 003/004 are untouched).
--
-- NOT applied by this change. Local file only.

-- ============================================================
-- Idempotency / uniqueness: one company per original inquiry
-- ============================================================
-- COALESCE(parent_lead_id, id) is "the id of the original inquiry this
-- row belongs to": for a primary/original lead row (parent_lead_id IS
-- NULL) that's its own id; for a secondary/copied row (added in
-- migration 005) it's the parent_lead_id it was copied from. This single
-- expression index therefore enforces the same rule for both shapes of
-- row: a given company may hold at most one assigned lead row for a
-- given original inquiry.
--
-- For a primary row this is inherently satisfied on its own (a single
-- row can only ever equal itself, and leads.id is already a primary
-- key) — the real protection against double-assigning the *same*
-- primary lead is the assigned_to IS NULL guard inside
-- assign_primary_lead below, enforced by Postgres's atomic
-- UPDATE ... WHERE semantics under concurrent access. This index is a
-- harmless, always-true backstop for that case.
--
-- For a secondary row this is the actively load-bearing protection: it
-- is what makes it impossible, at the database level, for the same
-- company to ever receive two separate child-copy rows for the same
-- parent_lead_id, regardless of how many times or how concurrently
-- assign_secondary_lead is called for that pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique_company_per_inquiry
  ON public.leads (COALESCE(parent_lead_id, id), assigned_to)
  WHERE assigned_to IS NOT NULL;

-- ============================================================
-- A. assign_primary_lead — claims the ORIGINAL lead row for contractor #1
-- ============================================================
-- Returns exactly one row. status is one of:
--   'assigned'             — lead claimed, credit deducted, ledger written
--   'company_not_found'    — p_company_id does not exist
--   'insufficient_credits' — company has 0 credits
--   'lead_not_found'       — p_lead_id does not exist
--   'already_assigned'     — the lead already has an assignee (including
--                            losing a concurrent race to claim it)
-- new_balance is the company's credit balance after the call for
-- 'assigned'/'insufficient_credits'/'lead_not_found'/'already_assigned',
-- and NULL for 'company_not_found' (no company row to report a balance for).
CREATE OR REPLACE FUNCTION assign_primary_lead(
  p_lead_id BIGINT,
  p_company_id BIGINT
)
RETURNS TABLE (status TEXT, new_balance INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_credits INTEGER;
  v_new_balance INTEGER;
  v_lead_assigned_to BIGINT;
  v_lead_found BOOLEAN;
  v_rows INTEGER;
BEGIN
  -- Lock the company row so a concurrent secondary/primary assignment
  -- touching the SAME company cannot read-modify-write the same stale
  -- credits value (the original race this migration exists to close).
  SELECT credits INTO v_current_credits
  FROM public.companies
  WHERE id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'company_not_found'::TEXT, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_current_credits <= 0 THEN
    RETURN QUERY SELECT 'insufficient_credits'::TEXT, v_current_credits;
    RETURN;
  END IF;

  SELECT TRUE, assigned_to INTO v_lead_found, v_lead_assigned_to
  FROM public.leads
  WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'lead_not_found'::TEXT, v_current_credits;
    RETURN;
  END IF;

  IF v_lead_assigned_to IS NOT NULL THEN
    RETURN QUERY SELECT 'already_assigned'::TEXT, v_current_credits;
    RETURN;
  END IF;

  v_new_balance := v_current_credits - 1;

  -- Atomic compare-and-set: only succeeds if no one else assigned this
  -- lead between the check above and now. Postgres re-evaluates this
  -- WHERE clause against the committed row, so a concurrent winner is
  -- always detected correctly rather than silently overwritten.
  UPDATE public.leads
  SET assigned_to = p_company_id, updated_at = NOW()
  WHERE id = p_lead_id AND assigned_to IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_assigned'::TEXT, v_current_credits;
    RETURN;
  END IF;

  UPDATE public.companies
  SET credits = v_new_balance, updated_at = NOW()
  WHERE id = p_company_id;

  INSERT INTO public.credit_ledger (company_id, change_amount, balance_after, reason, reference_id)
  VALUES (p_company_id, -1, v_new_balance, 'lead_assignment', 'lead-' || p_lead_id::TEXT);

  RETURN QUERY SELECT 'assigned'::TEXT, v_new_balance;
END;
$$;

-- ============================================================
-- B. assign_secondary_lead — creates a COPIED lead row for contractor #2/#3
-- ============================================================
-- Returns exactly one row. status is one of:
--   'assigned'             — child lead created, credit deducted, ledger written
--   'company_not_found'    — p_company_id does not exist
--   'insufficient_credits' — company has 0 credits
--   'already_assigned'     — idx_leads_unique_company_per_inquiry already
--                            has a row for this (parent_lead_id, company)
--                            pair (caught as a unique_violation)
-- new_lead_id is the new leads.id for 'assigned', otherwise NULL.
-- new_balance is the balance after the call, NULL only for
-- 'company_not_found'.
--
-- A p_parent_lead_id that does not correspond to a real leads.id will
-- raise a foreign_key_violation from the INSERT (parent_lead_id's FK,
-- added in migration 005) rather than return a status row — this is
-- deliberate: distributeLead() always calls this with the id of a lead
-- row it just read from the database, so hitting this in practice means
-- a real bug upstream, and the caller must treat any RPC-level error the
-- same way it treats a non-'assigned' status: no notification.
CREATE OR REPLACE FUNCTION assign_secondary_lead(
  p_parent_lead_id BIGINT,
  p_company_id BIGINT,
  p_customer_name TEXT,
  p_customer_email TEXT,
  p_customer_phone TEXT,
  p_postcode TEXT,
  p_btu INTEGER,
  p_room_type TEXT,
  p_property_type TEXT
)
RETURNS TABLE (status TEXT, new_lead_id BIGINT, new_balance INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_credits INTEGER;
  v_new_balance INTEGER;
  v_new_lead_id BIGINT;
BEGIN
  SELECT credits INTO v_current_credits
  FROM public.companies
  WHERE id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'company_not_found'::TEXT, NULL::BIGINT, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_current_credits <= 0 THEN
    RETURN QUERY SELECT 'insufficient_credits'::TEXT, NULL::BIGINT, v_current_credits;
    RETURN;
  END IF;

  v_new_balance := v_current_credits - 1;

  BEGIN
    INSERT INTO public.leads (
      customer_name, customer_email, customer_phone, postcode, btu,
      room_type, property_type, status, assigned_to, parent_lead_id
    ) VALUES (
      p_customer_name, p_customer_email, p_customer_phone, p_postcode, p_btu,
      p_room_type, p_property_type, 'new', p_company_id, p_parent_lead_id
    )
    RETURNING id INTO v_new_lead_id;
  EXCEPTION WHEN unique_violation THEN
    -- idx_leads_unique_company_per_inquiry rejected a duplicate
    -- (parent_lead_id, company) pair — do not deduct a credit for it.
    RETURN QUERY SELECT 'already_assigned'::TEXT, NULL::BIGINT, v_current_credits;
    RETURN;
  END;

  UPDATE public.companies
  SET credits = v_new_balance, updated_at = NOW()
  WHERE id = p_company_id;

  INSERT INTO public.credit_ledger (company_id, change_amount, balance_after, reason, reference_id)
  VALUES (p_company_id, -1, v_new_balance, 'lead_assignment', 'lead-' || v_new_lead_id::TEXT);

  RETURN QUERY SELECT 'assigned'::TEXT, v_new_lead_id, v_new_balance;
END;
$$;

-- ============================================================
-- Permissions — same convention as 003/004: only the backend
-- (service_role) may call these; no direct client access.
-- ============================================================
GRANT EXECUTE ON FUNCTION assign_primary_lead(BIGINT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION assign_secondary_lead(BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION assign_primary_lead(BIGINT, BIGINT) FROM anon;
REVOKE EXECUTE ON FUNCTION assign_primary_lead(BIGINT, BIGINT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION assign_primary_lead(BIGINT, BIGINT) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION assign_secondary_lead(BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION assign_secondary_lead(BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION assign_secondary_lead(BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
