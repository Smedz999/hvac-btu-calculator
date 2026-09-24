# ACConnX Production-Readiness Review — Progress Log

Working branch: `sandbox/production-readiness-review` (created from `master`, all
work here is local-only; nothing pushed). Companion docs: `ACCONNX-TEST-PLAN.md`,
`ACCONNX-TEST-RESULTS.md`.

## Status: IN PROGRESS (autonomous, resumable)

Last updated: 2026-09-24

---

## Phase 1 — Discovery (DONE)

- Repo root: `C:\Users\leesm\hvac-btu-calculator`. Single Express app in `api/server.js`
  (1546 lines) deployed as one Vercel serverless function, plus static HTML frontend
  at repo root (index.html = homeowner calculator, company-portal.html = contractor
  dashboard, admin.html = admin dashboard, crm.html, for-contractors.html, etc.)
- Git: on `master`, clean working tree, up to date with `origin/master` before we
  branched. Commit `7990520` ("fix: make lead credit allocation atomic") **is** the
  current HEAD of master — the hardened lead-distribution work IS in the working tree.
  Preceding hardening chain, newest first:
  - `7990520` fix: make lead credit allocation atomic (migration 006)
  - `c38212e` fix: harden multi-contractor lead distribution
  - `f7b024d` fix: secure contractor lead authorization (migration 005 groundwork)
  - `95e84a4` fix: configure trust proxy for vercel
  - `4785e5f` feat: add resilient receipt scheduler (migration 004)
  - `93b9108`/`4b0f46c` payment architecture (migration 003)
- Other branches present locally/remote: `claude-handoff`, `chore/resend-upgrade-uuid-cleanup`
  (not touched).
- Backend deps (api/package.json): express, @supabase/supabase-js, stripe, resend,
  bcryptjs, jsonwebtoken, express-rate-limit, twilio, web-push, cors, dotenv.
  devDependencies: only `nodemon` — **no test framework** (no jest/mocha). Existing
  `api/tests/*.test.js` are plain Node scripts using the built-in `assert` module,
  run individually via `node api/tests/<file>.test.js`.
- Root `package.json` (repo root, not `api/`) oddly lists `express-rate-limit` and
  `jsonwebtoken` as dependencies with no scripts — appears to be a stray/legacy file,
  not used by anything (the real API lives in `api/`). Low priority cleanup candidate,
  not touched.
- `api/.env` exists locally (gitignored) with real-looking keys for Supabase, Stripe,
  Resend, VAPID, JWT_SECRET, ADMIN_PASSWORD. **Not read, not printed.** Sandbox work
  uses only dummy env values injected in-process (see test files' own env setup).
- No `supabase/` directory, no Docker, no Supabase CLI available in this environment
  (verified: `docker --version` and `supabase --version` both fail). See Phase 2 blocker.
- Migrations present: 003 (payment reservation architecture — reservations, purchases,
  credit_ledger, receipt_outbox, credit_packages, RLS, RPCs), 004 (receipt job reclaim),
  005 (leads.parent_lead_id), 006 (atomic lead credit allocation RPCs). **Migrations
  001/002 are absent from the repo** — the base schema (companies, leads, prospects,
  tasks, password_reset_codes) predates version control of migrations. See Security
  Findings below.
- `docs/payment-architecture-review/*.md` (9 files, ~3500 lines total) is a prior
  independent design review of the payment system. Some of it (e.g.
  `03-rls-permissions.md`) describes an **aspirational** `company_members`/Supabase-Auth
  RLS design that was never implemented; the actual applied migration (003) uses a
  simpler, deliberate "deny-all for anon/authenticated, service_role bypasses RLS"
  model, documented inline in the SQL with reasoning. Confirmed correct — see Security
  Findings. The doc should eventually be marked superseded to avoid confusing future
  readers, but that's a docs-hygiene nit, not a bug.
- GitHub Actions: `.github/workflows/process-receipts.yml` hits
  `https://acconnx.com/api/internal/process-receipts` every 5 minutes with a
  `CRON_SECRET` bearer token (production endpoint — we do not call this from sandbox).

## Phase 2 — Sandbox (DONE, with one documented blocker)

- Created local branch `sandbox/production-readiness-review` off `master`. All
  local commits happen here; nothing will be pushed or merged without explicit
  approval.
- **BLOCKER (documented, not worked around):** No Docker and no Supabase CLI are
  installed in this environment, so a local/ephemeral Postgres+Supabase instance
  cannot be created to run real RPC/trigger-level integration or concurrency tests
  (e.g. actually exercising `FOR UPDATE` locking under concurrent transactions, or
  running the SQL migrations against a real database). Per instructions, production
  Supabase is NOT used as a substitute. Everything that can be tested without a live
  Postgres (pure Node logic, static SQL-shape assertions, mocked-Supabase-client
  behavioral tests) proceeds normally — this is how the existing test suite already
  works, and it's the pattern all new tests in this review follow too.
  - **What this blocks:** true concurrency proof of the `FOR UPDATE` row locks in
    migrations 003/006, an actual `payment-architecture.test.js` run (it requires a
    live server + live Supabase on localhost:3001), and end-to-end webhook-to-database
    verification.
  - **What is NOT blocked:** offline unit tests of `server.js` logic via dependency
    injection (the existing/established pattern), static analysis of every migration's
    SQL text, full security/code review, frontend/GDPR copy review, Vercel packaging
    investigation, and adversarial tests against `server.js`'s in-process route logic
    with a fully scripted fake Supabase client (which can simulate races, partial
    failures, and adversarial RPC responses deterministically — arguably better for
    regression-proofing exact JS behavior than a real DB would be, at the cost of not
    proving the SQL side).
  - If a real sandbox Supabase project (or local Postgres) becomes available later,
    re-run `api/tests/payment-architecture.test.js` and re-derive concurrency proof
    for migrations 003/006 against it. Until then, this is the standing limitation of
    this review.

## Phase 3+ — Test Matrix / Security / Vercel / GDPR / Duplicate protection / Lead matching

See `ACCONNX-TEST-PLAN.md` for the matrix and `ACCONNX-TEST-RESULTS.md` for live
pass/fail status. Narrative findings-in-progress:

### Baseline test run (existing suite, before any changes)
All 8 offline test files pass cleanly, 0 failures:
`distribute-lead-secondary-insert`, `lead-authorization`, `migration-005-parent-lead-id`,
`migration-006-lead-credit-atomicity`, `receipt-cron-auth`, `receipt-idempotency-key`,
`receipt-send-error-handling`, `trust-proxy`.
`payment-architecture.test.js` requires a live server (blocked, see Phase 2).

### Security review (in progress)
- RLS on payment/credit tables: **confirmed correct by design** (service_role bypasses
  RLS; anon/authenticated fully revoked; no policies needed). Not a bug.
- `prevent_invalid_transitions()` trigger function (migration 003, ~line 236) is
  **missing `SECURITY DEFINER` + `SET search_path = public, pg_temp`** that every
  other function in the same file has. Practical risk is low (the function only
  compares `OLD.status`/`NEW.status` text and has no unqualified object references to
  hijack), but it's inconsistent with the file's own hardening pattern and was
  explicitly called out as an area of concern — hardening it is a safe, local,
  zero-risk fix. Planned.
- **No Supabase publishable/service key is embedded in any frontend HTML** — confirmed
  by grep. The only client-embedded key is a Stripe **publishable** key in
  `company-portal.html` (`pk_live_...`), which is safe/by-design to expose (Stripe
  publishable keys are not secrets). No action needed.
- **Cannot verify RLS status of `leads`, `prospects`, `tasks`, `password_reset_codes`
  tables** — these were created before migration 003 (no 001/002 migration files exist
  in the repo) and this session has no database access. `leads` holds homeowner PII
  (name, email, phone, postcode). This is flagged as a **production action item for
  the user**, not something fixable locally: confirm in the Supabase dashboard whether
  RLS is enabled on these tables (it should be, deny-all, same pattern as migration 003,
  since the backend only ever uses the service key).
- Full route-by-route authz re-audit of `server.js` still in progress (see test plan).

### Vercel deployment investigation — RESOLVED with evidence, fix applied and tested
Confirmed via Vercel's own current docs (https://vercel.com/docs/functions/runtimes#functions-created-per-deployment,
fetched during this review): "When using other frameworks, or Vercel Functions
directly without a framework, every API maps directly to one Vercel Function...
For Hobby, this approach is limited to 12 Vercel Functions per deployment."
This project has no framework Vercel recognizes (static HTML + a bare `/api`
directory), and `vercel.json` has no `functions`/`builds` key, so zero-config
detection applies. Before the fix, `/api` contained **13** `.js` files: `index.js`,
`auth.js`, `server.js`, `migrate-coverage-areas.js`, plus **9 files under
`api/tests/*.test.js`** — one over the Hobby limit. Those 9 test files were added
across exactly the lead-distribution hardening commits the user flagged
(`7990520`, `c38212e`, `f7b024d`, `95e84a4`, `f773cd9`, `4785e5f`, `314179b`,
`4b0f46c`), which lines up precisely with "the hardened version previously
completed its build, reached Deploying outputs, then failed" — the test suite
built up during that exact work pushed the function count over the line.
Per Vercel's own official guidance (confirmed via a maintainer response in
https://github.com/vercel/community/discussions/46 — there is no supported
per-file exclusion for a vanilla `/api` project, e.g. `.vercelignore` cannot
safely exclude a file another function still needs to `require()`), the fix is
to move non-handler files outside `/api` entirely:
- `api/tests/` → `tests/` (repo root)
- `api/migrate-coverage-areas.js` → `scripts/migrate-coverage-areas.js`
- Fixed every relative path inside the moved files (`__dirname`-relative
  references to `server.js`, `auth.js`, the migration `.sql` files, and `.env`
  all updated from `../X` to `../api/X`), and fixed three places where moved
  files did a bare `require('express')` / `require('dotenv')` /
  `require('@supabase/supabase-js')` — those packages only live in
  `api/node_modules`, not a top-level `node_modules`, so bare requires broke
  after the move; changed to resolve explicitly via
  `require(path.join(__dirname, '../api/node_modules/<pkg>'))`.
- `/api` now contains exactly 3 `.js` files (`index.js`, `auth.js`, `server.js`)
  — well under the limit.
- **Verified locally:** all 8 previously-passing offline test files still pass
  from their new location (65/65 assertions, identical to baseline).
  `payment-architecture.test.js` now correctly fails only at the expected/blocked
  network step (no live server), not at a module-resolution error — confirming
  the move didn't break it either.
- **New regression test added:** `tests/vercel-function-count.test.js` — fails
  loudly if `api/tests/` or `api/scripts/` reappear, if the total `.js` file
  count under `/api` (recursive) exceeds a safe threshold (8, well under
  Vercel's 12), or if an unexpected file appears directly under `/api`. This
  guards against the exact same mistake recurring.
- **Not verified (cannot be, without deploying):** that this was the *only*
  contributing cause, or that Vercel's current count-detection logic is
  unchanged from what the docs describe. This is a confident, evidence-based
  fix, not a deploy-confirmed one — flagged clearly in the final report as
  "local fix applied and tested; a real Vercel deploy (Preview, not Production)
  is the only way to fully confirm" — which requires your approval per the
  safety boundary (no deploys from this session).

### GDPR / website copy review (not yet started)
### Duplicate-submission / idempotency (not yet started)
### Lead matching review (partially observed during Phase 1 read of `distributeLead()`
in `server.js`):
- Matching is postcode-prefix based only: primary match is
  `company.coverage_areas` containing/contained-by the lead's postcode prefix (text
  before the first space, e.g. "SW1A"); if a company has no `coverage_areas` set, it
  falls back to comparing the company's own postcode prefix, then a **first-two-character
  fallback** (`companyPrefix.substring(0,2) === leadPrefix.substring(0,2)`) — confirmed
  this fallback exists, exactly as flagged in the task.
- `company.radius` is stored on every company (default 25) but **is never read anywhere
  in `distributeLead()` or elsewhere in `server.js`** — confirmed dead/unused column.
  No actual radius/distance calculation exists; "radius" is currently just a number
  sitting in the database with no effect on matching.
  No lat/long geocoding exists in the codebase at all.
- Allocation fairness: eligible companies are sorted by fewest leads already received
  (ascending), tie-broken by most credits (descending) — a simple fairness heuristic,
  confirmed. Top 3 are selected.
- Full writeup with recommendation goes in the final report; no paid mapping service
  will be introduced without approval per instructions.

## Next steps (resume point if session ends here)
1. Write `ACCONNX-TEST-PLAN.md` and `ACCONNX-TEST-RESULTS.md` (this file references
   them — create immediately after this checkpoint).
2. Local commit of the three tracking docs + sandbox branch checkpoint.
3. Vercel packaging investigation (evidence-based) + local structural fix + test.
4. Harden `prevent_invalid_transitions()` search_path (migration 007, local only) +
   regression test in the style of `migration-006...test.js`.
5. New offline adversarial test files for: credit-system attacks, Stripe
   package/price manipulation, webhook signature/replay handling, admin authz,
   duplicate-lead-submission idempotency — following the established fake-Supabase-client
   pattern.
6. GDPR/website copy review of `privacy.html`, `terms.html`, `index.html`,
   `waitlist.html`, `for-contractors.html`.
7. Full regression run + gap analysis + final report.
