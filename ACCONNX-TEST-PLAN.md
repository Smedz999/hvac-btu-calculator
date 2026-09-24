# ACConnX Test Plan — Production Readiness Review

This is the working test matrix for the review. Checkboxes track whether a test
**exists and is automated**, not whether it passes — pass/fail/blocked status lives
in `ACCONNX-TEST-RESULTS.md`. Anything marked BLOCKED cannot be safely automated in
this environment (see `ACCONNX-PROGRESS.md` Phase 2 blocker: no Docker/Supabase CLI,
so no live-database concurrency proof is possible here) and is called out explicitly
rather than silently skipped.

Legend: [x] automated & run, [ ] planned/not yet written, [B] blocked (documented reason)

## Authentication / Authorization
- [x] valid contractor login (existing: payment-architecture.test.js, live-server only — BLOCKED here)
- [ ] invalid login (bad password / unknown email) — offline route-logic test to add
- [x] unauthenticated requests rejected — covered indirectly by lead-authorization.test.js pattern; need explicit route-level version
- [x] contractor A cannot access contractor B's leads (lead-authorization.test.js)
- [x] contractor cannot modify another contractor's leads (lead-authorization.test.js)
- [x] contractor cannot directly alter credits (lead-authorization.test.js + server.js route review: PUT /api/companies/:id strips `credits` unconditionally, even for admin)
- [ ] contractor cannot access admin functions — need explicit requireAdmin-vs-contractor-JWT test
- [ ] forged IDs (numeric company id guessing / IDOR on /api/companies/:id) — need test
- [ ] malformed authentication (garbage JWT, wrong algorithm, expired token) — need test
- [ ] privilege escalation (contractor JWT with tampered `role` claim / re-signed with guessed secret) — need test
- [ ] admin login timing/behavior (correct password vs wrong; ADMIN_PASSWORD unset case) — need test

## Homeowner / Lead Submission
- [ ] normal homeowner submission — need offline test of POST /api/leads happy path
- [ ] calculator → quote journey (frontend, manual/browser pass — see Frontend section)
- [ ] required field validation — **finding:** POST /api/leads currently does NOT
      validate required fields server-side (no check for customerName/customerEmail/
      postcode presence before insert) — need test proving this, then decide fix
- [ ] malformed input (XSS-ish strings, huge payloads, wrong types for btu) — need test
- [ ] postcode formatting (lowercase, no space, extra spaces) — need test
- [ ] duplicate submission (identical payload twice) — **no protection currently exists
      in POST /api/leads**; this is Phase 9 territory, need design + test
- [ ] rapid double-click / near-simultaneous identical submissions — same as above
- [ ] network/request retry idempotency — same as above
- [ ] no eligible contractor → lead stays unassigned, no crash — need test
- [ ] one eligible contractor → primary only, no secondary attempted (covered:
      distribute-lead-secondary-insert.test.js "single eligible contractor")
- [x] multiple eligible contractors → top 3 selected, fairness sort (distribute-lead-secondary-insert.test.js covers RPC dispatch; the *sort/eligibility filter* itself is not yet directly unit tested — need test)

## Lead Distribution
- [x] correct eligibility filter logic — needs a DIRECT test of the postcode/coverage_areas
      filter + fairness sort in isolation (currently only exercised indirectly)
- [x] max 3 contractors (implicit in `.slice(0,3)`, not explicitly asserted — need test)
- [x] parent/child lead structure (migration-005-parent-lead-id.test.js — static SQL shape only)
- [x] zero-credit contractors excluded (`.gt('credits', 0)` filter — need explicit test)
- [x] credits deducted exactly once (migration-006 static shape test proves the SQL
      guards this; distribute-lead-secondary-insert.test.js proves server.js calls the
      RPC exactly once per company)
- [B] concurrent allocations / insufficient-credit races at the DB level (needs real
      Postgres to prove `FOR UPDATE` actually serializes — static SQL test only proves
      the lock statement exists, not that it works under real concurrency)
- [ ] multiple simultaneous leads to overlapping eligible contractor pools — need
      offline test simulating two distributeLead() calls racing against a shared fake
      credits pool
- [x] failure halfway through allocation (secondary RPC errors) → contractor #3 still
      attempted, no partial credit loss (distribute-lead-secondary-insert.test.js case g)
- [B] transaction rollback proof at the DB level (needs real Postgres)
- [x] no orphan copies on RPC failure (distribute-lead-secondary-insert.test.js — failed
      companies get no notification, implying no row was created; RPC-level guarantee
      not independently provable without DB)
- [B] no negative credit balance (DB-level CHECK/guard — static test only, not proven under load)
- [x] failed allocation cannot consume credits incorrectly (case (e2), (f))

## Credit System Attacks
- [x] client-side credit manipulation blocked (`PUT /api/companies/:id` deletes
      `updates.credits` unconditionally — confirmed in server.js, need explicit test)
- [ ] direct API credit manipulation via `/api/admin/adjust-credits` without admin JWT — need test
- [ ] negative adjustments (delta making balance negative) — need test of `admin_adjust_credits` caller-side validation (route allows any non-zero delta; DB-level floor is unverified without DB — BLOCKED for the DB guarantee, testable for the route's input validation)
- [ ] forged company IDs in adjust-credits body — need test (route trusts body.companyId; RPC presumably validates existence — need to confirm RPC behavior via static SQL read)
- [ ] repeated/replayed adjust-credits requests (no idempotency key on this endpoint — is that a problem? admin-triggered, not client-triggered, lower risk — document finding)
- [B] concurrent adjust-credits requests (needs real Postgres)

## Stripe / Payment System
- [ ] package catalogue served correctly, server-authoritative pricing — need test of `getPackage()`/create-payment-intent happy path
- [ ] first-purchase discount vs subsequent normal price — covered in docs/08-tests-invariants.md as a DB-level test; BLOCKED without DB, but the route-level "never trust client price" behavior (no price/amount ever accepted from client) is confirmed by code read and should get an explicit offline assertion
- [ ] invalid package id → 400, no reservation created — need test
- [ ] manipulated client price (client cannot send amount at all — confirmed by code read, POST /api/create-payment-intent only accepts `packageId`) — need explicit test asserting this contract
- [ ] manipulated company ID (companyId always taken from `req.user.id`, never body — confirmed by code read) — need explicit test
- [B] reservation creation/expiry under real DB triggers/cron — BLOCKED
- [B] successful/failed/cancelled payment full lifecycle — BLOCKED (webhook handler logic itself is unit-testable; the RPC's DB-side effects are not)
- [ ] webhook handler unit tests: duplicate event delivery, replay, malformed payload, unknown PaymentIntent, missing/invalid signature, wrong event type ignored — all achievable offline by mocking `stripe.webhooks.constructEvent` and the `supabase.rpc` call; need to write these (currently NOT covered by any existing test file)
- [B] concurrency/race at DB level — BLOCKED
- [x] credits issued exactly once — DB-level guarantee (idempotency key = PaymentIntent id, `already_processed` flag) documented and exercised by webhook handler's branch logic; need offline test of the branch logic itself (currently untested: no test file touches the webhook route at all)

## Stripe Webhook Security
- [ ] valid signature → processed — need offline test (mock stripe.webhooks.constructEvent success)
- [ ] invalid signature → 400, no processing — need offline test (mock throws)
- [ ] missing signature header → 400 — need offline test
- [ ] duplicate event / replay → idempotent (`already_processed`) — need offline test of the branch
- [ ] malformed payload → constructEvent throws → 400, handled — need offline test
- [ ] unknown PaymentIntent (`error.message.includes('not found')`) → 200 ack, no throw — need offline test
- [ ] any other RPC error → 500 (so Stripe retries) — need offline test
- **Note:** none of `server.js`'s webhook route currently has ANY automated test
  coverage. This is a real, notable gap given how security-critical this route is —
  high priority to add.

## Receipt System
- [x] job created once / duplicate prevention — covered by migration-004/006 static tests + idempotency key test
- [x] job claiming — `claim_receipt_job` RPC contract exercised in distribute/receipt tests indirectly; direct test not present
- [B] concurrent workers claiming the same job (needs real Postgres row locking)
- [x] retry after provider failure (receipt-send-error-handling.test.js)
- [x] stale/reclaimed jobs (receipt-cron-auth.test.js test 4/7)
- [x] completion path (receipt-send-error-handling.test.js tests 4-5)
- [x] provider idempotency key (receipt-idempotency-key.test.js)
- [x] email failure cannot corrupt payment/credits — architecturally true because the
      webhook's atomic RPC never touches receipt_outbox synchronously with payment
      completion in a way that failure could roll back credits (confirmed by code read
      of migration 003/006 comments); no direct test proves this without DB access (BLOCKED for DB proof)

## Admin
- [ ] company visibility (GET /api/companies requires admin) — need explicit test
- [ ] lead visibility (admin sees all via getLeadsForUser) — covered partially (case j in lead-authorization.test.js)
- [ ] purchase visibility (GET /api/admin/purchases requires admin) — need test
- [ ] authorized credit adjustment — need test
- [ ] unauthorized credit adjustment (contractor JWT on admin route) — need test
- [x] contractor/admin separation — covered generally by lead-authorization.test.js pattern; needs admin-route-specific version
- [ ] forged admin requests (tampered JWT role claim without valid signature) — need test

## Database / Security (static analysis, since no live DB)
- [x] RLS enabled + intentionally policy-free for anon/authenticated (confirmed correct — see progress log)
- [ ] `prevent_invalid_transitions()` missing SECURITY DEFINER + search_path pinning — confirmed gap, fix planned (migration 007, local)
- [B] Actual RLS status of `leads`/`prospects`/`tasks`/`password_reset_codes` (predate migrations 001/002, not in repo, not verifiable without DB access — flagged as a production action item for the user)
- [x] no Supabase keys embedded client-side (confirmed via grep)
- [ ] SQL injection exposure — all queries reviewed so far use the Supabase JS query
      builder (parameterized) or RPC calls with typed parameters, no raw string-built
      SQL found in server.js; full re-read of all remaining routes still in progress
- [ ] atomic RPCs — inventory and confirm every credit/payment mutation goes through
      an RPC, never raw `.update()` — mostly confirmed for leads/payments; still need to check `/api/admin/adjust-credits` and the credits column lockout on PUT /api/companies/:id (confirmed: unconditionally stripped)
- [ ] dependency vulnerabilities — need `npm audit` run against `api/`

## Frontend
- [ ] calculator — manual pass, need to actually load the page
- [ ] Get 3 Quotes flow — manual pass
- [ ] client-side validation — need to read index.html's JS
- [ ] double-click behaviour — need to read submit-button handling JS
- [ ] loading/error/success states — need to read
- [ ] mobile/responsive layout — need visual check
- [ ] obvious console/runtime errors — need to actually run the page

## Adversarial (Phase 4) — mapped onto the sections above; tracked once as "attack" framing:
- [ ] obtain another contractor's customer details → lead-authorization.test.js covers the API layer; need to also check there's no IDOR via numeric lead ID guessing on any other route
- [ ] obtain leads without credits → covered by (e)/(e2) in distribute-lead tests
- [ ] alter another contractor's lead → covered (lead-authorization case d)
- [ ] increase credits via any route other than admin RPC → need explicit negative test on PUT /api/companies/:id and POST /api/leads
- [ ] avoid credit deduction (e.g. malformed lead payload that still gets distributed) → need test
- [ ] manipulate package prices → need test (client only ever sends packageId)
- [ ] obtain first-purchase discount repeatedly → DB-level unique index guarantee, BLOCKED for live proof, static shape confirmed
- [ ] replay Stripe events → webhook idempotency, need offline test (see Webhook Security)
- [ ] generate credits twice → same
- [ ] duplicate leads → Phase 9 territory
- [ ] exploit simultaneous requests → BLOCKED at DB level, testable at JS level (need test)
- [ ] bypass admin authorization → need test
- [ ] manipulate company IDs → need test (JWT-derived id vs body id conflicts)
- [ ] access protected API endpoints without auth → need systematic sweep of every route
- [ ] exploit malformed input → need test
- [ ] injection vectors → static review in progress, no raw SQL found so far
