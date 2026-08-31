# ACConnx Project Handoff — Independent ChatGPT Review

**Generated for independent ChatGPT review. Do not treat this file as proof that changes are production-ready.**

**Date:** 2026-08-29  
**Branch:** `security-refactor`  
**Latest Commit:** `c153c901881627acaa706991228b7ef0b82835f9`  
**Commit Date:** 2026-08-29 10:40:24 +0000  
**Commit Message:** "Security review: real test implementation and execution"

---

## Git Status

**Current Branch:** `security-refactor`  
**Working Tree Status:** Clean (no modified files)  
**Untracked Files:** `docs/` (new directory containing approved payment architecture)

**Files Modified Since Last Commit:** None  
**Files Untracked:** `docs/PAYMENT-ARCHITECTURE.md`, `docs/ACCONNX-CHATGPT-HANDOFF.md`

---

## Project Structure (ACConnx Relevant)

```
hvac-calculator/
├── api/
│   ├── migrations/
│   │   ├── 001-security-refactor.sql          # OLD - needs replacement
│   │   └── 002-security-rpc-functions.sql     # OLD - conflicting, to be discarded
│   ├── tests/
│   │   └── security.test.js                   # 16-test security suite
│   ├── server.js                              # Main API server
│   ├── auth.js                                # JWT authentication
│   ├── .env                                   # Environment variables (NOT committed)
│   └── package.json
├── docs/
│   ├── PAYMENT-ARCHITECTURE.md                # APPROVED payment architecture (NEW)
│   └── ACCONNX-CHATGPT-HANDOFF.md            # This file
├── company-portal.html                        # Contractor portal frontend
├── admin.html                                 # Admin dashboard
├── index.html                                 # Customer calculator
└── for-contractors.html                       # Contractor landing page
```

---

## Approved Payment Architecture

**Full Details:** See `docs/PAYMENT-ARCHITECTURE.md` (1,518 lines, 53,646 bytes)

### Section 1: `payment_reservations` Table — APPROVED

**Status:** APPROVED  
**Date:** 2026-08-29

**Key Features:**
- Stores payment reservations with first-purchase tracking
- `balance_after` stored for duplicate webhook idempotency
- `receipt_sent_at` for receipt audit trail
- `expires_at` as cleanup/review timestamp (NOT proof of Stripe expiry)
- 9 CHECK constraints preventing impossible states
- GBP-only currency enforcement

**Full schema:** See PAYMENT-ARCHITECTURE.md Section 1

### Section 2: Indexes and Uniqueness Constraints — APPROVED

**Status:** APPROVED  
**Date:** 2026-08-29

**Key Features:**
- Partial unique index `idx_payment_reservations_first_purchase_claim` prevents concurrent first-purchase claims
- Covers `pending`, `processing`, AND `succeeded` states (permanent backstop)
- Cancelled/expired reservations do NOT consume first-purchase eligibility
- 5 total indexes/constraints (no redundant indexes)

**Full definitions:** See PAYMENT-ARCHITECTURE.md Section 2

### Section 3: `create_payment_reservation` RPC — APPROVED

**Status:** APPROVED  
**Date:** 2026-08-29

**Key Features:**
- Creates payment reservation with first-purchase eligibility determination
- Returns `checkout_already_in_progress` flag for concurrent first-purchase attempts
- Raises exception if first-purchase entitlement already consumed (succeeded reservation exists)
- Explicit NULL `has_purchased` rejection
- Constraint-specific exception handling (only treats `idx_payment_reservations_first_purchase_claim` as conflict)

**Full SQL:** See PAYMENT-ARCHITECTURE.md Section 3

### Section 4: `attach_stripe_payment_intent` RPC — APPROVED

**Status:** APPROVED  
**Date:** 2026-08-29

**Key Features:**
- Attaches Stripe PaymentIntent to pending reservation
- Idempotent for exact retries (same PaymentIntent, amount, currency)
- Handles concurrent identical requests (returns `already_attached_same=TRUE`)
- Rejects different PaymentIntent/amount/currency
- Requires `pending` status with NULL PaymentIntent and NULL amount
- UNIQUE constraint on `stripe_payment_intent_id` as database backstop

**Full SQL:** See PAYMENT-ARCHITECTURE.md Section 4

### Section 5: `process_stripe_payment_atomic` RPC — APPROVED

**Status:** APPROVED  
**Date:** 2026-08-29

**Key Features:**
- Atomically processes Stripe payment in single transaction
- Validates amount/currency even for duplicate webhooks
- Returns ORIGINAL credits and `balance_after` for duplicates (not current balance)
- Defensive checks for NULL `balance_after` and `completed_at` in succeeded reservations
- Constraint-specific exception handling (only `purchases_stripe_payment_id_unique` treated as inconsistency)
- Verifies final reservation update succeeds (exactly 1 row updated)
- Row-level locking with `FOR UPDATE`

**Full SQL:** See PAYMENT-ARCHITECTURE.md Section 5

### Section 6: Reservation Expiry/Reconciliation — APPROVED

**Status:** APPROVED  
**Date:** 2026-08-29

**Architecture:** JavaScript + SQL
- JavaScript contacts Stripe API
- SQL owns atomic database state transitions

**Approved Rules:**
- `pending` + no Stripe PI + past `expires_at` may become `expired`
- `processing` must NEVER become `expired` merely because `expires_at` passed
- Stripe `succeeded` is reconciled using `process_stripe_payment_atomic`
- Stripe `canceled` may transition `processing → cancelled` only for exact attached PaymentIntent
- Retryable/payable Stripe states remain active
- Stripe/API lookup failure leaves reservation unchanged
- `payment_intent.payment_failed` does NOT automatically release first-purchase eligibility
- Both expiry and cancellation transitions are idempotent for safe retries

**RPCs:**
- `expire_pending_reservation(p_reservation_id)` — Returns `(transitioned_now, already_in_target_state)`
- `cancel_processing_reservation(p_reservation_id, p_stripe_payment_intent_id)` — Returns `(transitioned_now, already_in_target_state)`

**Full SQL:** See PAYMENT-ARCHITECTURE.md Section 6

---

## Current Database/Migration Situation

### Existing Migrations (OUTDATED — TO BE REPLACED)

**File:** `api/migrations/001-security-refactor.sql`  
**Status:** OUTDATED — Contains old `process_stripe_payment` and `create_payment_intent` RPCs that are NOT called by current code  
**Issues:**
- Defines `process_stripe_payment` with wrong signature (not reservation-based)
- Defines `create_payment_intent` with wrong signature (not reservation-based)
- Missing `payment_reservations` table
- Missing approved RPCs

**File:** `api/migrations/002-security-rpc-functions.sql`  
**Status:** CONFLICTING — TO BE DISCARDED  
**Issues:**
- Defines `process_stripe_payment` with different signature than 001 (would create PostgreSQL overload)
- Defines `create_payment_intent` with different signature than 001
- Defines `assign_lead_with_credit` (not called by any code)
- Conflicts with 001

### Current Database State

**Applied to Supabase:** NONE of the new payment architecture  
**Reason:** Migrations 001 and 002 are outdated/conflicting and have NOT been applied  
**Current Production Database:** Uses old schema (no `payment_reservations` table, no approved RPCs)

### Required Migration Path

1. **Discard** `api/migrations/002-security-rpc-functions.sql` entirely
2. **Rewrite** `api/migrations/001-security-refactor.sql` to match approved PAYMENT-ARCHITECTURE.md
3. **Apply** new migration to Supabase
4. **Update** `api/server.js` to use new RPCs
5. **Test** complete payment flow

---

## Known Unresolved Production Blockers

### 1. Payment Architecture Not Implemented

**Blocker:** Approved payment architecture exists only in `docs/PAYMENT-ARCHITECTURE.md`, not in database or application code  
**Impact:** Production payment flow still uses old non-atomic webhook processing  
**Risk:** Race conditions, duplicate credit grants, first-purchase discount abuse  
**Resolution:** Apply approved migration, update server.js, run tests

### 2. Lead Assignment Atomicity

**Blocker:** Lead assignment currently uses separate `deduct_credit` RPC + manual lead update (not atomic)  
**Impact:** Race condition where credit is deducted but lead assignment fails (or vice versa)  
**Risk:** Credits deducted without lead assigned, or lead assigned without credit deduction  
**Resolution:** Design and implement atomic lead assignment RPC (similar to `process_stripe_payment_atomic`)

### 3. Receipt Sending Concurrency

**Blocker:** `receipt_sent_at` column exists but no concurrency-safe receipt sending mechanism  
**Impact:** Duplicate receipt emails possible if webhook arrives twice  
**Risk:** Customer receives duplicate receipts  
**Resolution:** Design receipt queue or idempotency mechanism (deferred)

### 4. Cleanup Job Not Implemented

**Blocker:** Expiry/reconciliation RPCs approved but no JavaScript cleanup job  
**Impact:** Expired reservations not cleaned up, Stripe PaymentIntents not reconciled  
**Risk:** First-purchase eligibility locked indefinitely, succeeded payments not processed  
**Resolution:** Implement cleanup job using approved architecture

---

## Tests Currently Available

**File:** `api/tests/security.test.js`  
**Total Tests:** 16  
**Latest Actual Status:** NOT RUN (migrations not applied, server not restarted)

### Test List

1. Contractor A cannot read Contractor B leads
2. Contractor A cannot modify Contractor B leads
3. Contractor cannot alter own credits
4. Create payment intent requires authentication
5. Client cannot manipulate payment amounts
6. Webhook idempotency
7. Concurrent webhook processing
8. First-purchase discount only once
9. Concurrent leads cannot overspend
10. Balance never negative
11. Lead insertion failure no credit deduction
12. Credit deduction failure no lead creation
13. `/api/me` returns exact balance
14. Invalid JWT clears session
15. Admin-only routes reject contractor tokens
16. Push subscription identity from JWT

**Status:** All 16 tests written but NOT EXECUTED  
**Reason:** Waiting for approved migration to be applied and server to be restarted with test-only rate-limit bypass

---

## Files Currently Modified/Untracked

**Modified Files:** None  
**Untracked Files:**
- `docs/PAYMENT-ARCHITECTURE.md` (1,518 lines, 53,646 bytes) — Approved payment architecture
- `docs/ACCONNX-CHATGPT-HANDOFF.md` (this file)

---

## CURRENT REVIEW TASK

**Task:** Review the approved payment architecture in `docs/PAYMENT-ARCHITECTURE.md` and provide feedback on:

1. **Correctness:** Are the SQL RPCs logically correct? Do they handle all edge cases?
2. **Concurrency:** Are the concurrency guarantees sufficient? Are there any race conditions not addressed?
3. **Security:** Are there any security vulnerabilities in the approved design?
4. **Completeness:** Are there any missing pieces before implementation?
5. **Migration Path:** Is the migration path from old schema to new schema clear and safe?

**Deliverable:** Written feedback on the approved payment architecture, identifying any issues that must be fixed before implementation.

---

## CHANGES SINCE LAST REVIEW

**Date of Last Review:** 2026-08-29 11:53 UTC  
**Changes Since Then:**

1. **Section 1 (payment_reservations table):** Approved with corrections
   - `currency` changed to `NOT NULL DEFAULT 'gbp' CHECK (currency = 'gbp')`
   - `expires_at` explanation corrected (cleanup/review timestamp, not proof of Stripe expiry)
   - `receipt_sent_at` clarified (durable state, not concurrency guarantee)

2. **Section 2 (indexes/constraints):** Approved with corrections
   - First-purchase unique index strengthened to include `succeeded` state
   - Standalone `status` index removed (redundant)
   - Standalone `stripe_payment_intent_id` index removed (redundant with UNIQUE constraint)

3. **Section 3 (create_payment_reservation RPC):** Approved with corrections
   - Added NULL `has_purchased` rejection
   - Added status check for existing first-purchase reservation (succeeded → error, pending/processing → conflict)
   - Added constraint-specific exception handling

4. **Section 4 (attach_stripe_payment_intent RPC):** Approved with corrections
   - Added exact retry idempotency
   - Added concurrent identical request handling
   - Added currency storage
   - Added requirement for NULL PaymentIntent and NULL amount in pending state

5. **Section 5 (process_stripe_payment_atomic RPC):** Approved with corrections
   - Added amount/currency validation for duplicate webhooks
   - Changed duplicate result to return ORIGINAL credits (not 0)
   - Removed UNIQUE violation idempotency treatment (now raises database inconsistency error)
   - Added final UPDATE verification (exactly 1 row updated)
   - Added defensive checks for NULL `balance_after` and `completed_at`

6. **Section 6 (expiry/reconciliation):** Approved (new section)
   - JavaScript + SQL architecture
   - `expire_pending_reservation` RPC with idempotency
   - `cancel_processing_reservation` RPC with exact PaymentIntent binding
   - NULL-safe PaymentIntent comparisons using `IS DISTINCT FROM`

---

## QUESTIONS FOR CHATGPT

1. **Concurrency:** Are there any race conditions in the approved RPCs that we haven't addressed? Specifically:
   - Can two concurrent `create_payment_reservation` calls both succeed with `is_first_purchase=TRUE` if they interleave in a specific way?
   - Can the `attach_stripe_payment_intent` exact-retry logic be fooled by a carefully timed concurrent request?

2. **Idempotency:** Is the idempotency strategy sufficient for all failure scenarios?
   - What happens if the server crashes after `process_stripe_payment_atomic` commits but before the webhook response is sent?
   - What happens if Stripe sends a webhook for a PaymentIntent that was never attached to a reservation?

3. **State Machine:** Are there any impossible states not prevented by the CHECK constraints?
   - Can a reservation be in `processing` with `amount_pence=NULL`?
   - Can a reservation be in `succeeded` with `completed_at=NULL`?

4. **Migration Safety:** What is the safest way to migrate from the old schema to the new schema?
   - Should we create a new migration file or rewrite 001?
   - How do we handle existing production data (companies, purchases, leads)?
   - Should we backfill `payment_reservations` for existing purchases?

5. **Testing:** What additional tests should we add beyond the existing 16?
   - Concurrent first-purchase reservation attempts
   - Webhook arriving before PaymentIntent attachment
   - Cleanup job reconciliation of succeeded PaymentIntents
   - Receipt sending idempotency

6. **Lead Assignment:** The current lead assignment uses separate `deduct_credit` RPC + manual lead update. Should we design an atomic `assign_lead_with_credit` RPC similar to `process_stripe_payment_atomic`?

7. **Receipt Sending:** What is the best architecture for concurrency-safe receipt sending?
   - Receipt queue with idempotency keys?
   - Database-level locking on `receipt_sent_at`?
   - Separate receipt service?

8. **Cleanup Job Frequency:** How often should the cleanup job run?
   - Every hour?
   - Every 15 minutes?
   - On-demand via cron?

9. **Error Handling:** Should any of the RPC errors be treated as retryable vs. permanent?
   - Network errors calling Stripe API?
   - Database connection errors?
   - Unique constraint violations?

10. **Monitoring:** What metrics should we track for the payment system?
    - Payment success rate?
    - First-purchase discount usage?
    - Webhook processing latency?
    - Cleanup job reconciliation count?

---

## Additional Context

**Project:** ACConnx — HVAC lead generation platform  
**Business Model:** Contractors purchase credits to receive customer leads  
**Payment Flow:** Contractor selects package → creates payment reservation → Stripe checkout → webhook processes payment → credits added  
**First-Purchase Discount:** 20% off first purchase (one-time)  
**Currency:** GBP only  
**Database:** Supabase PostgreSQL  
**Payment Processor:** Stripe  
**Email:** Resend  

**Critical Security Requirements:**
- Never trust client-supplied company ID, credits, or pricing
- Always validate amount/currency server-side
- Prevent concurrent first-purchase discount claims
- Guarantee exactly-once credit granting
- Prevent duplicate receipt emails

**Critical Concurrency Requirements:**
- Two contractors cannot both claim first-purchase discount
- Two webhooks cannot both add credits for the same payment
- Two cleanup jobs cannot both expire the same reservation
- Payment processing must be atomic (all-or-nothing)

---

**End of Handoff Document**
