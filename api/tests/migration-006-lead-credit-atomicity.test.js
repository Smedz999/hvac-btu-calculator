// Static regression coverage for api/migrations/006-lead-credit-atomicity.sql
// — the migration BLOCKER 3 depends on (see the distributeLead()
// atomic-RPC tests), which is NOT applied by this test or any other code
// in this repo.
//
// Offline/pure: does not touch the database, does not require the server
// to be running, and does not apply the migration — it only reads the
// .sql files' raw text and asserts on their shape, following the same
// convention as api/tests/receipt-cron-auth.test.js (tests 7-9) and
// api/tests/migration-005-parent-lead-id.test.js.
//
// Run with: node api/tests/migration-006-lead-credit-atomicity.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationSrc = fs.readFileSync(
  path.join(__dirname, '../migrations/006-lead-credit-atomicity.sql'),
  'utf8'
);
const migration003Src = fs.readFileSync(
  path.join(__dirname, '../migrations/003-payment-reservation-architecture.sql'),
  'utf8'
);
const migration004Src = fs.readFileSync(
  path.join(__dirname, '../migrations/004-receipt-job-reclaim.sql'),
  'utf8'
);

function extractFunctionBody(src, functionName) {
  const start = src.indexOf(`FUNCTION ${functionName}(`);
  assert(start !== -1, `Could not locate FUNCTION ${functionName} in migration source`);
  const end = src.indexOf('\n$$;', start);
  assert(end !== -1, `Could not locate the end (\\n$$;) of FUNCTION ${functionName}`);
  return src.slice(start, end);
}

function test1_BothFunctionsLockCompanyRowForUpdate() {
  console.log('TEST 1: both functions lock the company row with FOR UPDATE...');
  const primary = extractFunctionBody(migrationSrc, 'assign_primary_lead');
  const secondary = extractFunctionBody(migrationSrc, 'assign_secondary_lead');
  for (const [name, body] of [['assign_primary_lead', primary], ['assign_secondary_lead', secondary]]) {
    assert(
      /SELECT credits INTO v_current_credits\s*\r?\n\s*FROM public\.companies\s*\r?\n\s*WHERE id = p_company_id\s*\r?\n\s*FOR UPDATE;/.test(body),
      `Expected ${name} to lock the company row with SELECT ... FOR UPDATE`
    );
  }
  console.log('  ✅ PASS');
}

function test2_BothFunctionsGuardCreditsGreaterThanZero() {
  console.log('TEST 2: both functions guard on credits > 0 before any write...');
  const primary = extractFunctionBody(migrationSrc, 'assign_primary_lead');
  const secondary = extractFunctionBody(migrationSrc, 'assign_secondary_lead');
  for (const [name, body] of [['assign_primary_lead', primary], ['assign_secondary_lead', secondary]]) {
    assert(
      /IF v_current_credits <= 0 THEN\s*\r?\n\s*RETURN QUERY SELECT 'insufficient_credits'/.test(body),
      `Expected ${name} to return 'insufficient_credits' when v_current_credits <= 0`
    );
  }
  console.log('  ✅ PASS');
}

function test3_NoNegativeCreditPath() {
  console.log('TEST 3: credits are only ever written via the pre-guarded v_new_balance variable...');
  const primary = extractFunctionBody(migrationSrc, 'assign_primary_lead');
  const secondary = extractFunctionBody(migrationSrc, 'assign_secondary_lead');
  for (const [name, body] of [['assign_primary_lead', primary], ['assign_secondary_lead', secondary]]) {
    // The only place credits is ever set is `credits = v_new_balance`,
    // which is computed as `v_current_credits - 1` strictly AFTER the
    // `credits <= 0` guard above has already returned early — so credits
    // can never be written to a negative value from either function.
    assert(
      /UPDATE public\.companies\s*\r?\n\s*SET credits = v_new_balance/.test(body),
      `Expected ${name} to write credits only via the guarded v_new_balance variable`
    );
    assert(
      !/SET\s+credits\s*=\s*credits\s*-/.test(body),
      `${name} must not decrement credits with inline arithmetic that bypasses the guard`
    );
  }
  console.log('  ✅ PASS');
}

function test4_AtomicUpdateOrInsertBehavior() {
  console.log('TEST 4: primary claims via guarded UPDATE, secondary inserts the child row...');
  const primary = extractFunctionBody(migrationSrc, 'assign_primary_lead');
  assert(
    /UPDATE public\.leads\s*\r?\n\s*SET assigned_to = p_company_id, updated_at = NOW\(\)\s*\r?\n\s*WHERE id = p_lead_id AND assigned_to IS NULL;/.test(primary),
    'Expected assign_primary_lead to claim the lead only WHERE assigned_to IS NULL'
  );
  assert(
    /GET DIAGNOSTICS v_rows = ROW_COUNT;\s*\r?\n\s*IF v_rows = 0 THEN\s*\r?\n\s*RETURN QUERY SELECT 'already_assigned'/.test(primary),
    'Expected assign_primary_lead to check ROW_COUNT and report already_assigned on a lost race'
  );

  const secondary = extractFunctionBody(migrationSrc, 'assign_secondary_lead');
  assert(
    /INSERT INTO public\.leads \(/.test(secondary) && /assigned_to, parent_lead_id/.test(secondary),
    'Expected assign_secondary_lead to INSERT a new leads row with assigned_to and parent_lead_id'
  );
  console.log('  ✅ PASS');
}

function test5_LedgerInsertPresentAndCorrectlyLabelled() {
  console.log('TEST 5: both functions write a credit_ledger row labelled lead_assignment...');
  const primary = extractFunctionBody(migrationSrc, 'assign_primary_lead');
  const secondary = extractFunctionBody(migrationSrc, 'assign_secondary_lead');
  for (const [name, body] of [['assign_primary_lead', primary], ['assign_secondary_lead', secondary]]) {
    assert(
      /INSERT INTO public\.credit_ledger \(/.test(body),
      `Expected ${name} to INSERT INTO public.credit_ledger`
    );
    assert(
      /'lead_assignment'/.test(body),
      `Expected ${name} to label its ledger entry 'lead_assignment'`
    );
    assert(
      !/'admin-'/.test(body),
      `${name} must not reuse admin_adjust_credits' 'admin-' reference_id convention`
    );
  }
  console.log('  ✅ PASS');
}

function test6_DuplicateAllocationProtection() {
  console.log('TEST 6: duplicate (inquiry, company) allocation is rejected at the DB level...');
  assert(
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique_company_per_inquiry\s*\r?\n\s*ON public\.leads \(COALESCE\(parent_lead_id, id\), assigned_to\)\s*\r?\n\s*WHERE assigned_to IS NOT NULL;/.test(migrationSrc),
    'Expected a unique index on (COALESCE(parent_lead_id, id), assigned_to) WHERE assigned_to IS NOT NULL'
  );
  const secondary = extractFunctionBody(migrationSrc, 'assign_secondary_lead');
  assert(
    /EXCEPTION WHEN unique_violation THEN\s*\r?\n[\s\S]*?RETURN QUERY SELECT 'already_assigned'/.test(secondary),
    'Expected assign_secondary_lead to catch unique_violation and report already_assigned'
  );
  console.log('  ✅ PASS');
}

function test7_SecurityDefinerSearchPathAndGrants() {
  console.log('TEST 7: SECURITY DEFINER, pinned search_path, and service_role-only grants...');
  const functionSignatures = [
    'assign_primary_lead(BIGINT, BIGINT)',
    'assign_secondary_lead(BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT)'
  ];
  assert(
    (migrationSrc.match(/SECURITY DEFINER/g) || []).length === 2,
    'Expected exactly two SECURITY DEFINER declarations (one per function)'
  );
  assert(
    (migrationSrc.match(/SET search_path = public, pg_temp/g) || []).length === 2,
    'Expected exactly two SET search_path = public, pg_temp declarations (one per function)'
  );
  for (const sig of functionSignatures) {
    assert(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${sig.replace(/[()]/g, '\\$&')} TO service_role;`).test(migrationSrc),
      `Expected GRANT EXECUTE ... ${sig} ... TO service_role`
    );
    for (const role of ['anon', 'authenticated', 'PUBLIC']) {
      assert(
        new RegExp(`REVOKE EXECUTE ON FUNCTION ${sig.replace(/[()]/g, '\\$&')} FROM ${role};`).test(migrationSrc),
        `Expected REVOKE EXECUTE ... ${sig} ... FROM ${role}`
      );
    }
  }
  console.log('  ✅ PASS');
}

function test8_DoesNotModifyExistingPaymentAdminFunctionsOrMigrations() {
  console.log('TEST 8: existing payment/admin RPCs and migrations 003/004 are untouched...');
  // Migration 006 must not attempt to (re)define any existing function.
  const existingFunctionNames = [
    'admin_adjust_credits', 'process_stripe_payment_atomic', 'create_payment_reservation',
    'attach_stripe_payment_intent', 'expire_pending_reservation', 'cancel_processing_reservation',
    'claim_receipt_job', 'complete_receipt_job', 'fail_receipt_job', 'reclaim_stale_receipt_jobs'
  ];
  for (const fn of existingFunctionNames) {
    assert(
      !new RegExp(`FUNCTION ${fn}\\(`).test(migrationSrc),
      `Migration 006 must not define or replace ${fn} — that belongs to 003/004`
    );
  }

  // The known, load-bearing bodies of the two closest existing functions
  // must still be present verbatim in their own migration files (a cheap
  // proxy for "untouched" without needing a stored file hash baseline).
  assert(
    /CREATE OR REPLACE FUNCTION admin_adjust_credits\(/.test(migration003Src),
    'admin_adjust_credits must still be defined, unmodified, in migration 003'
  );
  assert(
    /RAISE EXCEPTION 'Insufficient credits: current %, delta %, would result in %', v_current_credits, p_delta, v_new_balance;/.test(migration003Src),
    'admin_adjust_credits\' negative-balance guard must be byte-identical to before'
  );
  assert(
    /CREATE OR REPLACE FUNCTION process_stripe_payment_atomic\(/.test(migration003Src),
    'process_stripe_payment_atomic must still be defined, unmodified, in migration 003'
  );
  assert(
    /CREATE OR REPLACE FUNCTION reclaim_stale_receipt_jobs\(\)/.test(migration004Src),
    'reclaim_stale_receipt_jobs must still be defined, unmodified, in migration 004'
  );
  console.log('  ✅ PASS');
}

function test9_DoesNotModifyUnrelatedTablesOrExistingRowData() {
  console.log('TEST 9: migration only adds new functions/index, never writes existing rows...');
  const withoutComments = migrationSrc.replace(/--.*$/gm, '');
  const dataModifyingPatterns = [
    { label: 'UPDATE ... SET (outside a function body)', pattern: /^\s*UPDATE\s+\S+\s+SET\b/im },
    { label: 'DELETE FROM', pattern: /\bDELETE\s+FROM\b/i },
    { label: 'TRUNCATE', pattern: /\bTRUNCATE\b/i },
    { label: 'ALTER TABLE', pattern: /\bALTER TABLE\b/i }
  ];
  // UPDATE is expected INSIDE the function bodies (that's the atomic
  // write itself) — what must never appear is a bare top-level UPDATE
  // statement outside of a function, which would mutate existing rows as
  // part of just loading this migration.
  const topLevelSrc = withoutComments
    .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g, '');
  for (const { label, pattern } of dataModifyingPatterns) {
    assert(!pattern.test(topLevelSrc), `Migration must not ${label} outside of a function body`);
  }
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🗄️  Migration 006 (lead credit atomicity) static shape tests (offline, not applied)\n');
  test1_BothFunctionsLockCompanyRowForUpdate();
  test2_BothFunctionsGuardCreditsGreaterThanZero();
  test3_NoNegativeCreditPath();
  test4_AtomicUpdateOrInsertBehavior();
  test5_LedgerInsertPresentAndCorrectlyLabelled();
  test6_DuplicateAllocationProtection();
  test7_SecurityDefinerSearchPathAndGrants();
  test8_DoesNotModifyExistingPaymentAdminFunctionsOrMigrations();
  test9_DoesNotModifyUnrelatedTablesOrExistingRowData();
  console.log('\n✅ All migration 006 shape tests passed!');
}

runTests();
