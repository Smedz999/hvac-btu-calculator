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
- [x] contractor cannot access admin functions (auth-middleware.test.js test 3)
- [ ] forged IDs (numeric company id guessing / IDOR on /api/companies/:id) — still open, no direct test
- [x] malformed authentication (garbage JWT, `alg:none`, expired token, malformed header) — auth-middleware.test.js tests 5, 8, 9
- [x] privilege escalation (tampered `role` claim, wrong secret) — auth-middleware.test.js tests 6, 7
- [ ] admin login timing/behavior (correct vs wrong password; ADMIN_PASSWORD unset) — still open, no direct test

## Homeowner / Lead Submission
- [x] normal homeowner submission (lead-submission.test.js test 5)
- [ ] calculator → quote journey (frontend, manual/browser pass) — not run in a real browser this session, only static JS review + syntax check
- [x] required field validation — **fixed**: createLead() now requires
      customerName/customerEmail(format-checked)/postcode. lead-submission.test.js tests 1-4
- [ ] malformed input (XSS-ish strings, huge payloads, wrong types for btu) — still open
- [x] postcode formatting (lowercase/uppercase normalization) — lead-submission.test.js test 5
- [x] duplicate submission (identical payload twice) — **fixed**: 5-minute window
      idempotent dedup. lead-submission.test.js tests 6-8. Residual DB-race limitation documented in ACCONNX-PROGRESS.md
- [x] rapid double-click — backend dedup above + frontend submit-button disable guard (index.html)
- [~] network/request retry idempotency — covered for the "arrives as two HTTP requests"
      case by the same dedup window; NOT covered for a request that the server fully
      processed but whose response never reached the client (client can't know either way) — inherent to at-most-once HTTP semantics, not something more test coverage fixes
- [x] no eligible contractor → lead stays unassigned, no crash (distributeLead returns [] — covered by existing distribute-lead-secondary-insert.test.js error-path cases)
- [x] one eligible contractor → primary only, no secondary attempted (distribute-lead-secondary-insert.test.js "single eligible contractor")
- [ ] multiple eligible contractors → top 3 selected, fairness sort — RPC *dispatch* is covered; the eligibility filter + sort function itself still has no DIRECT isolated unit test (still open)

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
- [x] client-side credit manipulation blocked (credit-and-price-security.test.js tests 1, 7)
- [x] direct API credit manipulation via `/api/admin/adjust-credits` without admin JWT (credit-and-price-security.test.js test 6 confirms the route requires requireAdmin; auth-middleware.test.js proves requireAdmin itself cannot be bypassed)
- [x] non-numeric/zero delta rejected at the route (credit-and-price-security.test.js test 6). Whether a negative delta can drive a balance below zero is a DB-level guarantee — BLOCKED, needs live Postgres
- [ ] forged company IDs in adjust-credits body — still open (route trusts body.companyId; whether the RPC validates existence needs a live-DB check or a static SQL read of admin_adjust_credits, which migration 003 doesn't fully show — not yet done)
- [ ] repeated/replayed adjust-credits requests — still open; lower risk since this is admin-triggered, not client-facing
- [B] concurrent adjust-credits requests (needs real Postgres)

## Stripe / Payment System
- [ ] package catalogue served correctly end-to-end — still open (getPackage() itself has a static test — credit-and-price-security.test.js test 8 — but no test of the full create-payment-intent happy path, which needs a live DB for the reservation RPC)
- [B] first-purchase discount vs subsequent normal price at the DB level — BLOCKED without live Postgres
- [ ] invalid package id → 400, no reservation created — still open (needs live DB for create_payment_reservation's own validation, or a mock of that RPC — not yet written)
- [x] manipulated client price is structurally impossible (credit-and-price-security.test.js tests 3, 5 — route never reads amount/price from the client, PaymentIntent amount always comes from the DB reservation)
- [x] manipulated company ID is structurally impossible (credit-and-price-security.test.js test 4 — companyId always from req.user.id)
- [B] reservation creation/expiry under real DB triggers/cron — BLOCKED
- [x] successful/idempotent/failed/cancelled payment lifecycle **at the Node route layer** — stripe-webhook.test.js tests 8-15 (the RPC's own DB-side atomicity is BLOCKED without live Postgres)
- [x] webhook handler unit tests: valid/invalid/missing/wrong-secret/malformed signature, duplicate delivery, unknown PaymentIntent, other RPC failure, unexpected exception, cancellation, payment_failed, unrecognized event type — stripe-webhook.test.js, 17 tests, real `stripe` library signature verification
- [B] concurrency/race at DB level — BLOCKED
- [x] credits issued exactly once at the route-dispatch level (stripe-webhook.test.js test 8-9); the DB-level guarantee itself (idempotency key = PaymentIntent id) is BLOCKED for live proof, static shape confirmed via migration 006's tests

## Stripe Webhook Security — DONE (previously the single biggest coverage gap; see stripe-webhook.test.js, 17 tests)
- [x] valid signature → processed (test 1)
- [x] invalid signature → 400 (test 2)
- [x] missing signature header → 400 (test 3)
- [x] wrong secret (forged webhook) → 400 (test 4)
- [x] malformed/corrupted payload → 400 (test 5)
- [x] Stripe not configured → 503, webhook secret unset → 500, never attempts verification (tests 6-7)
- [x] duplicate event / replay → idempotent, no error surfaced (test 9)
- [x] unknown PaymentIntent (`error.message.includes('not found')`) → 200 ack, no throw (test 10)
- [x] any other RPC error → 500 so Stripe retries (test 11)
- [x] unexpected exception during dispatch → 500, never crashes (test 12)
- [x] cancellation cancels the reservation exactly once (test 13); cancel-RPC failure still 200-acks (test 14)
- [x] payment_failed makes no RPC calls at all (test 15)
- [x] unrecognized event type is acknowledged harmlessly (test 16)
- [x] amount/currency forwarded to the RPC come from the verified Stripe event (test 17)

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
- [ ] company visibility (GET /api/companies requires admin) — requireAdmin itself is now thoroughly tested (auth-middleware.test.js); a route-specific test wiring that to this exact endpoint is still open
- [x] lead visibility (admin sees all) — lead-authorization.test.js case j
- [ ] purchase visibility (GET /api/admin/purchases requires admin) — still open (same reasoning as company visibility above)
- [ ] authorized credit adjustment happy path — still open, needs live DB or a mocked RPC
- [x] unauthorized credit adjustment (contractor JWT on admin route) — auth-middleware.test.js test 3 + credit-and-price-security.test.js test 6 together cover this
- [x] contractor/admin separation — auth-middleware.test.js tests 2-3
- [x] forged admin requests (tampered role claim, wrong secret, alg:none) — auth-middleware.test.js tests 6, 7, 9

## Database / Security (static analysis, since no live DB)
- [x] RLS enabled + intentionally policy-free for anon/authenticated (confirmed correct — see progress log)
- [x] `prevent_invalid_transitions()` missing SECURITY DEFINER + search_path pinning — **fixed** via local migration 007, static regression test added
- [B] Actual RLS status of `leads`/`prospects`/`tasks`/`password_reset_codes` (predate migrations 001/002, not in repo, not verifiable without DB access — flagged as a production action item for the user)
- [x] no Supabase keys embedded client-side (confirmed via grep)
- [x] SQL injection exposure — full re-read of server.js complete; every query uses the
      Supabase JS query builder (parameterized) or RPC calls with typed parameters, no
      raw string-built SQL anywhere in the file
- [x] atomic RPCs — confirmed for leads/payments/credits: `/api/admin/adjust-credits`
      only ever calls the RPC (credit-and-price-security.test.js test 7); PUT
      /api/companies/:id unconditionally strips `credits` (test 1)
- [x] dependency vulnerabilities — `npm audit` run against `api/`, 3 moderate `qs`
      findings fixed via `npm audit fix`, now 0 vulnerabilities

## Frontend
- [x] calculator/Get 3 Quotes JS — read in full; inline `<script>` blocks syntax-checked with `node --check`. **Not** loaded in an actual browser this session (no browser automation was run) — treat as a static-code pass, not a live UI pass
- [x] client-side validation — reviewed (HTML `required` + `type="email"` on the lead form; server now double-validates)
- [x] double-click behaviour — **fixed**: submit button now disables + shows a loading state during the request
- [x] loading/error/success states — **improved**: added a loading state; a 4xx now shows the specific error via toast instead of destroying the form; success/network-failure states were already reasonable
- [ ] mobile/responsive layout — not visually checked (would need a real browser)
- [ ] obvious console/runtime errors — not checked (would need a real browser)

## Adversarial (Phase 4) — mapped onto the sections above; tracked once as "attack" framing:
- [x] obtain another contractor's customer details → lead-authorization.test.js. IDOR via numeric ID guessing on OTHER routes (e.g. /api/companies/:id) not systematically swept — still open
- [x] obtain leads without credits → distribute-lead-secondary-insert.test.js (e)/(e2)
- [x] alter another contractor's lead → lead-authorization.test.js case d
- [x] increase credits via any route other than admin RPC → credit-and-price-security.test.js tests 1, 7
- [ ] avoid credit deduction via a malformed lead payload → still open
- [x] manipulate package prices → credit-and-price-security.test.js tests 3, 5 (structurally impossible — route never reads a price from the client)
- [B] obtain first-purchase discount repeatedly → DB-level unique index guarantee, BLOCKED for live proof, static shape confirmed (migration 006 tests)
- [x] replay Stripe events → stripe-webhook.test.js tests 9, 16
- [x] generate credits twice → stripe-webhook.test.js test 9 (idempotent replay) + migration 006 static guarantee
- [x] duplicate leads → lead-submission.test.js tests 6-8
- [x] exploit simultaneous requests → covered at the JS/route level for leads (lead-submission.test.js) and webhook (stripe-webhook.test.js); genuine DB-level race proof BLOCKED
- [x] bypass admin authorization → auth-middleware.test.js (forged/tampered/wrong-role tokens all rejected)
- [x] manipulate company IDs → credit-and-price-security.test.js test 4 (JWT-derived id only, body ignored)
- [ ] access protected API endpoints without auth → requireAuth/requireAdmin themselves are thoroughly tested; a systematic sweep confirming every single route actually has one of them attached is still open (manual code read during this session found no obviously-unprotected route, but this wasn't turned into an automated test)
- [x] exploit malformed input on lead submission → lead-submission.test.js tests 1-4; NOT yet done for other routes (registration, admin routes)
- [x] injection vectors → full source re-read found no raw string-built SQL; all DB access via the parameterized query builder or typed RPC parameters
