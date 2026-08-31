# 06-reservations-discounts.md — Reservations & Discounts

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 02-database-tables.md, 04-payment-rpcs.md

---

## Overview

This document contains first-purchase discount logic, concurrency protection, and historical first-purchase integrity.

**Authoritative definitions:**
- Discount rules
- Concurrency protection for discounts
- Migration strategy
- Historical first-purchase integrity checks

---

## First-Purchase Discount Logic

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
**See:** 04-payment-rpcs.md for `create_payment_reservation` RPC with exception handling

---

## Historical First-Purchase Integrity & Migration Strategy

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
  -- ... (schema from 02-database-tables.md)
);

CREATE TABLE IF NOT EXISTS credit_packages (
  -- ... (schema from 02-database-tables.md)
);

CREATE TABLE IF NOT EXISTS receipt_outbox (
  -- ... (schema from 02-database-tables.md)
);

CREATE TABLE IF NOT EXISTS company_members (
  -- ... (schema from 02-database-tables.md)
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
-- ... (all RPC definitions from 04-payment-rpcs.md and 07-receipt-jobs.md)

-- Step 5: Create indexes
CREATE INDEX IF NOT EXISTS idx_payment_reservations_company ON payment_reservations(company_id);
CREATE INDEX IF NOT EXISTS idx_payment_reservations_stripe_pi ON payment_reservations(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_reservations_status ON payment_reservations(status);

-- Step 6: Set up RLS policies
-- ... (all RLS policies from 03-rls-permissions.md)

-- Step 7: Grant/revoke permissions
-- ... (all GRANT/REVOKE statements from 03-rls-permissions.md)
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
DROP FUNCTION IF EXISTS complete_receipt_job(UUID, TEXT);
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
- [ ] **Test Suite:** All unit tests pass (see 08-tests-invariants.md)
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

## Summary

This document contains first-purchase discount logic, concurrency protection, and migration strategy. All discount logic is enforced at the database level with unique indexes and exception handling.

**Next:** See 07-receipt-jobs.md for receipt job worker flow.
