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

## Re-run after Vercel fix (test files moved api/tests/ → tests/)

| File | Result | Assertions |
|---|---|---|
| tests/distribute-lead-secondary-insert.test.js | ✅ PASS | 13/13 |
| tests/lead-authorization.test.js | ✅ PASS | 11/11 |
| tests/migration-005-parent-lead-id.test.js | ✅ PASS | 8/8 |
| tests/migration-006-lead-credit-atomicity.test.js | ✅ PASS | 9/9 |
| tests/receipt-cron-auth.test.js | ✅ PASS | 9/9 |
| tests/receipt-idempotency-key.test.js | ✅ PASS | 3/3 |
| tests/receipt-send-error-handling.test.js | ✅ PASS | 8/8 |
| tests/trust-proxy.test.js | ✅ PASS | 4/4 |
| tests/payment-architecture.test.js | 🚫 BLOCKED (same reason as baseline) | Confirmed it now fails only at the network step, not a module-resolution error — the move introduced no regression |
| tests/vercel-function-count.test.js | ✅ PASS (NEW) | 3/3 |

**Totals: 68 passed, 0 failed, 0 skipped, 1 file blocked (documented, unchanged).**

## New tests added during this review

- `tests/vercel-function-count.test.js` — regression guard for the Vercel
  deployment fix (see Bugs Fixed below). 3 assertions, all passing.

## Bugs found

1. **Vercel deployment failure at "Deploying outputs..."** — `/api` contained
   13 `.js` files (zero-config Vercel treats each as its own Serverless
   Function; Hobby plan limit is 12). See ACCONNX-PROGRESS.md for full
   evidence chain. **FIXED.**
2. `prevent_invalid_transitions()` trigger function (migration 003) is missing
   `SECURITY DEFINER` + `SET search_path = public, pg_temp`, inconsistent with
   every other function in the same file. Practical risk is low (no unqualified
   object references inside it to hijack) but flagged explicitly by the review
   brief. Fix in progress.
3. Cannot verify RLS status of `leads`/`prospects`/`tasks`/`password_reset_codes`
   tables (predate the migrations in this repo; no DB access available). Not a
   confirmed bug — a documented verification gap requiring the user to check
   the Supabase dashboard directly.

## Fixes applied

1. **Vercel function-count fix** — moved `api/tests/` → `tests/`,
   `api/migrate-coverage-areas.js` → `scripts/migrate-coverage-areas.js`, fixed
   all relative paths and three broken bare `require()`s the move exposed,
   added `tests/vercel-function-count.test.js` as a permanent regression guard.
   Verified: full existing suite still green (68/68), moved files' syntax and
   module resolution confirmed working.
