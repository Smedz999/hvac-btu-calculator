// Offline regression tests for the Stripe webhook route (server.js
// verifyStripeWebhookSignature + handleStripeWebhookEvent).
//
// Before this file, the webhook route — arguably the single most
// security-critical route in the app, since it's the ONLY authority that
// grants paid credits — had ZERO automated test coverage.
//
// Fully offline: no network calls to Stripe. Signature verification is
// tested against the REAL `stripe` npm library (not a reimplementation),
// using its own `webhooks.generateTestHeaderString` helper to produce a
// genuinely valid HMAC signature offline — this exercises the real
// crypto/verification path, not a mock of it. RPC dispatch is tested with a
// fully scripted fake Supabase client injected via the same `deps` pattern
// distributeLead() already uses — no real Supabase project involved.
//
// Run with: node tests/stripe-webhook.test.js

const assert = require('assert');
const path = require('path');

process.env.VERCEL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'offline-test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'offline-test-admin';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_offline_test_secret';
// Deliberately NOT setting STRIPE_SECRET_KEY here — server.js's module-level
// `stripe` singleton only needs to exist so verifyStripeWebhookSignature's
// default `stripeClient = stripe` isn't null; every test below constructs
// its own independent Stripe instance for signing/verifying so this never
// touches the network regardless.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_offline_dummy_key_not_real';

const Stripe = require(path.join(__dirname, '../api/node_modules/stripe'));
const app = require(path.join(__dirname, '../api/server.js'));

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripeForSigning = Stripe('sk_test_offline_dummy_key_not_real');

function makeSignedRequest(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const header = stripeForSigning.webhooks.generateTestHeaderString({
    payload: payload.toString(),
    secret: WEBHOOK_SECRET
  });
  return {
    body: payload,
    headers: { 'stripe-signature': header }
  };
}

function fakePaymentIntentSucceededEvent(id = 'pi_test_123', amount = 2500, currency = 'gbp') {
  return {
    id: 'evt_test_1',
    type: 'payment_intent.succeeded',
    data: { object: { id, amount, currency } }
  };
}

// ---------------------------------------------------------------------
// verifyStripeWebhookSignature — real stripe library, real HMAC signing
// ---------------------------------------------------------------------

function test1_ValidSignatureIsAccepted() {
  console.log('TEST 1: a correctly signed payload is accepted and parsed...');
  const event = fakePaymentIntentSucceededEvent();
  const req = makeSignedRequest(event);
  const result = app.verifyStripeWebhookSignature(req, { stripeClient: stripeForSigning });
  assert.strictEqual(result.errorStatus, undefined, 'A validly signed request must not error');
  assert(result.event, 'Expected a parsed event');
  assert.strictEqual(result.event.type, 'payment_intent.succeeded');
  console.log('  ✅ PASS');
}

function test2_InvalidSignatureIsRejected() {
  console.log('TEST 2: a tampered/invalid signature is rejected with 400...');
  const event = fakePaymentIntentSucceededEvent();
  const req = makeSignedRequest(event);
  req.headers['stripe-signature'] = 't=1234567890,v1=0000000000000000000000000000000000000000000000000000000000000000';
  const result = app.verifyStripeWebhookSignature(req, { stripeClient: stripeForSigning });
  assert.strictEqual(result.errorStatus, 400);
  assert.strictEqual(result.errorBody.error, 'Invalid signature');
  console.log('  ✅ PASS');
}

function test3_MissingSignatureHeaderIsRejected() {
  console.log('TEST 3: a missing stripe-signature header is rejected with 400...');
  const event = fakePaymentIntentSucceededEvent();
  const req = makeSignedRequest(event);
  delete req.headers['stripe-signature'];
  const result = app.verifyStripeWebhookSignature(req, { stripeClient: stripeForSigning });
  assert.strictEqual(result.errorStatus, 400);
  console.log('  ✅ PASS');
}

function test4_WrongSecretIsRejected() {
  console.log('TEST 4: a payload signed with the WRONG secret is rejected (simulates a forged webhook)...');
  const payload = Buffer.from(JSON.stringify(fakePaymentIntentSucceededEvent()), 'utf8');
  const header = stripeForSigning.webhooks.generateTestHeaderString({
    payload: payload.toString(),
    secret: 'whsec_a_completely_different_secret'
  });
  const req = { body: payload, headers: { 'stripe-signature': header } };
  const result = app.verifyStripeWebhookSignature(req, { stripeClient: stripeForSigning });
  assert.strictEqual(result.errorStatus, 400);
  console.log('  ✅ PASS');
}

function test5_MalformedPayloadIsRejected() {
  console.log('TEST 5: a malformed (non-JSON) payload with an otherwise-valid-looking signature is rejected...');
  // Sign one payload but send a different (corrupted) body — the signature
  // won't match the actual bytes received, exactly like a MITM/corruption
  // scenario or someone hand-crafting a request.
  const signedPayload = Buffer.from(JSON.stringify(fakePaymentIntentSucceededEvent()), 'utf8');
  const header = stripeForSigning.webhooks.generateTestHeaderString({
    payload: signedPayload.toString(),
    secret: WEBHOOK_SECRET
  });
  const req = { body: Buffer.from('{"not":"the signed payload"}'), headers: { 'stripe-signature': header } };
  const result = app.verifyStripeWebhookSignature(req, { stripeClient: stripeForSigning });
  assert.strictEqual(result.errorStatus, 400);
  console.log('  ✅ PASS');
}

function test6_StripeNotConfiguredReturns503() {
  console.log('TEST 6: no Stripe client configured returns 503, never attempts verification...');
  const req = makeSignedRequest(fakePaymentIntentSucceededEvent());
  const result = app.verifyStripeWebhookSignature(req, { stripeClient: null });
  assert.strictEqual(result.errorStatus, 503);
  console.log('  ✅ PASS');
}

function test7_MissingWebhookSecretReturns500() {
  console.log('TEST 7: STRIPE_WEBHOOK_SECRET unset returns 500, never attempts verification...');
  const req = makeSignedRequest(fakePaymentIntentSucceededEvent());
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const result = app.verifyStripeWebhookSignature(req, { stripeClient: stripeForSigning });
    assert.strictEqual(result.errorStatus, 500);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
  console.log('  ✅ PASS');
}

// ---------------------------------------------------------------------
// handleStripeWebhookEvent — fake Supabase client, every RPC branch
// ---------------------------------------------------------------------

function fakeSupabase({ processResult, processError, cancelError } = {}) {
  const calls = [];
  return {
    calls,
    rpc(fnName, args) {
      calls.push({ fnName, args });
      if (fnName === 'process_stripe_payment_atomic') {
        return {
          single: async () => ({
            data: processError ? null : (processResult || { already_processed: false, credits_added: 5, balance_after: 10 }),
            error: processError || null
          })
        };
      }
      if (fnName === 'cancel_processing_reservation') {
        return { single: async () => ({ data: cancelError ? null : { cancelled: true }, error: cancelError || null }) };
      }
      throw new Error(`Unexpected RPC in test: ${fnName}`);
    }
  };
}

async function test8_SuccessfulPaymentCreditsExactlyOnce() {
  console.log('TEST 8: payment_intent.succeeded calls process_stripe_payment_atomic exactly once and returns 200...');
  const supabaseClient = fakeSupabase({ processResult: { already_processed: false, credits_added: 15, balance_after: 20 } });
  const result = await app.handleStripeWebhookEvent(fakePaymentIntentSucceededEvent('pi_1'), { supabaseClient });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.received, true);
  const rpcCalls = supabaseClient.calls.filter(c => c.fnName === 'process_stripe_payment_atomic');
  assert.strictEqual(rpcCalls.length, 1, 'process_stripe_payment_atomic must be called exactly once');
  assert.strictEqual(rpcCalls[0].args.p_stripe_payment_intent_id, 'pi_1');
  console.log('  ✅ PASS');
}

async function test9_DuplicateWebhookDeliveryIsIdempotent() {
  console.log('TEST 9: a duplicate/replayed webhook for an already-processed PaymentIntent is idempotent (200, no error)...');
  const supabaseClient = fakeSupabase({ processResult: { already_processed: true, credits_added: 0, balance_after: 20 } });
  const result = await app.handleStripeWebhookEvent(fakePaymentIntentSucceededEvent('pi_1'), { supabaseClient });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.received, true);
  assert.strictEqual(result.body.error, undefined, 'An already-processed replay must not surface as an error to Stripe');
  console.log('  ✅ PASS');
}

async function test10_UnknownPaymentIntentAcksSoStripeDoesNotRetryForever() {
  console.log('TEST 10: "not found" RPC error (no matching reservation) still 200-acks so Stripe stops retrying a permanent failure...');
  const supabaseClient = fakeSupabase({ processError: { message: 'Reservation not found for PaymentIntent pi_ghost' } });
  const result = await app.handleStripeWebhookEvent(fakePaymentIntentSucceededEvent('pi_ghost'), { supabaseClient });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.received, true);
  assert(result.body.error.includes('not found'));
  console.log('  ✅ PASS');
}

async function test11_OtherRpcFailureReturns500SoStripeRetries() {
  console.log('TEST 11: any OTHER RPC failure (e.g. invalid state transition) returns 500 so Stripe retries...');
  const supabaseClient = fakeSupabase({ processError: { message: 'Invalid state for payment processing' } });
  const result = await app.handleStripeWebhookEvent(fakePaymentIntentSucceededEvent('pi_2'), { supabaseClient });
  assert.strictEqual(result.status, 500);
  console.log('  ✅ PASS');
}

async function test12_UnexpectedThrowDuringProcessingReturns500() {
  console.log('TEST 12: an unexpected exception during RPC dispatch returns 500, never crashes the handler...');
  const supabaseClient = {
    rpc() { throw new Error('simulated network blip'); }
  };
  const result = await app.handleStripeWebhookEvent(fakePaymentIntentSucceededEvent('pi_3'), { supabaseClient });
  assert.strictEqual(result.status, 500);
  console.log('  ✅ PASS');
}

async function test13_CanceledPaymentIntentCancelsReservation() {
  console.log('TEST 13: payment_intent.canceled calls cancel_processing_reservation exactly once...');
  const supabaseClient = fakeSupabase();
  const event = { id: 'evt_2', type: 'payment_intent.canceled', data: { object: { id: 'pi_4' } } };
  const result = await app.handleStripeWebhookEvent(event, { supabaseClient });
  assert.strictEqual(result.status, 200);
  const cancelCalls = supabaseClient.calls.filter(c => c.fnName === 'cancel_processing_reservation');
  assert.strictEqual(cancelCalls.length, 1);
  assert.strictEqual(cancelCalls[0].args.p_stripe_payment_intent_id, 'pi_4');
  console.log('  ✅ PASS');
}

async function test14_CancelRpcFailureStillAcks200() {
  console.log('TEST 14: cancel_processing_reservation failing still returns 200 (logged, not surfaced as an error to Stripe)...');
  const supabaseClient = fakeSupabase({ cancelError: { message: 'reservation already succeeded' } });
  const event = { id: 'evt_3', type: 'payment_intent.canceled', data: { object: { id: 'pi_5' } } };
  const result = await app.handleStripeWebhookEvent(event, { supabaseClient });
  assert.strictEqual(result.status, 200);
  console.log('  ✅ PASS');
}

async function test15_PaymentFailedNeverTouchesCreditsOrReservation() {
  console.log('TEST 15: payment_intent.payment_failed makes NO RPC calls (reservation stays untouched for retry)...');
  const supabaseClient = fakeSupabase();
  const event = { id: 'evt_4', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_6' } } };
  const result = await app.handleStripeWebhookEvent(event, { supabaseClient });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(supabaseClient.calls.length, 0, 'payment_intent.payment_failed must not call any RPC');
  console.log('  ✅ PASS');
}

async function test16_UnrecognizedEventTypeIsAcknowledgedHarmlessly() {
  console.log('TEST 16: an event type the handler does not recognize is 200-acked without touching any RPC...');
  const supabaseClient = fakeSupabase();
  const event = { id: 'evt_5', type: 'charge.refunded', data: { object: {} } };
  const result = await app.handleStripeWebhookEvent(event, { supabaseClient });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.received, true);
  assert.strictEqual(supabaseClient.calls.length, 0);
  console.log('  ✅ PASS');
}

async function test17_AmountAndCurrencyAreForwardedFromStripeNotClient() {
  console.log('TEST 17: amount/currency passed to the RPC come from the verified Stripe event, matching what Stripe actually charged...');
  const supabaseClient = fakeSupabase();
  const event = fakePaymentIntentSucceededEvent('pi_7', 4999, 'gbp');
  await app.handleStripeWebhookEvent(event, { supabaseClient });
  const call = supabaseClient.calls.find(c => c.fnName === 'process_stripe_payment_atomic');
  assert.strictEqual(call.args.p_stripe_amount_pence, 4999);
  assert.strictEqual(call.args.p_stripe_currency, 'gbp');
  console.log('  ✅ PASS');
}

async function runTests() {
  console.log('💳 Stripe webhook offline tests (real stripe-library signature verification + fake Supabase RPC dispatch)\n');
  test1_ValidSignatureIsAccepted();
  test2_InvalidSignatureIsRejected();
  test3_MissingSignatureHeaderIsRejected();
  test4_WrongSecretIsRejected();
  test5_MalformedPayloadIsRejected();
  test6_StripeNotConfiguredReturns503();
  test7_MissingWebhookSecretReturns500();
  await test8_SuccessfulPaymentCreditsExactlyOnce();
  await test9_DuplicateWebhookDeliveryIsIdempotent();
  await test10_UnknownPaymentIntentAcksSoStripeDoesNotRetryForever();
  await test11_OtherRpcFailureReturns500SoStripeRetries();
  await test12_UnexpectedThrowDuringProcessingReturns500();
  await test13_CanceledPaymentIntentCancelsReservation();
  await test14_CancelRpcFailureStillAcks200();
  await test15_PaymentFailedNeverTouchesCreditsOrReservation();
  await test16_UnrecognizedEventTypeIsAcknowledgedHarmlessly();
  await test17_AmountAndCurrencyAreForwardedFromStripeNotClient();
  console.log('\n✅ All 17 Stripe webhook tests passed!');
}

runTests();
