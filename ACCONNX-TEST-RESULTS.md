# ACConnX Test Results

Updated as tests are run. See `ACCONNX-TEST-PLAN.md` for what each test is meant to
cover, and `ACCONNX-PROGRESS.md` for narrative context.

## Baseline run — before any changes (2026-09-24)

Command: `node api/tests/<file>.test.js` for each file individually (no test runner
configured; these are plain Node scripts using `assert`).

| File | Result | Assertions |
|---|---|---|
| distribute-lead-secondary-insert.test.js | ✅ PASS | 13/13 |
| lead-authorization.test.js | ✅ PASS | 11/11 |
| migration-005-parent-lead-id.test.js | ✅ PASS | 8/8 |
| migration-006-lead-credit-atomicity.test.js | ✅ PASS | 9/9 |
| receipt-cron-auth.test.js | ✅ PASS | 9/9 |
| receipt-idempotency-key.test.js | ✅ PASS | 3/3 |
| receipt-send-error-handling.test.js | ✅ PASS | 8/8 |
| trust-proxy.test.js | ✅ PASS | 4/4 |
| payment-architecture.test.js | 🚫 BLOCKED | Requires live server on localhost:3001 + real Supabase project (migration 003 applied). No local Supabase/Postgres available in this environment (no Docker, no Supabase CLI). Not run against production. |

**Totals so far:** 65 passed, 0 failed, 0 skipped, 1 file blocked (not a failure —
documented environment limitation).

## New tests added during this review

(none yet — this section will grow as Phase 3 offline tests are written per the plan)

## Bugs found

(none confirmed yet beyond the `prevent_invalid_transitions()` search_path
inconsistency noted in ACCONNX-PROGRESS.md — tracked there until a regression test
is written, at which point it moves here with PASS/FAIL status)

## Fixes applied

(none yet)
