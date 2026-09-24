// Offline regression tests for createLead() in server.js: required-field
// validation and duplicate-submission protection on POST /api/leads.
//
// Before this file: (a) the route accepted a lead with no customerName,
// customerEmail, or postcode at all (they'd simply be inserted as
// null/undefined), and (b) there was NO protection against a double-click,
// browser retry, or network retry creating two identical leads — each of
// which would independently notify contractors and consume a credit for
// what is really one enquiry.
//
// Fully offline: no HTTP requests, no real Supabase project. The real
// server.js module is required directly and its exported createLead() is
// called with a small in-memory fake Supabase client and a fake
// `distribute` function injected via its `deps` parameter — this exercises
// the actual production logic, not a reimplementation.
//
// Run with: node tests/lead-submission.test.js

const assert = require('assert');
const path = require('path');

process.env.VERCEL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'offline-test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'offline-test-admin';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const app = require(path.join(__dirname, '../api/server.js'));

// A minimal fake Supabase query builder covering exactly the chain
// createLead() uses: .from('leads').select('*').eq(...).eq(...).gte(...)
// .order(...).limit(...).maybeSingle() for the duplicate check, and
// .from('leads').insert(...).select().single() for creation.
function fakeSupabase({ existingLeads = [], insertShouldError = null } = {}) {
  const inserted = [];
  return {
    inserted,
    from(table) {
      assert.strictEqual(table, 'leads');
      const filters = {};
      const builder = {
        select() { return builder; },
        eq(field, value) { filters[field] = value; return builder; },
        gte(field, value) { filters[`${field}__gte`] = value; return builder; },
        order() { return builder; },
        limit() { return builder; },
        async maybeSingle() {
          const match = existingLeads.find(l =>
            l.customer_email === filters.customer_email &&
            l.postcode === filters.postcode &&
            l.created_at >= filters['created_at__gte']
          );
          return { data: match || null, error: null };
        },
        insert(row) {
          return {
            select() {
              return {
                async single() {
                  if (insertShouldError) return { data: null, error: insertShouldError };
                  const created = { id: 'new-lead-1', created_at: new Date().toISOString(), ...row };
                  inserted.push(created);
                  return { data: created, error: null };
                }
              };
            }
          };
        }
      };
      return builder;
    }
  };
}

function fakeDistribute() {
  const calls = [];
  const fn = async (lead) => { calls.push(lead); return ['Acme Air Con']; };
  fn.calls = calls;
  return fn;
}

async function test1_MissingAllRequiredFieldsIsRejected() {
  console.log('TEST 1: missing customerName/customerEmail/postcode is rejected with 400...');
  const result = await app.createLead({}, { supabaseClient: fakeSupabase() });
  assert.strictEqual(result.status, 400);
  assert(result.body.error.includes('customerName'));
  assert(result.body.error.includes('customerEmail'));
  assert(result.body.error.includes('postcode'));
  console.log('  ✅ PASS');
}

async function test2_MissingEmailOnlyIsRejected() {
  console.log('TEST 2: missing only customerEmail is rejected, naming just that field...');
  const result = await app.createLead(
    { customerName: 'Jo Bloggs', postcode: 'SW1A 1AA' },
    { supabaseClient: fakeSupabase() }
  );
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.body.error, 'Missing required fields: customerEmail');
  console.log('  ✅ PASS');
}

async function test3_MalformedEmailIsRejected() {
  console.log('TEST 3: a malformed email address is rejected...');
  const result = await app.createLead(
    { customerName: 'Jo Bloggs', customerEmail: 'not-an-email', postcode: 'SW1A 1AA' },
    { supabaseClient: fakeSupabase() }
  );
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.body.error, 'Invalid email address');
  console.log('  ✅ PASS');
}

async function test4_WhitespaceOnlyFieldsAreRejected() {
  console.log('TEST 4: whitespace-only customerName is rejected (not treated as present)...');
  const result = await app.createLead(
    { customerName: '   ', customerEmail: 'jo@example.com', postcode: 'SW1A 1AA' },
    { supabaseClient: fakeSupabase() }
  );
  assert.strictEqual(result.status, 400);
  assert(result.body.error.includes('customerName'));
  console.log('  ✅ PASS');
}

async function test5_ValidSubmissionCreatesLeadAndDistributes() {
  console.log('TEST 5: a valid, non-duplicate submission creates the lead and distributes it exactly once...');
  const supabaseClient = fakeSupabase();
  const distribute = fakeDistribute();
  const result = await app.createLead(
    { customerName: 'Jo Bloggs', customerEmail: 'Jo@Example.com', postcode: 'sw1a 1aa', btu: 9000 },
    { supabaseClient, distribute }
  );
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.success, true);
  assert.strictEqual(result.body.duplicate, undefined);
  assert.strictEqual(supabaseClient.inserted.length, 1, 'exactly one lead must be inserted');
  assert.strictEqual(supabaseClient.inserted[0].customer_email, 'jo@example.com', 'email is normalized to lowercase');
  assert.strictEqual(supabaseClient.inserted[0].postcode, 'SW1A 1AA', 'postcode is normalized to uppercase');
  assert.strictEqual(distribute.calls.length, 1, 'distribute must be called exactly once');
  console.log('  ✅ PASS');
}

async function test6_DuplicateWithinWindowIsIdempotentNoSecondInsertNoRedistribution() {
  console.log('TEST 6: an identical submission within the duplicate window returns the existing lead — no second insert, no re-distribution...');
  const nowMs = Date.now();
  const existingLead = {
    id: 'existing-1',
    customer_email: 'jo@example.com',
    postcode: 'SW1A 1AA',
    created_at: new Date(nowMs - 30 * 1000).toISOString() // 30s ago
  };
  const supabaseClient = fakeSupabase({ existingLeads: [existingLead] });
  const distribute = fakeDistribute();
  const result = await app.createLead(
    { customerName: 'Jo Bloggs', customerEmail: 'jo@example.com', postcode: 'SW1A 1AA' },
    { supabaseClient, distribute, now: () => nowMs }
  );
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.duplicate, true);
  assert.strictEqual(result.body.lead.id, 'existing-1');
  assert.strictEqual(supabaseClient.inserted.length, 0, 'must not insert a second lead');
  assert.strictEqual(distribute.calls.length, 0, 'must not re-distribute (would double-notify contractors / double-spend a credit)');
  console.log('  ✅ PASS');
}

async function test7_SameCustomerDifferentPostcodeIsNotTreatedAsDuplicate() {
  console.log('TEST 7: the same customer submitting a genuinely different postcode is NOT blocked...');
  const nowMs = Date.now();
  const existingLead = {
    id: 'existing-2',
    customer_email: 'jo@example.com',
    postcode: 'SW1A 1AA',
    created_at: new Date(nowMs - 10 * 1000).toISOString()
  };
  const supabaseClient = fakeSupabase({ existingLeads: [existingLead] });
  const distribute = fakeDistribute();
  const result = await app.createLead(
    { customerName: 'Jo Bloggs', customerEmail: 'jo@example.com', postcode: 'E1 6AN' },
    { supabaseClient, distribute, now: () => nowMs }
  );
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.duplicate, undefined);
  assert.strictEqual(supabaseClient.inserted.length, 1);
  console.log('  ✅ PASS');
}

async function test8_SubmissionAfterWindowExpiresIsTreatedAsNew() {
  console.log('TEST 8: an identical submission AFTER the duplicate window has passed is treated as a new enquiry...');
  const nowMs = Date.now();
  const oldLead = {
    id: 'existing-3',
    customer_email: 'jo@example.com',
    postcode: 'SW1A 1AA',
    created_at: new Date(nowMs - 10 * 60 * 1000).toISOString() // 10 minutes ago, outside the 5-minute window
  };
  const supabaseClient = fakeSupabase({ existingLeads: [oldLead] });
  const distribute = fakeDistribute();
  const result = await app.createLead(
    { customerName: 'Jo Bloggs', customerEmail: 'jo@example.com', postcode: 'SW1A 1AA' },
    { supabaseClient, distribute, now: () => nowMs }
  );
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.duplicate, undefined, 'a genuinely new enquiry outside the window must not be blocked');
  assert.strictEqual(supabaseClient.inserted.length, 1);
  assert.strictEqual(distribute.calls.length, 1);
  console.log('  ✅ PASS');
}

async function test9_InsertErrorPropagatesAsFailure() {
  console.log('TEST 9: a database error on insert propagates (surfaces as 500 at the route level, not silently swallowed)...');
  const supabaseClient = fakeSupabase({ insertShouldError: { message: 'simulated DB error' } });
  let threw = false;
  try {
    await app.createLead(
      { customerName: 'Jo Bloggs', customerEmail: 'jo@example.com', postcode: 'SW1A 1AA' },
      { supabaseClient, distribute: fakeDistribute() }
    );
  } catch (err) {
    threw = true;
    assert.strictEqual(err.message, 'simulated DB error');
  }
  assert(threw, 'createLead must throw so the route handler returns 500, not silently succeed');
  console.log('  ✅ PASS');
}

async function runTests() {
  console.log('📝 Lead submission validation & duplicate-protection offline tests\n');
  await test1_MissingAllRequiredFieldsIsRejected();
  await test2_MissingEmailOnlyIsRejected();
  await test3_MalformedEmailIsRejected();
  await test4_WhitespaceOnlyFieldsAreRejected();
  await test5_ValidSubmissionCreatesLeadAndDistributes();
  await test6_DuplicateWithinWindowIsIdempotentNoSecondInsertNoRedistribution();
  await test7_SameCustomerDifferentPostcodeIsNotTreatedAsDuplicate();
  await test8_SubmissionAfterWindowExpiresIsTreatedAsNew();
  await test9_InsertErrorPropagatesAsFailure();
  console.log('\n✅ All 9 lead submission tests passed!');
}

runTests();
