// Verifies the receipt-processing endpoint's dual-auth setup (admin JWT for
// manual triggering, CRON_SECRET for the external GitHub Actions scheduler)
// and the stale-job reclaim wiring, plus the shape of migration 004.
//
// Offline/pure: does not touch the database, Stripe, Resend, or CRON_SECRET
// itself, and does not require the server to be running. Safe to run anytime.
//
// Run with: node tests/receipt-cron-auth.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../api/server.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(__dirname, '../api/auth.js'), 'utf8');
const migrationSrc = fs.readFileSync(
  path.join(__dirname, '../api/migrations/004-receipt-job-reclaim.sql'),
  'utf8'
);

function test1_GetRouteUsesCronSecret() {
  console.log('TEST 1: GET /api/internal/process-receipts is guarded by requireCronSecret...');
  assert(
    /app\.get\(\s*'\/api\/internal\/process-receipts'\s*,\s*requireCronSecret\s*,/.test(serverSrc),
    'Expected app.get(\'/api/internal/process-receipts\', requireCronSecret, ...) in server.js'
  );
  console.log('  ✅ PASS');
}

function test2_PostRouteStillUsesAdmin() {
  console.log('TEST 2: POST /api/internal/process-receipts is still guarded by requireAdmin...');
  assert(
    /app\.post\(\s*'\/api\/internal\/process-receipts'\s*,\s*requireAdmin\s*,/.test(serverSrc),
    'Expected app.post(\'/api/internal/process-receipts\', requireAdmin, ...) in server.js'
  );
  console.log('  ✅ PASS');
}

function test3_BothRoutesShareSameHandler() {
  console.log('TEST 3: GET and POST routes both dispatch to processReceiptJobs...');
  assert(
    /app\.post\(\s*'\/api\/internal\/process-receipts'\s*,\s*requireAdmin\s*,\s*processReceiptJobs\s*\)/.test(serverSrc),
    'Expected POST route to call processReceiptJobs'
  );
  assert(
    /app\.get\(\s*'\/api\/internal\/process-receipts'\s*,\s*requireCronSecret\s*,\s*processReceiptJobs\s*\)/.test(serverSrc),
    'Expected GET route to call processReceiptJobs'
  );
  console.log('  ✅ PASS');
}

function test4_ReclaimCalledBeforeClaimLoop() {
  console.log('TEST 4: reclaim_stale_receipt_jobs is called before the claim loop...');
  const handlerMatch = serverSrc.match(/async function processReceiptJobs[\s\S]*?\r?\n}\r?\n/);
  assert(handlerMatch, 'Could not locate processReceiptJobs handler in server.js');
  const handlerSrc = handlerMatch[0];

  const reclaimIdx = handlerSrc.indexOf("supabase.rpc('reclaim_stale_receipt_jobs')");
  const claimIdx = handlerSrc.indexOf("supabase.rpc('claim_receipt_job')");
  assert(reclaimIdx !== -1, 'Expected a call to supabase.rpc(\'reclaim_stale_receipt_jobs\')');
  assert(claimIdx !== -1, 'Expected a call to supabase.rpc(\'claim_receipt_job\')');
  assert(reclaimIdx < claimIdx, 'reclaim_stale_receipt_jobs must run before claim_receipt_job');
  console.log('  ✅ PASS');
}

function test5_IdempotencyKeyStillPresent() {
  console.log('TEST 5: receipt idempotency key is unchanged...');
  assert(
    /resend\.emails\.send\(\{[\s\S]*?\},\s*\{\s*idempotencyKey:\s*`receipt\/\$\{job\.reservation_id\}`\s*\}\)/.test(serverSrc),
    'Expected resend.emails.send({...}, { idempotencyKey: `receipt/${job.reservation_id}` }) to remain unchanged'
  );
  console.log('  ✅ PASS');
}

function test6_CronSecretMiddlewareIsConstantTimeAndFailsClosed() {
  console.log('TEST 6: requireCronSecret fails closed and uses a timing-safe comparison...');
  const fnMatch = authSrc.match(/function requireCronSecret[\s\S]*?\r?\n}\r?\n/);
  assert(fnMatch, 'Could not locate requireCronSecret in auth.js');
  const fnSrc = fnMatch[0];

  assert(/if\s*\(\s*!secret\s*\)/.test(fnSrc), 'Expected requireCronSecret to fail closed when CRON_SECRET is unset');
  assert(/crypto\.timingSafeEqual/.test(fnSrc), 'Expected requireCronSecret to use crypto.timingSafeEqual');
  assert(/requireCronSecret/.test(authSrc.split('module.exports')[1] || ''), 'Expected requireCronSecret to be exported');
  console.log('  ✅ PASS');
}

function test7_MigrationDefinesReclaimFunction() {
  console.log('TEST 7: migration 004 defines reclaim_stale_receipt_jobs with correct semantics...');
  assert(
    /CREATE OR REPLACE FUNCTION reclaim_stale_receipt_jobs\(\)/.test(migrationSrc),
    'Expected CREATE OR REPLACE FUNCTION reclaim_stale_receipt_jobs()'
  );
  assert(
    /WHERE status = 'processing'/.test(migrationSrc),
    'Expected the reclaim query to filter on status = \'processing\''
  );
  assert(
    /last_attempt_at < NOW\(\) - INTERVAL '10 minutes'/.test(migrationSrc),
    'Expected a 10 minute staleness threshold on last_attempt_at'
  );
  assert(
    /CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END/.test(migrationSrc),
    'Expected attempts >= 5 to route to failed, otherwise pending'
  );
  console.log('  ✅ PASS');
}

function test8_MigrationDoesNotTouchSentOrPaymentTables() {
  console.log('TEST 8: migration 004 never modifies sent jobs or payment/purchase/credit tables...');
  assert(
    !/status = 'sent'/.test(migrationSrc.replace(/--.*$/gm, '')),
    'Migration must not reference sent rows as a write target'
  );
  const forbiddenTables = ['payment_reservations', 'purchases', 'credit_ledger', 'companies'];
  for (const table of forbiddenTables) {
    assert(
      !new RegExp(`UPDATE\\s+(public\\.)?${table}\\b`, 'i').test(migrationSrc),
      `Migration must not UPDATE ${table}`
    );
  }
  console.log('  ✅ PASS');
}

function test9_MigrationGrantsServiceRoleOnlyAndRevokesOthers() {
  console.log('TEST 9: migration 004 grants EXECUTE to service_role only...');
  assert(
    /GRANT EXECUTE ON FUNCTION reclaim_stale_receipt_jobs\(\) TO service_role/.test(migrationSrc),
    'Expected GRANT EXECUTE ... TO service_role'
  );
  for (const role of ['anon', 'authenticated', 'PUBLIC']) {
    assert(
      new RegExp(`REVOKE EXECUTE ON FUNCTION reclaim_stale_receipt_jobs\\(\\) FROM ${role}`).test(migrationSrc),
      `Expected REVOKE EXECUTE ... FROM ${role}`
    );
  }
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔐 Receipt cron-auth & reclaim tests (offline, no DB/network)\n');
  test1_GetRouteUsesCronSecret();
  test2_PostRouteStillUsesAdmin();
  test3_BothRoutesShareSameHandler();
  test4_ReclaimCalledBeforeClaimLoop();
  test5_IdempotencyKeyStillPresent();
  test6_CronSecretMiddlewareIsConstantTimeAndFailsClosed();
  test7_MigrationDefinesReclaimFunction();
  test8_MigrationDoesNotTouchSentOrPaymentTables();
  test9_MigrationGrantsServiceRoleOnlyAndRevokesOthers();
  console.log('\n✅ All receipt cron-auth & reclaim tests passed!');
}

runTests();
