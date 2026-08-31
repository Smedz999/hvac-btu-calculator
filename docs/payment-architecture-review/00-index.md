# Payment Architecture Review Index

**Status:** DRAFT — Split for independent review  
**Date:** 2026-08-30  
**Original:** PAYMENT-ARCHITECTURE.md (2809 lines)

---

## File Structure

This directory contains the complete payment architecture split into focused review files. Each file is self-contained but cross-references authoritative definitions in other files.

### 00-index.md (this file)
- Overview of file structure
- Where to find authoritative definitions
- Review order recommendation

### 01-payment-flow.md
- End-to-end payment flow overview
- `/api/create-payment-intent` endpoint
- Webhook handler flow
- Cleanup/reconciliation flow
- **Authoritative definitions:** None (references other files)

### 02-database-tables.md
- `payment_reservations` table schema
- `credit_packages` table schema
- `receipt_outbox` table schema
- `company_members` table schema
- State shape constraints
- Transition trigger
- **Authoritative definitions:** All table schemas, CHECK constraints, indexes

### 03-rls-permissions.md
- Row-Level Security policies
- GRANT/REVOKE permissions
- Service role permissions
- Anon role permissions
- Authenticated role permissions
- **Authoritative definitions:** All RLS policies, all GRANT/REVOKE statements

### 04-payment-rpcs.md
- `create_payment_reservation` RPC
- `attach_stripe_payment_intent` RPC
- `process_stripe_payment_atomic` RPC
- `expire_pending_reservation` RPC
- `cancel_processing_reservation` RPC
- **Authoritative definitions:** All payment RPC function signatures and logic

### 05-stripe-webhooks.md
- Webhook endpoint
- `payment_intent.succeeded` flow
- `payment_intent.payment_failed` flow
- `payment_intent.canceled` flow
- Webhook-before-attachment recovery
- **Authoritative definitions:** Webhook handling logic

### 06-reservations-discounts.md
- First-purchase discount logic
- Concurrency protection for discounts
- Historical first-purchase integrity
- Migration strategy
- **Authoritative definitions:** Discount rules, migration checks

### 07-receipt-jobs.md
- Receipt outbox worker flow
- `claim_receipt_job` RPC
- `complete_receipt_job` RPC
- `fail_receipt_job` RPC
- Crash recovery
- **Authoritative definitions:** Receipt job RPCs, worker logic

### 08-tests-invariants.md
- Core payment tests
- Race condition tests
- Transaction rollback tests
- Permission tests
- Receipt worker tests
- Historical customer tests
- **Authoritative definitions:** All test examples

---

## Review Order Recommendation

1. **Start here:** 00-index.md (this file)
2. **High-level flow:** 01-payment-flow.md
3. **Data model:** 02-database-tables.md
4. **Security model:** 03-rls-permissions.md
5. **Business logic:** 04-payment-rpcs.md
6. **External integration:** 05-stripe-webhooks.md
7. **Discount rules:** 06-reservations-discounts.md
8. **Async processing:** 07-receipt-jobs.md
9. **Test coverage:** 08-tests-invariants.md

---

## Cross-Reference Map

| Topic | Authoritative Definition | Referenced In |
|-------|-------------------------|---------------|
| `payment_reservations` schema | 02-database-tables.md | 01, 04, 05, 06, 08 |
| `credit_packages` schema | 02-database-tables.md | 04, 06 |
| `receipt_outbox` schema | 02-database-tables.md | 07, 08 |
| `company_members` schema | 02-database-tables.md | 03, 01 |
| State transitions | 02-database-tables.md | 04, 05, 08 |
| RLS policies | 03-rls-permissions.md | 01, 08 |
| GRANT/REVOKE | 03-rls-permissions.md | 04, 07 |
| `create_payment_reservation` | 04-payment-rpcs.md | 01, 06, 08 |
| `attach_stripe_payment_intent` | 04-payment-rpcs.md | 01, 05, 08 |
| `process_stripe_payment_atomic` | 04-payment-rpcs.md | 01, 05, 08 |
| `expire_pending_reservation` | 04-payment-rpcs.md | 01, 05, 08 |
| `cancel_processing_reservation` | 04-payment-rpcs.md | 01, 05, 08 |
| `claim_receipt_job` | 07-receipt-jobs.md | 08 |
| `complete_receipt_job` | 07-receipt-jobs.md | 08 |
| `fail_receipt_job` | 07-receipt-jobs.md | 08 |
| Webhook flows | 05-stripe-webhooks.md | 01, 08 |
| Discount logic | 06-reservations-discounts.md | 04, 08 |
| Migration strategy | 06-reservations-discounts.md | — |
| Test examples | 08-tests-invariants.md | — |

---

## Known Issues (Fixed in FIX 5)

These issues were identified during review and **fixed in FIX 5**:

1. ~~**RLS not enabled**~~ — FIXED: Added `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for all payment tables
2. ~~**Transition trigger blocks same-state updates**~~ — FIXED: Added early return for `OLD.status = NEW.status`
3. ~~**`company_members` policy model needs tightening**~~ — FIXED: Added RLS policies for `company_members` table
4. ~~**Rollback section has wrong `complete_receipt_job` signature**~~ — FIXED: Updated to `(UUID, TEXT)` signature
5. ~~**RPC result-shape mismatch**~~ — FIXED: Added `.single()` and `.maybeSingle()` to JavaScript examples
6. ~~**Concurrent receipt worker test pre-claims job**~~ — FIXED: Rewrote test to create pending job first
7. ~~**Receipt failure/recovery race safety**~~ — FIXED: Made `fail_receipt_job` atomic with conditional update
8. ~~**Companies SELECT permission documentation**~~ — FIXED: Updated documentation to match actual permissions

## FIX 5 Changes

**Date:** 2026-08-30  
**Status:** COMPLETE

### Changes Made:
1. **Enabled RLS** on all payment/security-related tables
2. **Fixed transition trigger** to allow same-state updates
3. **Fixed company_members RLS** with non-recursive policies
4. **Fixed RPC result shapes** in JavaScript examples
5. **Fixed concurrent receipt worker test** to be deterministic
6. **Fixed complete_receipt_job signature** consistency
7. **Fixed receipt failure/recovery race safety** with atomic updates
8. **Fixed companies SELECT permission** documentation
9. **Added comprehensive tests** for RLS, transitions, and race safety
10. **Updated all split documents** for consistency

### Files Changed:
- 00-index.md (this file)
- 01-payment-flow.md
- 02-database-tables.md
- 03-rls-permissions.md
- 04-payment-rpcs.md
- 05-stripe-webhooks.md
- 06-reservations-discounts.md
- 07-receipt-jobs.md
- 08-tests-invariants.md

### Tests Run:
- No tests were actually executed (documentation only)
- All test examples updated to match corrected architecture

### Unresolved Issues:
- None remaining from FIX 5 scope

---

---

## Reconstruction Instructions

To reconstruct the complete payment architecture:

1. Read all files in order (00-08)
2. Follow cross-references to authoritative definitions
3. Combine SQL from 02, 03, 04, 07 for database schema
4. Combine JavaScript from 01, 05, 07 for application code
5. Combine tests from 08 for test suite

All information is preserved from the original PAYMENT-ARCHITECTURE.md.
