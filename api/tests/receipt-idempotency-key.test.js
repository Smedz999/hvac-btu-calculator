// Verifies the receipt worker passes a deterministic Resend idempotency key
// (receipt/<reservation_id>) so a retried send for the same job cannot
// result in a duplicate email at the provider.
//
// Offline/pure: does not touch the database, Stripe, or Resend, and does
// not require the server to be running. Safe to run anytime.
//
// Run with: node api/tests/receipt-idempotency-key.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Mirrors the expression added to the receipt worker in api/server.js.
function buildIdempotencyKey(job) {
  return `receipt/${job.reservation_id}`;
}

function test1_SourceContainsIdempotencyKey() {
  console.log('TEST 1: receipt worker passes a deterministic idempotencyKey to resend.emails.send...');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  const workerMatch = source.match(/RECEIPT WORKER[\s\S]*?app\.post\('\/api\/internal\/process-receipts'[\s\S]*?\n\}\);/);
  assert(workerMatch, 'Could not locate the receipt worker route in server.js');
  const workerSrc = workerMatch[0];

  assert(
    /resend\.emails\.send\(\{[\s\S]*?\},\s*\{\s*idempotencyKey:\s*`receipt\/\$\{job\.reservation_id\}`\s*\}\)/.test(workerSrc),
    'Expected resend.emails.send({...}, { idempotencyKey: `receipt/${job.reservation_id}` }) in the receipt worker'
  );

  console.log('  ✅ PASS');
}

function test2_SameJobSameKeyOnRetry() {
  console.log('TEST 2: same reservation_id yields the same key on retry...');
  const job = { reservation_id: '11111111-1111-1111-1111-111111111111' };

  const firstAttemptKey = buildIdempotencyKey(job);
  const retryAttemptKey = buildIdempotencyKey(job); // simulates a retried send for the same job

  assert.strictEqual(firstAttemptKey, retryAttemptKey, 'Key must be identical across retries of the same job');
  assert.strictEqual(firstAttemptKey, `receipt/${job.reservation_id}`);

  console.log('  ✅ PASS');
}

function test3_DifferentJobsDifferentKeys() {
  console.log('TEST 3: different reservation_id values yield different keys...');
  const jobA = { reservation_id: '11111111-1111-1111-1111-111111111111' };
  const jobB = { reservation_id: '22222222-2222-2222-2222-222222222222' };

  assert.notStrictEqual(buildIdempotencyKey(jobA), buildIdempotencyKey(jobB));

  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🧾 Receipt idempotency-key tests (offline, no DB/network)\n');
  test1_SourceContainsIdempotencyKey();
  test2_SameJobSameKeyOnRetry();
  test3_DifferentJobsDifferentKeys();
  console.log('\n✅ All receipt idempotency-key tests passed!');
}

runTests();
