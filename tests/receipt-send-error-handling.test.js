// Verifies the receipt worker treats a Resend API error, or a response with
// no usable provider message id, as a send failure — it must NOT call
// complete_receipt_job in either case, and must fall through to the existing
// fail_receipt_job/retry path instead.
//
// Offline/pure: does not touch the database, Stripe, or Resend, and does
// not require the server to be running. Safe to run anytime.
//
// Run with: node tests/receipt-send-error-handling.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../api/server.js'), 'utf8');

// Mirrors the send-outcome validation added to the receipt worker in
// api/server.js: a Resend error, or a response with no id in either the
// flat {id} or {data:{id}} shape, is no longer swallowed as 'unknown'.
function resolveProviderMessageId(emailResult) {
  if (emailResult?.error) {
    throw new Error(`Resend error: ${emailResult.error.message || JSON.stringify(emailResult.error)}`);
  }

  const providerMessageId = emailResult?.id || emailResult?.data?.id;

  if (!providerMessageId) {
    throw new Error('Resend response missing a valid provider message id');
  }

  return providerMessageId;
}

// Mirrors the surrounding try/catch in the receipt worker: success calls
// complete_receipt_job with the resolved id; any thrown error instead calls
// fail_receipt_job and complete_receipt_job is never reached.
async function runReceiptSendAttempt(emailResult, rpc) {
  try {
    const providerMessageId = resolveProviderMessageId(emailResult);
    await rpc.complete_receipt_job(providerMessageId);
    return { outcome: 'sent', providerMessageId };
  } catch (err) {
    await rpc.fail_receipt_job();
    return { outcome: 'failed', error: err.message };
  }
}

function makeRpcSpy() {
  const calls = { complete_receipt_job: [], fail_receipt_job: [] };
  return {
    calls,
    complete_receipt_job: async (id) => { calls.complete_receipt_job.push(id); },
    fail_receipt_job: async () => { calls.fail_receipt_job.push(true); }
  };
}

function getWorkerSource() {
  const workerMatch = serverSrc.match(/RECEIPT WORKER[\s\S]*?app\.post\('\/api\/internal\/process-receipts'[\s\S]*?\n\}\);/);
  assert(workerMatch, 'Could not locate the receipt worker route in server.js');
  return workerMatch[0];
}

function test1_SourceChecksResendErrorBeforeCompleting() {
  console.log('TEST 1: worker checks emailResult.error before calling complete_receipt_job...');
  const workerSrc = getWorkerSource();

  const errorCheckIdx = workerSrc.search(/if\s*\(\s*emailResult\?\.error\s*\)/);
  const completeIdx = workerSrc.indexOf("supabase.rpc('complete_receipt_job'");

  assert(errorCheckIdx !== -1, 'Expected an `if (emailResult?.error)` guard in the receipt worker');
  assert(completeIdx !== -1, "Expected a call to supabase.rpc('complete_receipt_job', ...) in the receipt worker");
  assert(errorCheckIdx < completeIdx, 'The Resend error check must run before complete_receipt_job is called');

  console.log('  ✅ PASS');
}

function test2_SourceChecksMissingIdBeforeCompleting() {
  console.log('TEST 2: worker checks for a missing provider message id before calling complete_receipt_job...');
  const workerSrc = getWorkerSource();

  const missingIdCheckIdx = workerSrc.search(/if\s*\(\s*!providerMessageId\s*\)/);
  const completeIdx = workerSrc.indexOf("supabase.rpc('complete_receipt_job'");

  assert(missingIdCheckIdx !== -1, 'Expected an `if (!providerMessageId)` guard in the receipt worker');
  assert(completeIdx !== -1, "Expected a call to supabase.rpc('complete_receipt_job', ...) in the receipt worker");
  assert(missingIdCheckIdx < completeIdx, 'The missing-id check must run before complete_receipt_job is called');

  console.log('  ✅ PASS');
}

function test3_NoSilentUnknownFallback() {
  console.log('TEST 3: the old silent `|| \'unknown\'` fallback is gone...');
  const workerSrc = getWorkerSource();

  assert(
    !/providerMessageId\s*=\s*emailResult\?\.id\s*\|\|\s*emailResult\?\.data\?\.id\s*\|\|\s*'unknown'/.test(workerSrc),
    'A missing provider id must no longer fall back to the string \'unknown\' and proceed as success'
  );

  console.log('  ✅ PASS');
}

async function test4_SuccessfulSendCompletesJob() {
  console.log('TEST 4: successful Resend response with data.id completes the job...');
  const rpc = makeRpcSpy();

  const result = await runReceiptSendAttempt({ data: { id: 'msg_success_123' }, error: null }, rpc);

  assert.strictEqual(result.outcome, 'sent');
  assert.deepStrictEqual(rpc.calls.complete_receipt_job, ['msg_success_123']);
  assert.deepStrictEqual(rpc.calls.fail_receipt_job, []);

  console.log('  ✅ PASS');
}

async function test5_FlatIdShapeStillCompletesJob() {
  console.log('TEST 5: successful flat {id} response shape still completes the job...');
  const rpc = makeRpcSpy();

  const result = await runReceiptSendAttempt({ id: 'msg_flat_456' }, rpc);

  assert.strictEqual(result.outcome, 'sent');
  assert.deepStrictEqual(rpc.calls.complete_receipt_job, ['msg_flat_456']);
  assert.deepStrictEqual(rpc.calls.fail_receipt_job, []);

  console.log('  ✅ PASS');
}

async function test6_ResendErrorResponseFailsJobWithoutCompleting() {
  console.log('TEST 6: Resend error response fails the job and never completes it...');
  const rpc = makeRpcSpy();

  const result = await runReceiptSendAttempt(
    { data: null, error: { message: 'Invalid `to` field', name: 'validation_error' } },
    rpc
  );

  assert.strictEqual(result.outcome, 'failed');
  assert.deepStrictEqual(rpc.calls.complete_receipt_job, [], 'complete_receipt_job must NOT be called on a Resend error');
  assert.deepStrictEqual(rpc.calls.fail_receipt_job, [true]);

  console.log('  ✅ PASS');
}

async function test7_MissingIdResponseFailsJobWithoutCompleting() {
  console.log('TEST 7: response with no usable id fails the job and never completes it...');
  const rpc = makeRpcSpy();

  const result = await runReceiptSendAttempt({ data: {}, error: null }, rpc);

  assert.strictEqual(result.outcome, 'failed');
  assert.deepStrictEqual(rpc.calls.complete_receipt_job, [], 'complete_receipt_job must NOT be called when no provider id is returned');
  assert.deepStrictEqual(rpc.calls.fail_receipt_job, [true]);

  console.log('  ✅ PASS');
}

async function test8_EmptyObjectResponseFailsJobWithoutCompleting() {
  console.log('TEST 8: a completely empty/unexpected response fails the job and never completes it...');
  const rpc = makeRpcSpy();

  const result = await runReceiptSendAttempt({}, rpc);

  assert.strictEqual(result.outcome, 'failed');
  assert.deepStrictEqual(rpc.calls.complete_receipt_job, []);
  assert.deepStrictEqual(rpc.calls.fail_receipt_job, [true]);

  console.log('  ✅ PASS');
}

async function runTests() {
  console.log('📮 Receipt send error-handling tests (offline, no DB/network)\n');
  test1_SourceChecksResendErrorBeforeCompleting();
  test2_SourceChecksMissingIdBeforeCompleting();
  test3_NoSilentUnknownFallback();
  await test4_SuccessfulSendCompletesJob();
  await test5_FlatIdShapeStillCompletesJob();
  await test6_ResendErrorResponseFailsJobWithoutCompleting();
  await test7_MissingIdResponseFailsJobWithoutCompleting();
  await test8_EmptyObjectResponseFailsJobWithoutCompleting();
  console.log('\n✅ All receipt send error-handling tests passed!');
}

runTests();
