# 03-rls-permissions.md — Row-Level Security & Permissions

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 02-database-tables.md, 04-payment-rpcs.md

---

## Overview

This document contains all Row-Level Security (RLS) policies and GRANT/REVOKE permissions.

**Authoritative definitions:**
- All RLS policies
- All GRANT/REVOKE statements
- Service role permissions
- Anon role permissions
- Authenticated role permissions

---

## Authenticated-User-to-Company Relationship

The schema assumes a `company_members` table linking authenticated users to companies:

```sql
CREATE TABLE company_members (
  company_id UUID NOT NULL REFERENCES companies(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, user_id)
);

-- Enable RLS on company_members
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own memberships
CREATE POLICY auth_read_own_memberships ON company_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Policy: Service role can read all memberships (for backend operations)
CREATE POLICY service_read_all_memberships ON company_members
  FOR SELECT TO service_role
  USING (true);
```

All RLS policies use this relationship, NOT `company_id = auth.uid()` directly.

**See:** 02-database-tables.md for `company_members` table schema

---

## Service Role (Backend API)

```sql
-- Table access
GRANT SELECT, INSERT, UPDATE ON payment_reservations TO service_role;
GRANT SELECT ON credit_packages TO service_role;
GRANT SELECT, UPDATE ON companies TO service_role;
GRANT SELECT, INSERT, UPDATE ON receipt_outbox TO service_role;
GRANT SELECT, INSERT ON purchases TO service_role;
GRANT SELECT, INSERT ON credit_ledger TO service_role;
GRANT SELECT ON company_members TO service_role;

-- RPC execution
GRANT EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION expire_pending_reservation(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION claim_receipt_job() TO service_role;
GRANT EXECUTE ON FUNCTION complete_receipt_job(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fail_receipt_job(UUID) TO service_role;
```

---

## Anon Role (Public)

```sql
-- No table access
REVOKE ALL ON payment_reservations FROM anon;
REVOKE ALL ON credit_packages FROM anon;
REVOKE ALL ON companies FROM anon;
REVOKE ALL ON receipt_outbox FROM anon;
REVOKE ALL ON purchases FROM anon;
REVOKE ALL ON credit_ledger FROM anon;
REVOKE ALL ON company_members FROM anon;

-- No RPC execution
REVOKE EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION expire_pending_reservation(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_receipt_job() FROM anon;
REVOKE EXECUTE ON FUNCTION complete_receipt_job(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION fail_receipt_job(UUID) FROM anon;
```

---

## Authenticated Role (Contractor Portal)

```sql
-- Read own payment history only (via company_members relationship)
GRANT SELECT ON payment_reservations TO authenticated;
CREATE POLICY auth_read_own_reservations ON payment_reservations
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- Read own purchase history
GRANT SELECT ON purchases TO authenticated;
CREATE POLICY auth_read_own_purchases ON purchases
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- Read own credit ledger
GRANT SELECT ON credit_ledger TO authenticated;
CREATE POLICY auth_read_own_ledger ON credit_ledger
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- Read own company data (including credits/has_purchased for application logic)
GRANT SELECT ON companies TO authenticated;
CREATE POLICY auth_read_own_company ON companies
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT company_id FROM company_members WHERE user_id = auth.uid()
    )
  );

-- No direct writes to payment-related tables
REVOKE INSERT, UPDATE, DELETE ON payment_reservations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON purchases FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON credit_ledger FROM authenticated;
REVOKE UPDATE ON companies FROM authenticated;
REVOKE ALL ON receipt_outbox FROM authenticated;

-- No RPC execution (prevents bypassing server-authoritative pricing)
REVOKE EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION expire_pending_reservation(UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION claim_receipt_job() FROM authenticated;
REVOKE EXECUTE ON FUNCTION complete_receipt_job(UUID, TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION fail_receipt_job(UUID) FROM authenticated;
```

---

## PUBLIC Role

```sql
-- Revoke all RPC execution from PUBLIC
REVOKE EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION expire_pending_reservation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_receipt_job() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_receipt_job(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_receipt_job(UUID) FROM PUBLIC;
```

---

## RPC Security

All RPCs use `SECURITY DEFINER` with hardened `search_path` and schema-qualified objects:

```sql
CREATE OR REPLACE FUNCTION create_payment_reservation(
  p_company_id UUID,
  p_package_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_package public.credit_packages%ROWTYPE;
  v_is_first_purchase BOOLEAN;
  v_final_price_pence INTEGER;
  v_reservation_id UUID;
BEGIN
  -- Validate package exists and is active
  SELECT * INTO v_package
  FROM public.credit_packages
  WHERE id = p_package_id AND active = TRUE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or inactive package: %', p_package_id;
  END IF;
  
  -- Check if company exists and get purchase history
  SELECT has_purchased INTO v_is_first_purchase
  FROM public.companies
  WHERE id = p_company_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company not found: %', p_company_id;
  END IF;
  
  -- Determine first purchase status (trusted server-side logic)
  v_is_first_purchase := NOT v_is_first_purchase;
  
  -- Calculate final price with discount if applicable
  IF v_is_first_purchase THEN
    v_final_price_pence := v_package.price_pence * (100 - v_package.first_purchase_discount_percent) / 100;
  ELSE
    v_final_price_pence := v_package.price_pence;
  END IF;
  
  -- Create reservation with immutable pricing snapshot
  INSERT INTO public.payment_reservations (
    company_id,
    package_id,
    credits,
    amount_pence,
    currency,
    is_first_purchase,
    status
  ) VALUES (
    p_company_id,
    p_package_id,
    v_package.credits,
    v_final_price_pence,
    'gbp',
    v_is_first_purchase,
    'pending'
  )
  RETURNING id INTO v_reservation_id;
  
  RETURN v_reservation_id;
END;
$$;
```

This ensures:
- Functions run with owner privileges (bypassing RLS)
- No search_path injection attacks
- Caller permissions don't matter (controlled by GRANT/REVOKE)
- All table references are schema-qualified

**See:** 04-payment-rpcs.md for complete RPC definitions

---

## Security Properties

| Property | Enforcement |
|----------|-------------|
| Users cannot modify payment_reservations directly | `REVOKE INSERT, UPDATE, DELETE` |
| Users cannot modify purchases directly | `REVOKE INSERT, UPDATE, DELETE` |
| Users cannot modify company credits directly | `REVOKE UPDATE ON companies` |
| Users cannot modify has_purchased directly | `REVOKE UPDATE ON companies` |
| Users cannot modify credit_ledger directly | `REVOKE INSERT, UPDATE, DELETE` |
| Users cannot modify receipt_outbox directly | `REVOKE ALL` |
| Users cannot call payment RPCs directly | `REVOKE EXECUTE` from all roles except `service_role` |
| Users can only read own data | RLS policies via `company_members` |
| RPCs bypass RLS safely | `SECURITY DEFINER` + `search_path` hardening |
| Pricing is server-authoritative | RPCs derive from `credit_packages`, not client input |

---

## Summary

This document contains all RLS policies and permissions. All sensitive operations are restricted to `service_role` only. Authenticated users can only read their own data via RLS policies.

**Next:** See 04-payment-rpcs.md for payment RPC function definitions.
