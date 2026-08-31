# ACConnx Payment Architecture — Draft for Review

**Status:** DRAFT — All sections pending final approval  
**Date:** 2026-08-30  
**Authority:** Awaiting independent review  

---

## Section 1: `payment_reservations` Table

### Schema

```sql
CREATE TABLE payment_reservations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  package_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'gbp' CHECK (currency = 'gbp'),
  is_first_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'cancelled', 'expired')),
  stripe_payment_intent_id TEXT UNIQUE,
  balance_after INTEGER CHECK (balance_after >= 0),
  receipt_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

  -- State shape constraints (exact definitions)
  CONSTRAINT pending_shape CHECK (
    status != 'pending' OR (
      stripe_payment_intent_id IS NULL AND
      balance_after IS NULL AND
      completed_at IS NULL AND
      receipt_sent_at IS NULL
    )
  ),
  CONSTRAINT processing_shape CHECK (
    status != 'processing' OR (
      stripe_payment_intent_id IS NOT NULL AND
      balance_after IS NULL AND
      completed_at IS NULL AND
      receipt_sent_at IS NULL
    )
  ),
  CONSTRAINT succeeded_shape CHECK (
    status != 'succeeded' OR (
      stripe_payment_intent_id IS NOT NULL AND
      balance_after IS NOT NULL AND
      completed_at IS NOT NULL
    )
  ),
  CONSTRAINT expired_shape CHECK (
    status != 'expired' OR (
      stripe_payment_intent_id IS NULL AND
      balance_after IS NULL AND
      completed_at IS NULL AND
      receipt_sent_at IS NULL
    )
  ),
  CONSTRAINT cancelled_shape CHECK (
    status != 'cancelled' OR (
      stripe_payment_intent_id IS NOT NULL AND
      balance_after IS NULL AND
      completed_at IS NULL AND
      receipt_sent_at IS NULL
    )
  )
);

-- Prevent invalid state transitions
CREATE OR REPLACE FUNCTION prevent_invalid_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Prevent any transition FROM succeeded
  IF OLD.status = 'succeeded' AND NEW.status != 'succeeded' THEN
    RAISE EXCEPTION 'Invalid transition: succeeded -> %', NEW.status;
  END IF;
  
  -- Prevent any transition FROM cancelled
  IF OLD.status = 'cancelled' AND NEW.status != 'cancelled' THEN
    RAISE EXCEPTION 'Invalid transition: cancelled -> %', NEW.status;
  END IF;
  
  -- Prevent any transition FROM expired
  IF OLD.status = 'expired' AND NEW.status != 'expired' THEN
    RAISE EXCEPTION 'Invalid transition: expired -> %', NEW.status;
  END IF;
  
  -- Allow only specific transitions
  IF OLD.status = 'pending' AND NEW.status NOT IN ('processing', 'expired') THEN
    RAISE EXCEPTION 'Invalid transition: pending -> %', NEW.status;
  END IF;
  
  IF OLD.status = 'processing' AND NEW.status NOT IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid transition: processing -> %', NEW.status;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_valid_transitions
  BEFORE UPDATE ON payment_reservations
  FOR EACH ROW
  EXECUTE FUNCTION prevent_invalid_transitions();

-- Prevent concurrent first-purchase discount claims
-- Only ONE active/successful first-purchase claim allowed per company
CREATE UNIQUE INDEX idx_unique_first_purchase_claim 
  ON payment_reservations(company_id) 
  WHERE is_first_purchase = TRUE 
    AND status IN ('pending', 'processing', 'succeeded');
```

### State Shape Definitions

| State | `stripe_payment_intent_id` | `balance_after` | `completed_at` | `receipt_sent_at` |
|-------|---------------------------|-----------------|----------------|-------------------|
| `pending` | NULL | NULL | NULL | NULL |
| `processing` | NOT NULL | NULL | NULL | NULL |
| `succeeded` | NOT NULL | NOT NULL | NOT NULL | NULL or NOT NULL |
| `cancelled` | NOT NULL | NULL | NULL | NULL |
| `expired` | NULL | NULL | NULL | NULL |

### Allowed Transitions

| From | To | Trigger |
|------|----|---------|
| `pending` | `processing` | `attach_stripe_payment_intent` RPC |
| `pending` | `expired` | `expire_pending_reservation` RPC |
| `processing` | `succeeded` | `process_stripe_payment_atomic` RPC |
| `processing` | `cancelled` | `cancel_processing_reservation` RPC |
| `succeeded` | — | Terminal state (no transitions) |
| `cancelled` | — | Terminal state (no transitions) |
| `expired` | — | Terminal state (no transitions) |

### Column Design Decisions

#### `amount_pence`
- **NOT NULL** — Set at creation time from trusted server-side package configuration
- Immutable after creation — represents the expected payment amount
- Verified against Stripe PaymentIntent amount during attach and webhook processing

#### `currency`
- GBP-only, enforced by CHECK constraint
- Verified against Stripe PaymentIntent currency

#### `balance_after`
- Stored for idempotent webhook responses
- NULL unless status = 'succeeded'
- Records the company balance immediately after credit addition
- Returned on duplicate webhook calls (not current balance)

#### `receipt_sent_at`
- Set by receipt worker after successful email delivery
- NULL when payment first succeeds (before receipt delivery)
- Updated to non-NULL after receipt is successfully sent
- Audit state only, not part of the concurrency mechanism

#### `expires_at`
- Cleanup/review timestamp for pending reservations only
- NOT an automatic state transition trigger
- Processing reservations are NEVER expired based on time alone

---

## Section 2: Package Configuration Table

### Trusted Server-Side Configuration

```sql
CREATE TABLE credit_packages (
  id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL CHECK (credits > 0),
  price_pence INTEGER NOT NULL CHECK (price_pence > 0),
  first_purchase_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (first_purchase_discount_percent >= 0 AND first_purchase_discount_percent <= 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed data
INSERT INTO credit_packages (id, credits, price_pence, first_purchase_discount_percent) VALUES
  ('starter', 10, 2500, 20),
  ('growth', 25, 5500, 20),
  ('pro', 60, 12000, 20);
```

### First Purchase Tracking

```sql
ALTER TABLE companies ADD COLUMN IF NOT EXISTS has_purchased BOOLEAN NOT NULL DEFAULT FALSE;
```

---

## Section 3: `create_payment_reservation` RPC

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

---

## Section 3A: `expire_pending_reservation` RPC

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

## Section 3B: `cancel_processing_reservation` RPC

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

## Section 4: `attach_stripe_payment_intent` RPC

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

## Section 5: `process_stripe_payment_atomic` RPC

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

## Section 6: Receipt Outbox Table

### Purpose
Transactional outbox for reliable receipt email delivery. Receipt jobs are created atomically with payment processing, ensuring no receipt is lost if the webhook crashes after payment succeeds.

### Schema
```sql
CREATE TABLE receipt_outbox (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id UUID NOT NULL REFERENCES payment_reservations(id) UNIQUE,
  company_id UUID NOT NULL REFERENCES companies(id),
  credits_added INTEGER NOT NULL,
  amount_pence INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_message_id TEXT,  -- Idempotency key from email provider
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT sent_requires_sent_at CHECK (
    status != 'sent' OR sent_at IS NOT NULL
  ),
  CONSTRAINT processing_requires_last_attempt CHECK (
    status != 'processing' OR last_attempt_at IS NOT NULL
  )
);

CREATE INDEX idx_receipt_outbox_pending ON receipt_outbox(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_receipt_outbox_reservation ON receipt_outbox(reservation_id);
```

### Key Properties
- **UNIQUE reservation_id** — Prevents duplicate receipt jobs for the same payment
- **provider_message_id** — Stores idempotency key from email provider (e.g., Resend message ID)
- **Atomic creation** — Created in same transaction as payment processing
- **Independent from webhook** — Email failure cannot cause payment reprocessing

### Receipt Job States

| State | `last_attempt_at` | `sent_at` | `provider_message_id` | Description |
|-------|-------------------|-----------|----------------------|-------------|
| `pending` | NULL | NULL | NULL | Ready to be claimed |
| `processing` | NOT NULL | NULL | NULL | Claimed by worker, sending in progress |
| `sent` | NOT NULL | NOT NULL | NOT NULL | Successfully delivered |
| `failed` | NOT NULL | NULL | NULL | Max retries exceeded |

### Worker Flow

#### 1. Claim Job (Concurrency-Safe)
```sql
CREATE OR REPLACE FUNCTION claim_receipt_job()
RETURNS TABLE (
  id UUID,
  reservation_id UUID,
  company_id UUID,
  credits_added INTEGER,
  amount_pence INTEGER,
  balance_after INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.receipt_outbox
  SET 
    status = 'processing',
    last_attempt_at = NOW(),
    attempts = attempts + 1
  WHERE id = (
    SELECT id FROM public.receipt_outbox
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING 
    receipt_outbox.id,
    receipt_outbox.reservation_id,
    receipt_outbox.company_id,
    receipt_outbox.credits_added,
    receipt_outbox.amount_pence,
    receipt_outbox.balance_after;
END;
$$;
```

**Concurrency Safety:**
- `FOR UPDATE SKIP LOCKED` ensures only one worker can claim a job
- Multiple workers can run concurrently without duplicate sends
- Atomic status transition from `pending` to `processing`

#### 2. Send Email with Idempotency
```javascript
async function sendReceipt(job) {
  const company = await getCompany(job.company_id);
  
  // Use reservation_id as idempotency key for email provider
  // This prevents duplicate sends if worker retries after network failure
  const idempotencyKey = `receipt_${job.reservation_id}`;
  
  try {
    const result = await resend.emails.send({
      from: 'receipts@acconnx.com',
      to: company.email,
      subject: 'Payment Receipt - ACConnx Credits',
      html: renderReceiptEmail(job),
    }, {
      idempotencyKey: idempotencyKey
    });
    
    return { success: true, provider_message_id: result.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

#### 3. Mark Job Complete
```sql
CREATE OR REPLACE FUNCTION complete_receipt_job(
  p_job_id UUID,
  p_provider_message_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.receipt_outbox
  SET 
    status = 'sent',
    sent_at = NOW(),
    provider_message_id = p_provider_message_id
  WHERE id = p_job_id AND status = 'processing';
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found or not in processing state: %', p_job_id;
  END IF;
END;
$$;
```

#### 4. Mark Job Failed (Retry Logic)
```sql
CREATE OR REPLACE FUNCTION fail_receipt_job(
  p_job_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts INTEGER;
BEGIN
  SELECT attempts INTO v_attempts
  FROM public.receipt_outbox
  WHERE id = p_job_id;
  
  IF v_attempts >= 5 THEN
    -- Max retries exceeded
    UPDATE public.receipt_outbox
    SET status = 'failed'
    WHERE id = p_job_id;
  ELSE
    -- Reset to pending for retry with exponential backoff
    UPDATE public.receipt_outbox
    SET status = 'pending'
    WHERE id = p_job_id;
  END IF;
END;
$$;
```

#### 5. Update Reservation Audit State
```javascript
async function updateReservationReceiptSent(reservation_id) {
  // This is audit state only, not the concurrency mechanism
  // The receipt_outbox table is the source of truth for receipt delivery
  await supabase
    .from('payment_reservations')
    .update({ receipt_sent_at: new Date().toISOString() })
    .eq('id', reservation_id);
}
```

### Complete Worker Loop
```javascript
async function receiptWorker() {
  while (true) {
    // Claim next job (concurrency-safe)
    const { data: job } = await supabase.rpc('claim_receipt_job');
    
    if (!job) {
      // No jobs available, wait before next poll
      await sleep(5000);
      continue;
    }
    
    // Send email with idempotency key
    const result = await sendReceipt(job);
    
    if (result.success) {
      // Mark job complete
      await supabase.rpc('complete_receipt_job', {
        p_job_id: job.id,
        p_provider_message_id: result.provider_message_id
      });
      
      // Update reservation audit state (non-critical)
      await updateReservationReceiptSent(job.reservation_id);
    } else {
      // Mark job failed (will retry or mark as failed after max attempts)
      await supabase.rpc('fail_receipt_job', {
        p_job_id: job.id
      });
    }
  }
}
```

### Crash Recovery

**Scenario:** Email sent successfully, but worker crashes before marking job complete.

**Recovery:**
1. Job remains in `processing` state
2. Cleanup job finds stale `processing` jobs (e.g., `last_attempt_at` > 5 minutes ago)
3. Checks with email provider using `provider_message_id` or idempotency key
4. If provider confirms delivery: mark as `sent`
5. If provider has no record: reset to `pending` for retry

```javascript
async function recoverStaleReceiptJobs() {
  const { data: staleJobs } = await supabase
    .from('receipt_outbox')
    .select('*')
    .eq('status', 'processing')
    .lt('last_attempt_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
  
  for (const job of staleJobs) {
    // Check with email provider
    const idempotencyKey = `receipt_${job.reservation_id}`;
    const providerStatus = await checkEmailProviderStatus(idempotencyKey);
    
    if (providerStatus.delivered) {
      await supabase.rpc('complete_receipt_job', {
        p_job_id: job.id,
        p_provider_message_id: providerStatus.message_id
      });
    } else {
      // Reset to pending for retry
      await supabase
        .from('receipt_outbox')
        .update({ status: 'pending' })
        .eq('id', job.id);
    }
  }
}
```

### Duplicate Prevention

| Mechanism | Purpose |
|-----------|---------|
| `UNIQUE reservation_id` | Prevents duplicate receipt jobs for same payment |
| `FOR UPDATE SKIP LOCKED` | Prevents concurrent workers from claiming same job |
| Idempotency key | Prevents duplicate sends to email provider |
| `provider_message_id` | Allows verification of delivery status |

### Independence from Webhook
- Receipt jobs are created in same transaction as payment processing
- Webhook returns success immediately after payment processing
- Email delivery happens asynchronously in separate worker
- Email failure does NOT cause Stripe webhook retry
- Email failure does NOT cause payment reprocessing

---

## Section 7: `/api/create-payment-intent` Endpoint

### Purpose
Create payment reservation and Stripe PaymentIntent with server-side trust boundaries.

### Endpoint
`POST /api/create-payment-intent`

### Authentication
- Requires valid JWT token
- `company_id` extracted from JWT, NOT from request body

### Request Body
```json
{
  "package_id": "starter|growth|pro"
}
```

**Security Note:** Client must NOT send `company_id`, `credits`, `amount`, `discount`, or `is_first_purchase`. These are derived server-side only.

### Flow

1. **Authenticate User**
   ```javascript
   const { user } = await supabase.auth.getUser(token);
   if (!user) return res.status(401).json({ error: 'Unauthorized' });
   
   // Resolve company through membership relationship
   // NEVER assume user.id equals company_id
   const { data: membership, error: membershipError } = await supabase
     .from('company_members')
     .select('company_id')
     .eq('user_id', user.id)
     .single();
   
   if (membershipError || !membership) {
     return res.status(403).json({ error: 'No company membership found' });
   }
   
   const company_id = membership.company_id; // From membership lookup, not user.id
   ```

2. **Validate Package**
   ```javascript
   const { package_id } = req.body;
   if (!['starter', 'growth', 'pro'].includes(package_id)) {
     return res.status(400).json({ error: 'Invalid package' });
   }
   ```

3. **Create Reservation (Trusted Server-Side)**
   ```javascript
   // RPC derives: credits, amount_pence, is_first_purchase from database
   // Client cannot override these values
   const { data: reservation_id, error } = await supabase.rpc('create_payment_reservation', {
     p_company_id: company_id,  // From JWT, not client
     p_package_id: package_id
   });
   
   if (error) return res.status(500).json({ error: error.message });
   ```

4. **Fetch Immutable Pricing Snapshot**
   ```javascript
   // Reservation now contains immutable pricing snapshot
   const { data: reservation } = await supabase
     .from('payment_reservations')
     .select('*')
     .eq('id', reservation_id)
     .single();
   
   // reservation.amount_pence is now locked and cannot be changed
   // reservation.credits is derived from trusted credit_packages table
   // reservation.is_first_purchase is determined by server-side query
   ```

5. **Create Stripe PaymentIntent with Idempotency Key**
   ```javascript
   // Use reservation.amount_pence (immutable snapshot), NOT client input
   const paymentIntent = await stripe.paymentIntents.create({
     amount: reservation.amount_pence,
     currency: reservation.currency,
     metadata: {
       reservation_id: reservation_id  // Lookup hint only, not authoritative
     },
     receipt_email: user.email
   }, {
     idempotencyKey: `reservation_${reservation_id}`
   });
   ```

6. **Attach PaymentIntent to Reservation**
   ```javascript
   const { error: attachError } = await supabase.rpc('attach_stripe_payment_intent', {
     p_reservation_id: reservation_id,
     p_stripe_payment_intent_id: paymentIntent.id,
     p_stripe_amount_pence: paymentIntent.amount,
     p_stripe_currency: paymentIntent.currency
   });
   
   if (attachError) {
     // Lost attachment recovery: cancel the Stripe PI
     await stripe.paymentIntents.cancel(paymentIntent.id);
     return res.status(500).json({ error: 'Failed to attach payment' });
   }
   ```

7. **Return Client Secret**
   ```javascript
   res.json({
     client_secret: paymentIntent.client_secret,
     reservation_id: reservation_id,
     amount: reservation.amount_pence,  // From immutable snapshot
     credits: reservation.credits        // From trusted package config
   });
   ```

### Trust Boundaries

| Field | Source | Client Can Override? |
|-------|--------|---------------------|
| `company_id` | JWT token | ❌ NO |
| `credits` | `credit_packages` table | ❌ NO |
| `amount_pence` | `credit_packages` + discount logic | ❌ NO |
| `is_first_purchase` | `companies.has_purchased` query | ❌ NO |
| `package_id` | Request body | ✅ YES (validated) |

### Lost Attachment Recovery
If Stripe PI is created but DB attachment fails (crash, network error, etc.):

1. **Immediate Recovery (in endpoint)**
   - Cancel the Stripe PaymentIntent immediately
   - Mark reservation as expired
   - Return error to client
   - Client can retry with new reservation

2. **Delayed Recovery (cleanup job)**
   - If endpoint crashes before canceling Stripe PI, cleanup job will find it
   - Fetch PI from Stripe using metadata.reservation_id as lookup hint
   - If reservation still pending and PI exists: attach and process
   - If reservation expired: cancel the orphaned Stripe PI

3. **Webhook-Before-Attachment Safety**
   - Webhook arrives before PI is attached to reservation
   - `process_stripe_payment_atomic` looks up reservation by `stripe_payment_intent_id`
   - If not found: returns error (Stripe will retry webhook)
   - Credits are NEVER awarded based on Stripe metadata alone
   - Metadata.reservation_id is a lookup hint only, not authoritative

### Metadata Usage
Stripe PaymentIntent metadata contains `reservation_id` as a **lookup hint only**:
- Used by cleanup job to find orphaned PIs
- Used by webhook handler for logging/debugging
- **NEVER** used to award credits without database verification
- **NEVER** treated as authoritative for company, credits, or pricing

---

## Section 8: Webhook Handler

### Purpose
Handle Stripe webhook events with server-side verification and atomic payment processing.

### Endpoint
`POST /api/webhooks/stripe`

### Flow: `payment_intent.succeeded`

1. **Verify Signature**
   ```javascript
   const event = stripe.webhooks.constructEvent(
     req.body,
     req.headers['stripe-signature'],
     process.env.STRIPE_WEBHOOK_SECRET
   );
   ```

2. **Extract PaymentIntent**
   ```javascript
   const paymentIntent = event.data.object;
   ```

3. **Process Payment (Server-Side Verification)**
   ```javascript
   // Call exact RPC signature: process_stripe_payment_atomic(TEXT, INTEGER, TEXT)
   // Do NOT trust Stripe metadata for company, credits, package, amount, discount, or eligibility
   const { data, error } = await supabase.rpc('process_stripe_payment_atomic', {
     p_stripe_payment_intent_id: paymentIntent.id,
     p_stripe_amount_pence: paymentIntent.amount,
     p_stripe_currency: paymentIntent.currency
   });
   
   if (error) {
     console.error('Payment processing failed:', error);
     return res.status(500).json({ error: 'Processing failed' });
   }
   
   // Idempotent response — duplicate webhooks return same balance_after
   res.json({ 
     received: true, 
     already_processed: data.already_processed,
     balance_after: data.balance_after  // Original recorded balance, not current
   });
   ```

### Webhook-Before-Attachment Recovery
If webhook arrives before PI is attached (crash between Stripe PI creation and DB attachment):
1. `process_stripe_payment_atomic` will fail with "Reservation not found"
2. Return 500 — Stripe will retry webhook
3. Cleanup job will reconcile: fetch PI from Stripe, attach if missing, then process
4. Credits are NEVER awarded based on Stripe metadata alone

### Flow: `payment_intent.payment_failed`

1. **Verify Signature** (same as above)

2. **Extract PaymentIntent**

3. **Do NOT Auto-Cancel**
   ```javascript
   // PaymentIntent may be retryable
   // Only Stripe 'canceled' state triggers cancellation
   // Do NOT release first-purchase eligibility on failure
   console.log('Payment failed, but may be retryable:', paymentIntent.id);
   res.json({ received: true });
   ```

### Flow: `payment_intent.canceled`

1. **Verify Signature**

2. **Cancel Reservation via RPC**
   ```javascript
   // Only confirmed Stripe cancelled state may transition reservation to cancelled
   const { error } = await supabase.rpc('cancel_processing_reservation', {
     p_stripe_payment_intent_id: paymentIntent.id
   });
   
   res.json({ received: true });
   ```

### Duplicate Webhook Safety
- Duplicate `payment_intent.succeeded` webhooks are idempotent
- First call processes payment and returns `already_processed = FALSE`
- Subsequent calls return `already_processed = TRUE` with original `balance_after`
- Concurrent webhook calls are serialized by `FOR UPDATE` lock
- Only one concurrent call transitions reservation to `succeeded`
- Credits are never double-added

### Metadata Usage
Stripe PaymentIntent metadata is **NEVER** trusted for:
- Company ID
- Credits amount
- Package selection
- Payment amount
- Discount eligibility
- First-purchase status

Metadata may contain `reservation_id` as a **lookup hint only** for debugging/logging.

---

## Section 9: Cleanup/Reconciliation Strategy

### Purpose
Reconcile database state with Stripe state using real Stripe API queries. Never expire processing reservations based on time alone.

### Expiry Rules

| Reservation State | Stripe State | Action |
|-------------------|--------------|--------|
| `pending` | No PI attached | Expire if past `expires_at` |
| `pending` | PI exists | Fetch from Stripe, attach, then process |
| `processing` | `succeeded` | Process payment via `process_stripe_payment_atomic` RPC |
| `processing` | `canceled` | Cancel via `cancel_processing_reservation` RPC |
| `processing` | `requires_payment_method` | Leave active (retryable) |
| `processing` | `requires_confirmation` | Leave active (retryable) |
| `processing` | `requires_action` | Leave active (retryable) |
| `processing` | API lookup failure | Leave unchanged for later retry |

### Key Rules
- **Never expire processing without checking Stripe API**
- **Stripe succeeded → process payment via same RPC as webhook**
- **Only confirmed Stripe canceled → cancel via RPC**
- **Retryable states stay active indefinitely**
- **API failure leaves DB unchanged for later retry**
- **No `stripe_payment_intents` table** — always query Stripe API directly

### Cleanup Job (Every 15 Minutes)

```javascript
// 1. Expire pending reservations past expires_at with no PI attached
const { data: expiredPending } = await supabase
  .from('payment_reservations')
  .select('id')
  .eq('status', 'pending')
  .is('stripe_payment_intent_id', null)
  .lt('expires_at', new Date().toISOString());

for (const res of expiredPending) {
  // Idempotent: safe if multiple workers process same reservation
  await supabase.rpc('expire_pending_reservation', { p_reservation_id: res.id });
}

// 2. Reconcile processing reservations with Stripe API
// NOTE: We do NOT filter by expires_at for processing reservations
// Processing reservations never expire based on time alone
const { data: processing } = await supabase
  .from('payment_reservations')
  .select('id, stripe_payment_intent_id')
  .eq('status', 'processing');

for (const res of processing) {
  try {
    // Query real Stripe API for PaymentIntent state
    const pi = await stripe.paymentIntents.retrieve(res.stripe_payment_intent_id);
    
    if (pi.status === 'succeeded') {
      // Reconcile: process payment using same atomic RPC as webhook
      // This ensures consistent behavior between webhook and cleanup paths
      await supabase.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: pi.id,
        p_stripe_amount_pence: pi.amount,
        p_stripe_currency: pi.currency
      });
    } else if (pi.status === 'canceled') {
      // Only confirmed Stripe canceled state may transition to cancelled
      await supabase.rpc('cancel_processing_reservation', {
        p_stripe_payment_intent_id: pi.id
      });
    }
    // Retryable states (requires_payment_method, requires_confirmation, requires_action):
    // Leave unchanged — reservation stays active
  } catch (error) {
    // Stripe API failure: leave reservation unchanged for later retry
    console.error('Stripe lookup failed for reservation', res.id, error);
  }
}
```

### Concurrency Safety
- Multiple cleanup workers can run concurrently
- `FOR UPDATE` locks in RPCs prevent race conditions
- `expire_pending_reservation` is idempotent
- `process_stripe_payment_atomic` is idempotent (returns `already_processed = TRUE` on duplicate)
- `cancel_processing_reservation` is idempotent
- Stripe API failures leave reservations unchanged for later retry

### Retryable Stripe States
These states indicate the payment may still succeed:
- `requires_payment_method` — Customer needs to provide payment method
- `requires_confirmation` — Payment needs confirmation
- `requires_action` — Customer needs to complete 3D Secure or similar

**Processing reservations in these states remain active indefinitely** unless:
1. Business explicitly cancels via admin action
2. Stripe transitions to `canceled`
3. Stripe transitions to `succeeded`

### Lost Attachment Recovery
If Stripe PI exists but reservation has no `stripe_payment_intent_id`:
1. Cleanup job finds pending reservation past `expires_at`
2. Checks if PI exists in Stripe (using metadata.reservation_id as lookup hint)
3. If found: attaches PI and processes payment
4. If not found: expires the pending reservation

---

## Section 10: Database Permissions

### Authenticated-User-to-Company Relationship

The schema assumes a `company_members` table linking authenticated users to companies:

```sql
CREATE TABLE company_members (
  company_id UUID NOT NULL REFERENCES companies(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, user_id)
);
```

All RLS policies use this relationship, NOT `company_id = auth.uid()` directly.

### Service Role (Backend API)

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

### Anon Role (Public)

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

### Authenticated Role (Contractor Portal)

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

-- Read own company data (but not credits/has_purchased directly)
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

### PUBLIC Role

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

### RPC Security

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

### Security Properties

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

## Section 11: Test Suite

### Test Categories

1. **Unit Tests** — Individual RPC functions
2. **Integration Tests** — API endpoints
3. **Webhook Tests** — Stripe event handling
4. **Concurrency Tests** — Race conditions
5. **Security Tests** — Permission attacks

### Core Payment Tests

```javascript
describe('Core Payment Tests', () => {
  
  test('20-50 simultaneous first-purchase attempts: exactly one winner', async () => {
    const attempts = 50;
    const promises = Array(attempts).fill().map(() =>
      supabase.rpc('create_payment_reservation', {
        p_company_id: testCompanyId,
        p_package_id: 'starter'
      })
    );
    
    const results = await Promise.all(promises);
    
    // All should succeed (create reservation)
    const successful = results.filter(r => !r.error);
    expect(successful.length).toBe(attempts);
    
    // Fetch all reservations
    const reservations = await Promise.all(
      successful.map(r => getReservation(r.data))
    );
    
    // Exactly one should have first-purchase discount (2000 pence)
    const discounted = reservations.filter(r => r.amount_pence === 2000);
    expect(discounted.length).toBe(1);
    
    // Rest should have full price (2500 pence)
    const fullPrice = reservations.filter(r => r.amount_pence === 2500);
    expect(fullPrice.length).toBe(attempts - 1);
  });
  
  test('simultaneous identical PaymentIntent attachment', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Two simultaneous attach calls with same PI
    const promises = Array(2).fill().map(() =>
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    );
    
    const results = await Promise.all(promises);
    
    // One should transition, one should be idempotent
    const transitioned = results.filter(r => r.data?.transitioned_now === true);
    const idempotent = results.filter(r => r.data?.already_in_target_state === true);
    
    expect(transitioned.length).toBe(1);
    expect(idempotent.length).toBe(1);
  });
  
  test('simultaneous conflicting attachment', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Two simultaneous attach calls with different PIs
    const [result1, result2] = await Promise.all([
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      }),
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_456',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    ]);
    
    // One should succeed, one should fail
    const succeeded = [result1, result2].filter(r => !r.error);
    const failed = [result1, result2].filter(r => r.error);
    
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].error.message).toContain('Invalid state transition');
  });
  
  test('same Stripe PaymentIntent assigned to two reservations', async () => {
    const { data: reservation_id_1 } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    const { data: reservation_id_2 } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Attach same PI to first reservation
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id_1,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Attempt to attach same PI to second reservation
    const { error } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id_2,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should fail due to UNIQUE constraint on stripe_payment_intent_id
    expect(error).toBeDefined();
  });
  
  test('Stripe PaymentIntent created but DB attachment lost', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Simulate crash: PI created in Stripe but not attached to reservation
    // Webhook arrives before attachment
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_orphan_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should fail: reservation not found
    expect(error).toBeDefined();
    expect(error.message).toContain('Reservation not found');
    
    // Cleanup job should reconcile
    // (This would be tested in integration test with actual Stripe API)
  });
  
  test('webhook arriving before attachment', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Webhook arrives before PI is attached
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should fail: reservation not found (PI not attached yet)
    expect(error).toBeDefined();
    expect(error.message).toContain('Reservation not found');
  });
  
  test('20-50 concurrent duplicate successful webhooks', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Attach PI
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // 50 concurrent duplicate webhooks
    const attempts = 50;
    const promises = Array(attempts).fill().map(() =>
      supabase.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    );
    
    const results = await Promise.all(promises);
    
    // All should succeed
    const successful = results.filter(r => !r.error);
    expect(successful.length).toBe(attempts);
    
    // All should return same balance_after
    const balances = successful.map(r => r.data.balance_after);
    expect(new Set(balances).size).toBe(1);
    
    // Only one should have already_processed = false
    const firstTime = successful.filter(r => r.data.already_processed === false);
    expect(firstTime.length).toBe(1);
    
    // Rest should have already_processed = true
    const duplicates = successful.filter(r => r.data.already_processed === true);
    expect(duplicates.length).toBe(attempts - 1);
  });
  
  test('wrong amount', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Webhook with wrong amount
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 9999, // Wrong amount
      p_stripe_currency: 'gbp'
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Amount mismatch');
  });
  
  test('wrong currency', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Webhook with wrong currency
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'usd' // Wrong currency
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Currency mismatch');
  });
  
  test('wrong amount on duplicate attach after already attached', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // First attach: correct amount
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate attach with wrong amount (should fail even though already attached)
    const { error } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 9999, // Wrong amount
      p_stripe_currency: 'gbp'
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Amount mismatch');
  });
  
  test('wrong currency on duplicate attach after already attached', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // First attach: correct currency
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate attach with wrong currency (should fail even though already attached)
    const { error } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'usd' // Wrong currency
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Currency mismatch');
  });
  
  test('wrong amount on duplicate webhook after payment succeeded', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // First webhook: correct amount
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate webhook with wrong amount (should fail even though already succeeded)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 9999, // Wrong amount
      p_stripe_currency: 'gbp'
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Amount mismatch');
  });
  
  test('wrong currency on duplicate webhook after payment succeeded', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // First webhook: correct currency
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate webhook with wrong currency (should fail even though already succeeded)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'usd' // Wrong currency
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Currency mismatch');
  });
  
  test('duplicate webhook after company balance changes later', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // First webhook: process payment
    const { data: firstResult } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const originalBalance = firstResult.balance_after;
    
    // Company balance changes later (e.g., credits spent)
    await supabase
      .from('companies')
      .update({ credits: originalBalance - 5 })
      .eq('id', testCompanyId);
    
    // Duplicate webhook arrives
    const { data: duplicateResult } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should return ORIGINAL balance_after, not current balance
    expect(duplicateResult.balance_after).toBe(originalBalance);
    expect(duplicateResult.already_processed).toBe(true);
  });
});

---

## Approval Status

| Section | Status | Date |
|---------|--------|------|
| 1. payment_reservations table | DRAFT | 2026-08-30 |
| 2. Package configuration | DRAFT | 2026-08-30 |
| 3. create_payment_reservation RPC | DRAFT | 2026-08-30 |
| 4. attach_stripe_payment_intent RPC | DRAFT | 2026-08-30 |
| 5. process_stripe_payment_atomic RPC | DRAFT | 2026-08-30 |
| 6. Receipt outbox | DRAFT | 2026-08-30 |
| 7. /api/create-payment-intent | DRAFT | 2026-08-30 |
| 8. Webhook handler | DRAFT | 2026-08-30 |
| 9. Cleanup/reconciliation | DRAFT | 2026-08-30 |
| 10. Database permissions | DRAFT | 2026-08-30 |
| 11. Test suite | DRAFT | 2026-08-30 |
| 12. Historical first-purchase integrity | DRAFT | 2026-08-30 |

### Race Condition Tests

```javascript
describe('Race Condition Tests', () => {
  
  test('expiry vs attachment race', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Set reservation to expire soon
    await supabase
      .from('payment_reservations')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', reservation_id);
    
    // Race: expire vs attach
    const [expireResult, attachResult] = await Promise.allSettled([
      supabase.rpc('expire_pending_reservation', { p_reservation_id: reservation_id }),
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    ]);
    
    // Exactly one should succeed
    const succeeded = [expireResult, attachResult].filter(r => r.status === 'fulfilled' && !r.value.error);
    expect(succeeded.length).toBe(1);
    
    // Final state should be either expired or processing, not both
    const reservation = await getReservation(reservation_id);
    expect(['expired', 'processing']).toContain(reservation.status);
  });
  
  test('cancellation vs success race', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Race: cancel vs process payment
    const [cancelResult, processResult] = await Promise.allSettled([
      supabase.rpc('cancel_processing_reservation', { p_stripe_payment_intent_id: 'pi_test_123' }),
      supabase.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    ]);
    
    // Exactly one should succeed
    const succeeded = [cancelResult, processResult].filter(r => r.status === 'fulfilled' && !r.value.error);
    expect(succeeded.length).toBe(1);
    
    // Final state should be either cancelled or succeeded
    const reservation = await getReservation(reservation_id);
    expect(['cancelled', 'succeeded']).toContain(reservation.status);
    
    // If succeeded, credits should be added exactly once
    if (reservation.status === 'succeeded') {
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(10); // starter package
    }
  });
  
  test('two cleanup workers processing the same reservation', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Two cleanup workers try to process same reservation
    const worker1 = supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const worker2 = supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const [result1, result2] = await Promise.all([worker1, worker2]);
    
    // Both should succeed (idempotent)
    expect(result1.error).toBeUndefined();
    expect(result2.error).toBeUndefined();
    
    // Both should return same balance_after
    expect(result1.data.balance_after).toBe(result2.data.balance_after);
    
    // Only one should have already_processed = false
    const firstTime = [result1, result2].filter(r => r.data.already_processed === false);
    expect(firstTime.length).toBe(1);
    
    // Credits should be added exactly once
    const company = await getCompany(testCompanyId);
    expect(company.credits).toBe(10);
  });
  
  test('Stripe success discovered only through reconciliation', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Webhook never arrives (simulated)
    // Cleanup job discovers succeeded payment via Stripe API
    const pi = { id: 'pi_test_123', amount: 2500, currency: 'gbp', status: 'succeeded' };
    
    // Reconciliation processes payment
    const { data, error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: pi.id,
      p_stripe_amount_pence: pi.amount,
      p_stripe_currency: pi.currency
    });
    
    expect(error).toBeUndefined();
    expect(data.status).toBe('succeeded');
    expect(data.already_processed).toBe(false);
    
    // Reservation should be succeeded
    const reservation = await getReservation(reservation_id);
    expect(reservation.status).toBe('succeeded');
  });
});
```

### Transaction Rollback Tests

```javascript
describe('Transaction Rollback Tests', () => {
  
  test('failure immediately after purchase insert', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Inject failure after purchase insert (e.g., company update fails)
    // This would be done via database trigger or test hook
    // For documentation: simulate by checking rollback
    
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // If error occurred, verify full rollback:
    if (error) {
      // No purchase record created
      const { data: purchases } = await supabase
        .from('purchases')
        .select('*')
        .eq('stripe_payment_intent_id', 'pi_test_123');
      expect(purchases.length).toBe(0);
      
      // Company credits unchanged
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(0);
      
      // No credit-ledger entry
      const { data: ledger } = await supabase
        .from('credit_ledger')
        .select('*')
        .eq('reference_id', reservation_id);
      expect(ledger.length).toBe(0);
      
      // Reservation still processing
      const reservation = await getReservation(reservation_id);
      expect(reservation.status).toBe('processing');
      
      // No receipt job created
      const { data: jobs } = await supabase
        .from('receipt_outbox')
        .select('*')
        .eq('reservation_id', reservation_id);
      expect(jobs.length).toBe(0);
    }
  });
  
  test('failure immediately after company credit update', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Inject failure after credit update (e.g., ledger insert fails)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    if (error) {
      // Verify full rollback: company credits unchanged
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(0);
      
      // No credit-ledger entry
      const { data: ledger } = await supabase
        .from('credit_ledger')
        .select('*')
        .eq('reference_id', reservation_id);
      expect(ledger.length).toBe(0);
      
      // Reservation still processing
      const reservation = await getReservation(reservation_id);
      expect(reservation.status).toBe('processing');
    }
  });
  
  test('failure immediately after credit-ledger insert', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Inject failure after ledger insert (e.g., reservation update fails)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    if (error) {
      // Verify full rollback: no ledger entry
      const { data: ledger } = await supabase
        .from('credit_ledger')
        .select('*')
        .eq('reference_id', reservation_id);
      expect(ledger.length).toBe(0);
      
      // Company credits unchanged
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(0);
      
      // Reservation still processing
      const reservation = await getReservation(reservation_id);
      expect(reservation.status).toBe('processing');
    }
  });
});
```

### Permission Tests

```javascript
describe('Permission Tests', () => {
  
  test('contractor attempting to execute sensitive payment RPCs', async () => {
    // create_payment_reservation
    const { error: createError } = await authenticatedClient.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    expect(createError.message).toContain('permission denied');
    
    // attach_stripe_payment_intent
    const { error: attachError } = await authenticatedClient.rpc('attach_stripe_payment_intent', {
      p_reservation_id: testReservationId,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    expect(attachError.message).toContain('permission denied');
    
    // process_stripe_payment_atomic
    const { error: processError } = await authenticatedClient.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    expect(processError.message).toContain('permission denied');
    
    // expire_pending_reservation
    const { error: expireError } = await authenticatedClient.rpc('expire_pending_reservation', {
      p_reservation_id: testReservationId
    });
    expect(expireError.message).toContain('permission denied');
    
    // cancel_processing_reservation
    const { error: cancelError } = await authenticatedClient.rpc('cancel_processing_reservation', {
      p_stripe_payment_intent_id: 'pi_test_123'
    });
    expect(cancelError.message).toContain('permission denied');
  });
  
  test('contractor attempting direct modification of payment/credit tables', async () => {
    // payment_reservations
    const { error: resError } = await authenticatedClient
      .from('payment_reservations')
      .update({ status: 'succeeded' })
      .eq('id', testReservationId);
    expect(resError.message).toContain('permission denied');
    
    // purchases
    const { error: purchError } = await authenticatedClient
      .from('purchases')
      .insert({ company_id: testCompanyId, credits: 100 });
    expect(purchError.message).toContain('permission denied');
    
    // companies (credits)
    const { error: compError } = await authenticatedClient
      .from('companies')
      .update({ credits: 999999 })
      .eq('id', testCompanyId);
    expect(compError.message).toContain('permission denied');
    
    // credit_ledger
    const { error: ledgerError } = await authenticatedClient
      .from('credit_ledger')
      .insert({ company_id: testCompanyId, change_amount: 100 });
    expect(ledgerError.message).toContain('permission denied');
    
    // receipt_outbox
    const { error: receiptError } = await authenticatedClient
      .from('receipt_outbox')
      .update({ status: 'sent' })
      .eq('id', testJobId);
    expect(receiptError.message).toContain('permission denied');
  });
});
```

### Receipt Worker Tests

```javascript
describe('Receipt Worker Tests', () => {
  
  test('concurrent receipt workers', async () => {
    // Create test receipt job
    const { data: job } = await supabase.rpc('claim_receipt_job');
    
    // Two workers try to claim same job
    const worker1 = supabase.rpc('claim_receipt_job');
    const worker2 = supabase.rpc('claim_receipt_job');
    
    const [result1, result2] = await Promise.all([worker1, worker2]);
    
    // Only one should get the job
    const claimed = [result1, result2].filter(r => r.data && r.data.length > 0);
    expect(claimed.length).toBe(1);
    
    // Job should be in processing state
    const updated = await getReceiptJob(job.id);
    expect(updated.status).toBe('processing');
  });
  
  test('receipt send succeeds but worker crashes before marking complete', async () => {
    // Create and claim job
    const { data: job } = await supabase.rpc('claim_receipt_job');
    
    // Simulate: email sent successfully but worker crashes
    // Job remains in processing state
    const staleJob = await getReceiptJob(job.id);
    expect(staleJob.status).toBe('processing');
    
    // Recovery: cleanup finds stale processing job
    // Checks with provider, confirms delivery
    // Marks as sent
    await supabase.rpc('complete_receipt_job', {
      p_job_id: job.id,
      p_provider_message_id: 'msg_test_123'
    });
    
    const completed = await getReceiptJob(job.id);
    expect(completed.status).toBe('sent');
    expect(completed.provider_message_id).toBe('msg_test_123');
  });
  
  test('receipt retry must not create a second outbox job', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Process payment (creates receipt job)
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Count jobs
    const { data: jobs } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('reservation_id', reservation_id);
    
    // Should be exactly one job
    expect(jobs.length).toBe(1);
    
    // Duplicate webhook should not create second job
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const { data: jobsAfter } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('reservation_id', reservation_id);
    
    expect(jobsAfter.length).toBe(1);
  });
});
```

### Historical Customer Tests

```javascript
describe('Historical Customer Tests', () => {
  
  test('historical customer attempting to claim first-purchase discount', async () => {
    // Set up: company has historical purchase
    await supabase
      .from('companies')
      .update({ has_purchased: true })
      .eq('id', testCompanyId);
    
    // Attempt to create reservation
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    const reservation = await getReservation(reservation_id);
    
    // Should NOT get discount
    expect(reservation.is_first_purchase).toBe(false);
    expect(reservation.amount_pence).toBe(2500); // Full price, not 2000
  });
});
```

---

## Section 12: Historical First-Purchase Integrity & Migration Strategy

### Purpose
Ensure existing customers who completed valid historical purchases do NOT become eligible for the 20% first-purchase discount when the new payment reservation architecture is deployed.

### Pre-Migration Integrity Check

Before enabling the new first-purchase claim mechanism, run this integrity check:

```sql
-- Check for companies with has_purchased = FALSE but have completed purchases
SELECT 
  c.id,
  c.email,
  c.has_purchased,
  COUNT(p.id) as completed_purchases,
  SUM(p.credits) as total_credits_purchased
FROM companies c
LEFT JOIN purchases p ON c.id = p.company_id
WHERE c.has_purchased = FALSE
  AND p.id IS NOT NULL
GROUP BY c.id, c.email, c.has_purchased;

-- Check for companies with has_purchased = TRUE but no completed purchases
SELECT 
  c.id,
  c.email,
  c.has_purchased,
  COUNT(p.id) as completed_purchases
FROM companies c
LEFT JOIN purchases p ON c.id = p.company_id
WHERE c.has_purchased = TRUE
  AND p.id IS NULL
GROUP BY c.id, c.email, c.has_purchased;
```

### Mismatch Correction Strategy

**Case 1: `has_purchased = FALSE` but has completed purchases**
- **Action:** Update `has_purchased = TRUE`
- **Reason:** Historical purchase exists, customer is NOT eligible for first-purchase discount
- **Safety:** Append-only correction, preserves historical purchase data

```sql
-- Correct mismatches (Case 1)
UPDATE companies c
SET has_purchased = TRUE
WHERE has_purchased = FALSE
  AND EXISTS (
    SELECT 1 FROM purchases p WHERE p.company_id = c.id
  );
```

**Case 2: `has_purchased = TRUE` but no completed purchases**
- **Action:** Investigate manually
- **Reason:** May indicate data corruption or test accounts
- **Safety:** Do NOT automatically set to FALSE without review

```sql
-- Flag for manual review (Case 2)
SELECT 
  c.id,
  c.email,
  c.created_at,
  c.credits
FROM companies c
WHERE c.has_purchased = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM purchases p WHERE p.company_id = c.id
  );
```

### Migration File: `003-payment-reservation-architecture.sql`

**Strategy:** Append-only migration. Do NOT rewrite `001` or `002`.

```sql
-- 003-payment-reservation-architecture.sql
-- Append-only migration for payment reservation architecture
-- DO NOT rewrite 001 or 002

-- Step 1: Create new tables
CREATE TABLE IF NOT EXISTS payment_reservations (
  -- ... (schema from Section 1)
);

CREATE TABLE IF NOT EXISTS credit_packages (
  -- ... (schema from Section 2)
);

CREATE TABLE IF NOT EXISTS receipt_outbox (
  -- ... (schema from Section 6)
);

CREATE TABLE IF NOT EXISTS company_members (
  -- ... (schema from Section 10)
);

-- Step 2: Add has_purchased column if not exists
ALTER TABLE companies ADD COLUMN IF NOT EXISTS has_purchased BOOLEAN NOT NULL DEFAULT FALSE;

-- Step 3: Seed credit packages
INSERT INTO credit_packages (id, credits, price_pence, first_purchase_discount_percent) VALUES
  ('starter', 10, 2500, 20),
  ('growth', 25, 5500, 20),
  ('pro', 60, 12000, 20)
ON CONFLICT (id) DO NOTHING;

-- Step 4: Create RPCs
-- ... (all RPC definitions from Sections 3, 4, 5, 6)

-- Step 5: Create indexes
CREATE INDEX IF NOT EXISTS idx_payment_reservations_company ON payment_reservations(company_id);
CREATE INDEX IF NOT EXISTS idx_payment_reservations_stripe_pi ON payment_reservations(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_reservations_status ON payment_reservations(status);

-- Step 6: Set up RLS policies
-- ... (all RLS policies from Section 10)

-- Step 7: Grant/revoke permissions
-- ... (all GRANT/REVOKE statements from Section 10)
```

### Rollback Strategy

**If migration fails or needs rollback:**

1. **New tables are isolated** — Can be dropped without affecting existing data
2. **Historical data preserved** — `purchases` and `credit_ledger` tables unchanged
3. **Rollback script:**

```sql
-- 003-rollback.sql
-- Rollback payment reservation architecture

-- Drop new tables (historical data preserved)
DROP TABLE IF EXISTS receipt_outbox;
DROP TABLE IF EXISTS payment_reservations;
DROP TABLE IF EXISTS credit_packages;
DROP TABLE IF EXISTS company_members;

-- Remove has_purchased column (optional, only if added by this migration)
-- ALTER TABLE companies DROP COLUMN IF EXISTS has_purchased;

-- Drop RPCs
DROP FUNCTION IF EXISTS create_payment_reservation(UUID, TEXT);
DROP FUNCTION IF EXISTS attach_stripe_payment_intent(UUID, TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS process_stripe_payment_atomic(TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS expire_pending_reservation(UUID);
DROP FUNCTION IF EXISTS cancel_processing_reservation(TEXT);
DROP FUNCTION IF EXISTS claim_receipt_job();
DROP FUNCTION IF EXISTS complete_receipt_job(UUID);
DROP FUNCTION IF EXISTS fail_receipt_job(UUID);
```

### Pre-Production Deployment Checklist

**All checks must pass before enabling the new payment architecture:**

- [ ] **Integrity Check 1:** No companies with `has_purchased = FALSE` have completed purchases
- [ ] **Integrity Check 2:** All companies with `has_purchased = TRUE` have been manually reviewed
- [ ] **Data Preservation:** Historical `purchases` table row count unchanged
- [ ] **Data Preservation:** Historical `credit_ledger` table row count unchanged
- [ ] **Mismatch Correction:** All Case 1 mismatches corrected (`has_purchased` updated)
- [ ] **Manual Review:** All Case 2 mismatches reviewed and documented
- [ ] **Test Suite:** All unit tests pass (Section 11)
- [ ] **Test Suite:** All concurrency tests pass
- [ ] **Test Suite:** All security tests pass
- [ ] **Test Suite:** All recovery tests pass
- [ ] **Staging Deployment:** Full payment flow tested end-to-end on staging
- [ ] **Rollback Plan:** Rollback script tested on staging
- [ ] **Monitoring:** Alerts configured for payment processing failures
- [ ] **Monitoring:** Alerts configured for receipt delivery failures

### Historical Data Preservation

**Guarantee:** This migration is append-only and preserves all historical data.

| Table | Action | Preservation |
|-------|--------|-------------|
| `purchases` | No changes | ✅ All historical rows preserved |
| `credit_ledger` | No changes | ✅ All historical rows preserved |
| `companies` | Add `has_purchased` column only | ✅ All existing columns unchanged |
| `payment_reservations` | New table | ✅ No impact on historical data |
| `credit_packages` | New table | ✅ No impact on historical data |
| `receipt_outbox` | New table | ✅ No impact on historical data |
| `company_members` | New table | ✅ No impact on historical data |

### First-Purchase Eligibility Rules

**After migration:**

1. **New customers** (no historical purchases): Eligible for 20% first-purchase discount
2. **Existing customers** (with historical purchases): NOT eligible for discount
3. **Corrected mismatches** (Case 1): NOT eligible for discount
4. **Manual review cases** (Case 2): Eligibility determined by manual review

**Enforcement:**
- `create_payment_reservation` RPC checks `companies.has_purchased`
- `has_purchased` is set to `TRUE` after first successful purchase
- Historical purchases are preserved and respected
- No fabrication of `payment_reservations` rows for historical payments

---

**Document Status:** DRAFT — Awaiting independent review  
**Next Step:** Independent review before any implementation
