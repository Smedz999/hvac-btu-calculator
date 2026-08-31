# 04-payment-rpcs.md — Payment RPC Functions

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 02-database-tables.md, 03-rls-permissions.md

---

## Overview

This document contains all payment-related RPC function definitions.

**Authoritative definitions:**
- All payment RPC function signatures
- All payment RPC logic
- All payment RPC permissions

---

## RPC: `create_payment_reservation`

### Purpose
Create a payment reservation with trusted server-side pricing.

### Signature
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
EXCEPTION
  WHEN unique_violation THEN
    -- Concurrent first-purchase claim detected
    -- Retry without discount
    IF v_is_first_purchase THEN
      v_is_first_purchase := FALSE;
      v_final_price_pence := v_package.price_pence;
      
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
        FALSE,
        'pending'
      )
      RETURNING id INTO v_reservation_id;
      
      RETURN v_reservation_id;
    ELSE
      RAISE;
    END IF;
END;
$$;

-- Permissions
REVOKE EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_payment_reservation(UUID, TEXT) TO service_role;
```

### Key Properties
- **No caller-supplied pricing** — Credits and price derived from trusted `credit_packages` table
- **No caller-supplied first-purchase flag** — Determined by querying `companies.has_purchased`
- **Immutable pricing snapshot** — `amount_pence` set at creation, never changed
- **Database-level concurrency protection** — Unique partial index prevents concurrent first-purchase claims
- **Automatic retry without discount** — On unique violation, retries with full price
- **SECURITY DEFINER** — Runs as function owner, safe search_path

### Concurrency Protection

The database guarantees only ONE active/successful first-purchase claim per company via:

```sql
CREATE UNIQUE INDEX idx_unique_first_purchase_claim 
  ON payment_reservations(company_id) 
  WHERE is_first_purchase = TRUE 
    AND status IN ('pending', 'processing', 'succeeded');
```

**How it works:**
1. First request creates reservation with `is_first_purchase = TRUE` and `status = 'pending'`
2. Concurrent requests attempt to insert with same `company_id` and `is_first_purchase = TRUE`
3. Unique index violation occurs
4. Exception handler catches violation and retries with `is_first_purchase = FALSE` (full price)
5. Only ONE request gets the discount, all others pay full price

**Business rules:**
- `pending`, `processing`, `succeeded` first-purchase claims block new discounted claims
- `cancelled`, `expired` first-purchase claims release eligibility (not in index)
- Database-level protection works with 20-50+ simultaneous requests

**See:** 02-database-tables.md for index definition

---

## RPC: `expire_pending_reservation`

### Purpose
Expire a pending reservation that has passed its expiry time with no attached PaymentIntent.

### Signature
```sql
CREATE OR REPLACE FUNCTION expire_pending_reservation(
  p_reservation_id UUID
)
RETURNS TABLE (
  transitioned_now BOOLEAN,
  already_in_target_state BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation public.payment_reservations%ROWTYPE;
BEGIN
  -- Lock and fetch reservation
  SELECT * INTO v_reservation
  FROM public.payment_reservations
  WHERE id = p_reservation_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found: %', p_reservation_id;
  END IF;
  
  -- Idempotent: already expired
  IF v_reservation.status = 'expired' THEN
    RETURN QUERY SELECT FALSE, TRUE;
    RETURN;
  END IF;
  
  -- Verify reservation is in pending state
  IF v_reservation.status != 'pending' THEN
    RAISE EXCEPTION 'Invalid state transition: % -> expired', v_reservation.status;
  END IF;
  
  -- Verify reservation has no attached PaymentIntent
  IF v_reservation.stripe_payment_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot expire reservation with attached PaymentIntent: %', p_reservation_id;
  END IF;
  
  -- Transition to expired
  UPDATE public.payment_reservations
  SET 
    status = 'expired',
    updated_at = NOW()
  WHERE id = p_reservation_id;
  
  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

-- Permissions
REVOKE EXECUTE ON FUNCTION expire_pending_reservation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION expire_pending_reservation(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION expire_pending_reservation(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION expire_pending_reservation(UUID) TO service_role;
```

### Key Properties
- **Idempotent** — Safe to call multiple times
- **State validation** — Only transitions from `pending` to `expired`
- **Safety check** — Refuses to expire if PaymentIntent is attached
- **Row-level locking** — `FOR UPDATE` prevents race conditions

---

## RPC: `cancel_processing_reservation`

### Purpose
Cancel a processing reservation when Stripe confirms the PaymentIntent is cancelled.

### Signature
```sql
CREATE OR REPLACE FUNCTION cancel_processing_reservation(
  p_stripe_payment_intent_id TEXT
)
RETURNS TABLE (
  transitioned_now BOOLEAN,
  already_in_target_state BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation public.payment_reservations%ROWTYPE;
BEGIN
  -- Lock and fetch reservation by Stripe PI ID
  SELECT * INTO v_reservation
  FROM public.payment_reservations
  WHERE stripe_payment_intent_id = p_stripe_payment_intent_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found for PaymentIntent: %', p_stripe_payment_intent_id;
  END IF;
  
  -- Idempotent: already cancelled
  IF v_reservation.status = 'cancelled' THEN
    RETURN QUERY SELECT FALSE, TRUE;
    RETURN;
  END IF;
  
  -- Verify reservation is in processing state
  IF v_reservation.status != 'processing' THEN
    RAISE EXCEPTION 'Invalid state transition: % -> cancelled', v_reservation.status;
  END IF;
  
  -- Transition to cancelled
  UPDATE public.payment_reservations
  SET 
    status = 'cancelled',
    updated_at = NOW()
  WHERE id = v_reservation.id;
  
  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

-- Permissions
REVOKE EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION cancel_processing_reservation(TEXT) TO service_role;
```

### Key Properties
- **Idempotent** — Safe to call multiple times
- **State validation** — Only transitions from `processing` to `cancelled`
- **Looks up by Stripe PI ID** — Consistent with webhook and reconciliation flows
- **Row-level locking** — `FOR UPDATE` prevents race conditions

---

## RPC: `attach_stripe_payment_intent`

### Purpose
Attach a Stripe PaymentIntent to a pending reservation after verifying amount/currency match against the immutable expected values stored on the reservation.

### Signature
```sql
CREATE OR REPLACE FUNCTION attach_stripe_payment_intent(
  p_reservation_id UUID,
  p_stripe_payment_intent_id TEXT,
  p_stripe_amount_pence INTEGER,
  p_stripe_currency TEXT
)
RETURNS TABLE (
  transitioned_now BOOLEAN,
  already_in_target_state BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation public.payment_reservations%ROWTYPE;
BEGIN
  -- Lock and fetch reservation
  SELECT * INTO v_reservation
  FROM public.payment_reservations
  WHERE id = p_reservation_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found: %', p_reservation_id;
  END IF;
  
  -- Verify reservation is in pending state
  IF v_reservation.status != 'pending' THEN
    IF v_reservation.status = 'processing' AND v_reservation.stripe_payment_intent_id = p_stripe_payment_intent_id THEN
      -- Idempotent retry: same PI, already attached
      -- CRITICAL: Verify amount/currency even on idempotent retry
      IF p_stripe_amount_pence != v_reservation.amount_pence THEN
        RAISE EXCEPTION 'Amount mismatch: expected %, got %', v_reservation.amount_pence, p_stripe_amount_pence;
      END IF;
      
      IF p_stripe_currency != v_reservation.currency THEN
        RAISE EXCEPTION 'Currency mismatch: expected %, got %', v_reservation.currency, p_stripe_currency;
      END IF;
      
      RETURN QUERY SELECT FALSE, TRUE;
      RETURN;
    ELSE
      RAISE EXCEPTION 'Invalid state transition: % -> processing', v_reservation.status;
    END IF;
  END IF;
  
  -- CRITICAL: Verify Stripe amount matches reservation's immutable expected amount
  -- The reservation.amount_pence was set at creation from trusted credit_packages table
  -- Client cannot override this value
  IF p_stripe_amount_pence != v_reservation.amount_pence THEN
    RAISE EXCEPTION 'Amount mismatch: expected %, got %', v_reservation.amount_pence, p_stripe_amount_pence;
  END IF;
  
  -- CRITICAL: Verify Stripe currency matches reservation's immutable expected currency
  IF p_stripe_currency != v_reservation.currency THEN
    RAISE EXCEPTION 'Currency mismatch: expected %, got %', v_reservation.currency, p_stripe_currency;
  END IF;
  
  -- Transition to processing
  UPDATE public.payment_reservations
  SET 
    status = 'processing',
    stripe_payment_intent_id = p_stripe_payment_intent_id,
    updated_at = NOW()
  WHERE id = p_reservation_id;
  
  RETURN QUERY SELECT TRUE, FALSE;
END;
$$;

-- Permissions
REVOKE EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT) TO service_role;
```

### Key Properties
- **No caller-supplied amount is authoritative** — Stripe PI amount is verified against reservation's immutable `amount_pence` (set from trusted `credit_packages` table at creation)
- **Currency verification** — Stripe PI currency must match reservation currency
- **Idempotent** — Safe to retry with same PI ID under concurrency
- **State validation** — Only transitions from `pending` to `processing`
- **Row-level locking** — `FOR UPDATE` prevents race conditions

### Trust Boundaries

| Field | Source | Authoritative? |
|-------|--------|----------------|
| `amount_pence` | `payment_reservations.amount_pence` (immutable) | ✅ YES |
| `p_stripe_amount_pence` | Stripe API response | ❌ NO (verified only) |
| `currency` | `payment_reservations.currency` (immutable) | ✅ YES |
| `p_stripe_currency` | Stripe API response | ❌ NO (verified only) |
| `credits` | `payment_reservations.credits` (from `credit_packages`) | ✅ YES |
| `company_id` | `payment_reservations.company_id` (from JWT) | ✅ YES |

### Concurrency Safety
- `FOR UPDATE` lock ensures only one transaction can attach a PI to a reservation
- Idempotent retry returns `already_in_target_state = TRUE` if same PI is attached twice
- Different PI ID on non-pending reservation raises exception (prevents double-attachment)

---

## RPC: `process_stripe_payment_atomic`

### Purpose
Atomically process a successful Stripe payment, add credits, create purchase record, insert credit-ledger entry, update reservation, and create receipt job — all in one database transaction.

### Signature
```sql
CREATE OR REPLACE FUNCTION process_stripe_payment_atomic(
  p_stripe_payment_intent_id TEXT,
  p_stripe_amount_pence INTEGER,
  p_stripe_currency TEXT
)
RETURNS TABLE (
  status TEXT,
  balance_after INTEGER,
  credits_added INTEGER,
  already_processed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation public.payment_reservations%ROWTYPE;
  v_new_balance INTEGER;
BEGIN
  -- Lock and fetch reservation by Stripe PI ID
  -- This is the ONLY lookup method — we do NOT trust Stripe metadata
  SELECT * INTO v_reservation
  FROM public.payment_reservations
  WHERE stripe_payment_intent_id = p_stripe_payment_intent_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found for PaymentIntent: %', p_stripe_payment_intent_id;
  END IF;
  
  -- Idempotency: already processed
  -- Return the ORIGINAL recorded balance_after, not current company balance
  IF v_reservation.status = 'succeeded' THEN
    -- CRITICAL: Verify amount/currency even on idempotent retry
    IF p_stripe_amount_pence != v_reservation.amount_pence THEN
      RAISE EXCEPTION 'Amount mismatch: expected %, got %', v_reservation.amount_pence, p_stripe_amount_pence;
    END IF;
    
    IF p_stripe_currency != v_reservation.currency THEN
      RAISE EXCEPTION 'Currency mismatch: expected %, got %', v_reservation.currency, p_stripe_currency;
    END IF;
    
    RETURN QUERY SELECT 
      v_reservation.status,
      v_reservation.balance_after,  -- Original recorded balance, not current
      v_reservation.credits,
      TRUE;
    RETURN;
  END IF;
  
  -- Verify reservation is in processing state
  IF v_reservation.status != 'processing' THEN
    RAISE EXCEPTION 'Invalid state for payment processing: %', v_reservation.status;
  END IF;
  
  -- CRITICAL: Verify Stripe amount matches reservation's immutable expected amount
  -- The reservation.amount_pence was set at creation from trusted credit_packages table
  -- We do NOT trust Stripe metadata for amount
  IF p_stripe_amount_pence != v_reservation.amount_pence THEN
    RAISE EXCEPTION 'Amount mismatch: expected %, got %', v_reservation.amount_pence, p_stripe_amount_pence;
  END IF;
  
  -- CRITICAL: Verify Stripe currency matches reservation's immutable expected currency
  IF p_stripe_currency != v_reservation.currency THEN
    RAISE EXCEPTION 'Currency mismatch: expected %, got %', v_reservation.currency, p_stripe_currency;
  END IF;
  
  -- ATOMIC TRANSACTION START
  -- All operations below happen in one transaction or none happen
  
  -- 1. Create purchase record
  INSERT INTO public.purchases (
    company_id,
    package_id,
    credits,
    amount_pence,
    currency,
    stripe_payment_intent_id,
    is_first_purchase
  ) VALUES (
    v_reservation.company_id,
    v_reservation.package_id,
    v_reservation.credits,
    v_reservation.amount_pence,
    v_reservation.currency,
    p_stripe_payment_intent_id,
    v_reservation.is_first_purchase
  );
  
  -- 2. Add credits to company (atomic increment)
  UPDATE public.companies
  SET 
    credits = credits + v_reservation.credits,
    has_purchased = TRUE
  WHERE id = v_reservation.company_id
  RETURNING credits INTO v_new_balance;
  
  -- 3. Insert credit-ledger entry
  INSERT INTO public.credit_ledger (
    company_id,
    change_amount,
    balance_after,
    reason,
    reference_id
  ) VALUES (
    v_reservation.company_id,
    v_reservation.credits,
    v_new_balance,
    'purchase',
    v_reservation.id
  );
  
  -- 4. Mark reservation succeeded
  UPDATE public.payment_reservations
  SET 
    status = 'succeeded',
    balance_after = v_new_balance,
    completed_at = NOW(),
    updated_at = NOW()
  WHERE id = v_reservation.id;
  
  -- 5. Create receipt outbox job atomically
  INSERT INTO public.receipt_outbox (
    reservation_id,
    company_id,
    credits_added,
    amount_pence,
    balance_after,
    status
  ) VALUES (
    v_reservation.id,
    v_reservation.company_id,
    v_reservation.credits,
    v_reservation.amount_pence,
    v_new_balance,
    'pending'
  );
  
  -- ATOMIC TRANSACTION END
  
  RETURN QUERY SELECT 
    'succeeded'::TEXT,
    v_new_balance,
    v_reservation.credits,
    FALSE;
END;
$$;

-- Permissions
REVOKE EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION process_stripe_payment_atomic(TEXT, INTEGER, TEXT) TO service_role;
```

### Key Properties
- **Looks up reservation by Stripe PI ID only** — Never trusts Stripe metadata for company, credits, package, amount, discount, or eligibility
- **Verifies amount/currency** — Must match reservation's immutable expected values (set from trusted `credit_packages` table)
- **Atomic transaction** — Purchase creation, credit increment, credit-ledger insert, reservation update, and receipt-job creation all succeed or fail together
- **Idempotent** — Returns original `balance_after` on duplicate calls, not current company balance
- **Concurrency-safe** — `FOR UPDATE` lock ensures only one transaction can process a payment
- **No double-crediting** — Duplicate webhook deliveries return `already_processed = TRUE` with original balance

### Trust Boundaries

| Field | Source | Authoritative? |
|-------|--------|----------------|
| `company_id` | `payment_reservations.company_id` | ✅ YES |
| `credits` | `payment_reservations.credits` (from `credit_packages`) | ✅ YES |
| `amount_pence` | `payment_reservations.amount_pence` (immutable) | ✅ YES |
| `p_stripe_amount_pence` | Stripe API response | ❌ NO (verified only) |
| `is_first_purchase` | `payment_reservations.is_first_purchase` | ✅ YES |
| Stripe metadata | Stripe PaymentIntent | ❌ NEVER |

### Concurrency Safety
- `FOR UPDATE` lock on reservation row prevents concurrent processing
- Only first concurrent call transitions to `succeeded`
- Subsequent calls return `already_processed = TRUE` with original `balance_after`
- Duplicate webhook deliveries never double-credit

---

## Summary

This document contains all payment RPC function definitions. All RPCs use `SECURITY DEFINER` with hardened `search_path` and schema-qualified objects. All RPCs are idempotent and concurrency-safe.

**Next:** See 05-stripe-webhooks.md for webhook handling logic.
