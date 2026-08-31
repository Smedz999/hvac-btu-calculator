# 02-database-tables.md — Database Tables & Constraints

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 03-rls-permissions.md, 04-payment-rpcs.md

---

## Overview

This document contains all database table schemas, constraints, indexes, and triggers.

**Authoritative definitions:**
- All table schemas
- All CHECK constraints
- All indexes
- State transition trigger

---

## Table: `payment_reservations`

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

### Indexes

```sql
-- Prevent concurrent first-purchase discount claims
-- Only ONE active/successful first-purchase claim allowed per company
CREATE UNIQUE INDEX idx_unique_first_purchase_claim 
  ON payment_reservations(company_id) 
  WHERE is_first_purchase = TRUE 
    AND status IN ('pending', 'processing', 'succeeded');
```

### Transition Trigger

```sql
-- Enable RLS on all payment/security-related tables
ALTER TABLE payment_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;

-- Prevent invalid state transitions
CREATE OR REPLACE FUNCTION prevent_invalid_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow same-state updates (no-op transitions)
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  
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
```

---

## Table: `credit_packages`

### Schema

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

---

## Table: `receipt_outbox`

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

---

## Table: `company_members`

### Schema

```sql
CREATE TABLE company_members (
  company_id UUID NOT NULL REFERENCES companies(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, user_id)
);
```

**Purpose:** Links authenticated users to companies. All RLS policies use this relationship, NOT `company_id = auth.uid()` directly.

---

## Table: `companies` (Modification)

### First Purchase Tracking

```sql
ALTER TABLE companies ADD COLUMN IF NOT EXISTS has_purchased BOOLEAN NOT NULL DEFAULT FALSE;
```

---

## Summary

This document contains all database table schemas, constraints, indexes, and triggers. All tables are designed to enforce data integrity at the database level.

**Next:** See 03-rls-permissions.md for Row-Level Security policies and permissions.
