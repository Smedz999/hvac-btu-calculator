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
2. `prevent_invalid_transitions()` hardened with `SECURITY DEFINER` + pinned
   `search_path` via local-only migration 007. Static regression test added.
3. `npm audit fix` applied to `api/` — 3 moderate `qs` (DoS/bypass, via
   express/body-parser) vulnerabilities resolved, patch/minor bumps within
   existing semver ranges. `npm audit` now reports 0 vulnerabilities.
4. **POST /api/leads hardened**: required-field validation (customerName,
   customerEmail with format check, postcode) added — previously accepted
   leads with none of these present. Duplicate-submission protection added
   (5-minute window, same email+postcode → idempotent return of the existing
   lead, no re-distribution). 9 new offline tests.
5. **Stripe webhook route refactored for testability** (behavior unchanged,
   verified via full regression) and given 17 new offline tests — previously
   zero coverage on the single route with sole authority to grant paid
   credits.
6. **10 new auth-middleware tests** (`requireAuth`/`requireAdmin`) — forged
   tokens, tampered role claims, `alg:none`, expired tokens, malformed
   headers — previously untested directly.
7. **8 new credit/price-manipulation static invariant tests** pinning down
   protections already present in the code (credits/password always
   stripped from the generic company-update route; payment amount/currency
   always server-derived; company id always JWT-derived).
8. **Frontend**: `index.html` lead-submission button now disables and shows
   a loading state during the request (complements the backend dedup fix);
   a 4xx validation response now shows the specific error via toast instead
   of destroying the whole form.
9. **Website copy**: removed unsupported "Verified Installers" / "No Spam
   Guarantee" / "Response in 24h" / "certified and reviewed" claims from
   `index.html` and `waitlist.html`, replaced with factual wording;
   repositioned the homeowner hero copy and added the (previously absent)
   heating-capability line; strengthened `privacy.html`'s data-sharing and
   retention wording. **Content change — needs legal/business review before
   going live**, not a pure technical fix; flagged as such in the final
   report.

## Supabase security review — second pass (real production RLS state)

An independent read-only check of the live Supabase project reported exact
current RLS state. Production was not touched. New local-only migrations and
tests added in response — see ACCONNX-PROGRESS.md for the full access-path
investigation.

| Table | Reported state | Access path (confirmed by repo search) | Action |
|---|---|---|---|
| leads | RLS disabled | server-side, service-role only (11 refs) | migration 008: enable RLS, revoke anon/auth, no policies |
| prospects | RLS disabled | server-side, service-role only, admin-gated (4 refs) | migration 008 |
| tasks | RLS disabled | server-side, service-role only, admin-gated (4 refs) | migration 008 |
| suppliers | RLS disabled | **unreferenced anywhere in this repo** | migration 009 (verify-first, not bundled with 008) |
| products | RLS disabled | **unreferenced anywhere in this repo** | migration 009 |
| orders | RLS disabled | **unreferenced anywhere in this repo** | migration 009 |
| order_items | RLS disabled | **unreferenced anywhere in this repo** | migration 009 |
| companies, credit_ledger, credit_packages, payment_reservations, purchases, receipt_outbox | RLS enabled, no policies | server-side, service-role only (migration 003's own design) | **confirmed intentional — no change** |
| prevent_invalid_transitions | mutable search_path warning | n/a (trigger function) | already fixed by migration 007 (written before this check) — re-confirmed, no changes needed |

New tests this pass:

| File | Result | Assertions |
|---|---|---|
| tests/migration-008-rls-service-role-tables.test.js | ✅ PASS | 5/5 |
| tests/migration-009-rls-unreferenced-tables.test.js | ✅ PASS | 5/5 |
| tests/supabase-access-pattern.test.js | ✅ PASS | 3/3 |

## Vercel Preview deployment — VERIFIED (2026-09-24, second attempt)

Deployed successfully after the user completed `vercel login` locally. Full
detail in ACCONNX-PROGRESS.md. Summary:

- Linked to the correct existing project (`hvac-calculator`, confirmed via its
  `acconnx.com`/`www.acconnx.com` domain attachment) — no new project created.
- Deployment `dpl_2weqVP3puFpxiZsvei5GcM1vLpBx`, target `preview`, status
  `Ready`. URL: `https://hvac-calculator-bh1rsw2dw-isla999.vercel.app`.
- **Original failure confirmed resolved**: a real historical failed Production
  deployment (commit `7990520`, the pre-fix commit) showed `Build Completed` →
  `Deploying outputs...` → `Error`. This new deployment shows the identical
  sequence but reaches `Ready` instead.
- Static/frontend pages (homepage, privacy, terms, contractor portal, admin,
  manifest, icons, 404 fallback): all HTTP 200/404 as expected, content
  verified via `vercel curl` (bypasses Preview's SSO wall).
- `/api/health`: HTTP 500 (`FUNCTION_INVOCATION_FAILED`) — root cause
  confirmed via `vercel logs`: `JWT_SECRET environment variable is required`.
  `vercel env ls` (names only, no values) confirms every secret in this
  project (`CRON_SECRET`, `JWT_SECRET`, `ADMIN_PASSWORD`, `RESEND_API_KEY`,
  `SUPABASE_SERVICE_KEY`, `SUPABASE_URL`, `MONGODB_URI`, `STRIPE_SECRET_KEY`)
  is scoped to Production only, none to Preview. **This means Preview cannot
  reach Supabase, Stripe, Resend, or Mongo at all** — the safest possible
  outcome, and unrelated to the packaging fix (a pre-existing project
  configuration gap, not a regression from this branch).
- No browser-based console/visual/mobile checks were performed (no browser
  automation available this session) — everything verified via HTTP/HTML
  inspection instead.

## Final regression totals (this session)

**130 passing assertions across 17 runnable test files, 0 failures, 1 file
blocked (payment-architecture.test.js — documented environment limitation,
unchanged since baseline).**
