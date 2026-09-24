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

### GDPR / website copy review — DONE
See commit "content: honest homeowner-facing copy + GDPR wording + frontend
double-submit guard". Summary: removed "Verified Installers" (index.html,
waitlist.html), "No Spam Guarantee", "Response in 24h", and "certified and
reviewed" — none of these are true of the current system (no verification
step exists anywhere in the codebase; terms.html itself already disclaims
certificate verification). Replaced with factual equivalents. Repositioned
the homeowner hero to the brief's requested copy and added the previously
entirely-absent heating-capability line. Added an explicit data-sharing
disclosure on the quote form itself (not just buried in the separate privacy
page). Strengthened privacy.html's data-sharing sentence and added a
retention section that didn't exist before. No marketing-consent checkbox
exists anywhere in the product today, so "must not be mandatory" is
trivially satisfied — but also nothing currently captures marketing consent
at all; privacy.html now says plainly that quote data isn't used for
marketing, which is an accurate description of current behavior, not a new
promise. **This is content/copy, not a code fix — flagged for legal/business
review before publishing, per the task's own instruction to separate
technical changes from anything needing owner sign-off.**
Not addressed (out of scope for a code review, needs a business decision):
GA4 loads unconditionally on every page with no cookie-consent banner. Not
changed — this needs a product/legal decision (consent banner vs. relying on
another lawful basis), not a unilateral code change.

### Duplicate-submission / idempotency — DONE
See commit "fix: validate required lead fields and add duplicate-submission
protection" and "content: ... frontend double-submit guard". Backend:
`createLead()` in server.js now checks for an existing lead with the same
(normalized) email + postcode created in the last 5 minutes before inserting;
if found, returns it idempotently instead of creating a duplicate or
re-running distribution. Frontend: the submit button now disables itself and
shows a loading state for the duration of the request, so most double-clicks
never even generate a second HTTP request. **Documented residual limitation:**
the backend check is an application-level check-then-insert, not a
DB-enforced uniqueness constraint, so it does not fully close the race
between two requests that hit different server instances at the exact same
instant. Closing that completely (e.g. a generated dedupe-bucket column +
unique index + atomic RPC, following the same pattern as the payment/credit
RPCs) needs a live Postgres to design and verify safely — blocked by the
Phase 2 tooling gap, not skipped by choice. Given this is a lead-gen enquiry
(not a payment), the blast radius of that residual race is small and
self-correcting.

### Lead matching review — DONE, recommendation documented, nothing external added
Findings (see also the "Lead Distribution" note above):
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
- **Recommendation (not implemented — needs a product decision, not a code
  fix):** `company.coverage_areas` (an explicit list of postcode-outward-code
  strings the contractor chooses to serve) is already the primary, correct
  mechanism and works fine as-is. The concern is the *fallback* path for
  companies with no `coverage_areas` set: it matches on the company's own
  postcode's first-two-characters against the lead's, which is a genuinely
  crude proxy for "nearby" (e.g. postcode areas "SW" and "SE" share a
  first-two-char prefix "S" only if both are literally two letters — for many
  UK areas this fallback either barely matches anything or, worse, treats two
  unrelated towns that happen to share a leading letter as adjacent; it does
  not use `radius` or any real distance at all). Two honest options, both
  requiring a business call: (a) treat `coverage_areas` as mandatory at
  registration (remove the crude fallback entirely, forcing contractors to
  explicitly declare where they work — simplest, safest, no new dependency),
  or (b) implement real distance-based matching using `radius`, which requires
  geocoding postcodes to coordinates — the free option is a static UK postcode
  lookup dataset (e.g. the ONS postcode directory) bundled/loaded locally, no
  external paid API and no per-request network call, but it's a real scope
  increase (dataset size, one-time import, haversine distance calc) that
  deserves sign-off before building, per the instruction not to introduce a
  paid mapping service unilaterally. Not implemented either way this session.

## Supabase security review (2026-09-24, second pass — real production RLS state)

An independent read-only check of the live Supabase project (performed externally,
not by this session — this session never touched production) reported the actual
current RLS state, which this section reviews against. **No production changes
were made in response to this — everything below is local-only proposed migrations
and tests, per the explicit instruction not to modify Supabase.**

**Reported RLS DISABLED (flagged by Supabase's advisor as exposed public tables):**
`leads`, `prospects`, `tasks`, `suppliers`, `products`, `orders`, `order_items`.

**Reported RLS ENABLED, no policies:** `companies`, `credit_ledger`,
`credit_packages`, `payment_reservations`, `purchases`, `receipt_outbox` — this
is exactly migration 003's own tables, and matches what this review already
confirmed in the first pass as **intentional and correct** (see the RLS section
above): the app uses only a custom-JWT/service-role architecture, migration 003's
own inline comments say so explicitly, and `service_role` bypasses RLS. No policies
added to these six per instruction #7 — doing so would be adding policies "merely
to silence the advisor," which was explicitly ruled out.

**Reported:** `prevent_invalid_transitions` has a mutable/unset search_path
warning — this is the exact function migration 007 (written in the first pass of
this review, before the external check) already hardens with
`SET search_path = public, pg_temp`. Re-confirmed: migration 007 needs no changes.
It only touches this one trigger function on `payment_reservations`, which is
unrelated to any of the seven newly-reported tables, so the new schema information
doesn't affect it.

### Access-path investigation for the seven RLS-disabled tables

Exhaustive repo search (not inference) before writing anything:
- Every `createClient()` call anywhere in this repository —
  `api/server.js`, `scripts/migrate-coverage-areas.js`, and
  `tests/payment-architecture.test.js` (3 call sites total, verified by
  `tests/supabase-access-pattern.test.js`) — is fed `SUPABASE_SERVICE_KEY`.
  There is no anon-key or authenticated-session Supabase client anywhere.
- `grep -rl "supabase" --include=*.html .` across all 14 HTML files in the repo:
  zero matches. Confirmed independently by a pre-existing artifact already in
  this repo, `chatgpt-review/03-tests-and-project-usage.txt` line 1205-1207,
  from an earlier unrelated review: "Scanning all HTML files for
  Supabase/createClient/anon key usage... (No matches found — zero frontend
  Supabase access)." Two independent checks agree.
- `leads`: 11 references in `server.js`, ALL through the single module-level
  `supabase` (service-role) client — lead creation, admin stats, lead
  distribution eligibility queries, `getLeadsForUser`/`updateLeadForUser`.
  **Access path: server-side, service-role only.**
- `prospects`: 4 references, all under `requireAdmin` routes
  (`GET/POST /api/prospects`, `PUT/DELETE /api/prospects/:id`), all through
  the same service-role client. **Access path: server-side, service-role only,
  admin-gated at the application layer too.**
- `tasks`: 4 references, same pattern as prospects
  (`GET/POST /api/tasks`, `PUT/DELETE /api/tasks/:id`), all `requireAdmin`.
  **Access path: server-side, service-role only, admin-gated.**
- `suppliers`, `products`, `orders`, `order_items`: **zero references anywhere
  in this repository** — no route, no frontend, no migration creates or
  queries them. **Access path: unknown/legacy from this codebase's perspective.**
  Not part of ACConnX as this repo defines it.

### Proposed migrations (local only, NOT applied)

**`api/migrations/008-enable-rls-service-role-only-tables.sql`** — enables RLS
on `leads`, `prospects`, `tasks` with explicit `REVOKE ALL FROM anon,
authenticated, PUBLIC` and **no policies**, mirroring migration 003's own
established, already-working-in-production pattern exactly. Since every access
path to these three tables is confirmed service-role-only, and service_role
bypasses RLS, this changes nothing about what the application can do — it only
closes the direct-PostgREST/anon-key exposure the advisor flagged. Static
regression test: `tests/migration-008-rls-service-role-tables.test.js` (5 tests).
**Confidence: high.** Caveat stated plainly in the migration's own header: this
conclusion is scoped to what exists in this repository — if some consumer
outside this codebase queries these tables directly via anon/authenticated key,
this would break it. Nothing found suggests that, but this review has no
visibility outside its own repo.

**`api/migrations/009-lockdown-unreferenced-tables-VERIFY-FIRST.sql`** —
same treatment (RLS + REVOKE, no policies, no new grants) for `suppliers`,
`products`, `orders`, `order_items`. Deliberately kept as a **separate file**
from 008, and its own header explicitly says not to apply it without first
confirming nothing outside this repo depends on these tables (check row
counts/recent activity in the Supabase dashboard; ask whoever has
organizational context on this project). **Confidence: lower than 008** —
this review can prove these tables are unused *by ACConnX's own code*, but
cannot prove nothing else uses them. Static regression test:
`tests/migration-009-rls-unreferenced-tables.test.js` (5 tests), including an
explicit assertion that the file documents its own "verify first" warning.

**`tests/supabase-access-pattern.test.js`** (3 tests) — a new permanent
regression guard that encodes the safety argument behind migration 008 (and,
retroactively, migration 003's own already-live pattern) as an executable
check: every `createClient()` call must be traceably fed a `SERVICE`-named env
var (never `ANON`/`PUBLISHABLE`), and no `.html` file may ever reference
Supabase. If either ever becomes false — someone adds an anon-key client, or
wires up client-side Supabase access — this test fails loudly, because at that
point every "RLS enabled, no policies, service_role bypasses it" table in this
codebase (all nine of them, once 008 is applied) needs re-review, not just the
new code.

## Vercel Preview deployment attempt (2026-09-24) — BLOCKED on missing credentials

Approval was given for exactly one Vercel Preview deployment of
`sandbox/production-readiness-review` to verify the packaging fix. Before
attempting anything, recorded state:
- Branch: `sandbox/production-readiness-review`
- Commit: `dc0f981f4e2aa7e1a042c48dc3c94386395bb651`
- `git status`: clean, nothing to commit
- Test suite: 130 passing assertions / 17 runnable files / 0 failures / 1
  blocked (unchanged from the last report)

**The deployment could not be performed from this session.** Checked, in order:
- Vercel CLI: not installed (`vercel: command not found`), and `.vercel/`
  (the project-link directory the CLI creates) does not exist in this
  checkout — this local copy has never been linked to a Vercel project.
- `VERCEL_TOKEN` environment variable: not set.
- Any existing global Vercel CLI auth config on this machine (the usual
  locations under the user profile): none found.
- GitHub CLI (`gh`), which could at least confirm whether a Vercel-GitHub
  integration exists for this repo's `origin` remote
  (`github.com/Smedz999/hvac-btu-calculator`) without needing Vercel
  credentials directly: not installed either.

There is no path to authenticating with Vercel from this session without
either (a) an interactive browser/email OAuth flow, which this non-interactive
tool environment cannot complete, or (b) a pre-existing token, which does not
exist here. This is a genuine credential/access blocker (stopping condition A
from the original task brief), not something to work around — no attempt was
made to solicit a token be pasted into the conversation, since that is not a
safe way to hand credentials to an assistant.

**Nothing was deployed, pushed, or otherwise changed as a result of this
attempt.** See the report given to the user for what's needed to unblock this.

### Status at end of this session: all safely-completable phases done

Phases 1, 2, 6 (except the documented pre-existing-tables RLS blocker), 7, 8,
9, 10 are complete. Phase 3/4 (test matrix / adversarial) is substantially
built out for every high-risk area identified (auth boundary, credit/price
manipulation, Stripe webhook, lead submission/dedup, Vercel packaging) but is
NOT an exhaustive implementation of every single bullet in
`ACCONNX-TEST-PLAN.md` — that document's checkboxes are the authoritative
record of what's covered ([x]) vs. still open ([ ]) vs. blocked ([B]) for
anyone resuming this work. Phase 11 (full regression) has been run repeatedly
throughout, not just once at the end.

## If resuming this work later, in priority order:
1. Highest-value remaining test gaps per `ACCONNX-TEST-PLAN.md`'s open [ ]
   items: admin-route-specific authz tests (company/purchase visibility),
   direct offline tests of the eligibility-filter + fairness-sort logic in
   `distributeLead()` in isolation (currently only exercised indirectly),
   concurrent-simultaneous-lead-submission simulation at the JS level.
2. If a real sandbox Supabase project or local Postgres ever becomes
   available: re-run `tests/payment-architecture.test.js` for real, and
   design a genuinely DB-enforced duplicate-lead guard (see the Lead
   Matching / Duplicate-submission sections above) plus real concurrency
   proof for migrations 003/006/007.
3. Business decisions flagged above and not resolved by this session: the
   lead-matching fallback strategy (mandatory coverage_areas vs. real
   distance matching), whether to add a cookie-consent banner for GA4, legal
   review and publish of the copy changes in this branch.
4. Everything in this branch is local-only. Nothing has been pushed, merged,
   or deployed.
