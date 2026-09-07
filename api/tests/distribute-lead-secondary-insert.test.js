// Offline regression tests for BLOCKER 2: the secondary-contractor
// (#2/#3) loop inside distributeLead() must attempt the child lead
// INSERT first and only deduct credit / notify if it actually succeeded,
// so a failed insert (e.g. today's missing parent_lead_id column) can
// never charge a contractor for a lead they'll never see.
//
// Fully offline: no HTTP requests, no sockets, no real Supabase project.
// The real server.js module is required directly and its exported
// distributeLead() is called with fake Supabase/Resend/push dependencies
// injected via its `deps` parameter — this exercises the actual
// production logic, not a reimplementation.
//
// Run with: node api/tests/distribute-lead-secondary-insert.test.js

const assert = require('assert');
const path = require('path');

// Same isolation approach as lead-authorization.test.js: VERCEL=1 avoids
// app.listen(), dummy secrets avoid touching real config, and dotenv never
// overwrites variables that are already set.
process.env.VERCEL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'offline-test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'offline-test-admin';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const app = require(path.join(__dirname, '../server.js'));
const { distributeLead } = app;

assert.strictEqual(typeof distributeLead, 'function', 'server.js must export distributeLead on app');

// =====================
// Fake Supabase client — in-memory only. Supports exactly the chains used
// by distributeLead(): .select/.gt/.in/.not/.eq/.order (awaitable
// directly), and .update/.insert chained with .eq/.select/.maybeSingle.
// `failLeadsInsertTimes` makes the Nth-and-earlier attempted inserts into
// 'leads' resolve with a Postgrest-shaped error instead of writing a row,
// simulating today's missing-column failure without touching any schema.
// =====================
function createFakeDb(seed, { failLeadsInsertTimes = 0 } = {}) {
  const tables = {
    companies: seed.companies.map(c => ({ ...c })),
    leads: seed.leads.map(l => ({ ...l }))
  };
  let leadsInsertAttempts = 0;
  let nextGeneratedId = 1000;

  function makeBuilder(tableName, mode, payload) {
    const filters = [];

    function rows() { return tables[tableName]; }

    function matches(row) {
      return filters.every(f => {
        if (f.type === 'eq') return String(row[f.field]) === String(f.value);
        if (f.type === 'gt') return Number(row[f.field]) > Number(f.value);
        if (f.type === 'in') return f.values.map(String).includes(String(row[f.field]));
        if (f.type === 'not-is-null') return row[f.field] !== null && row[f.field] !== undefined;
        return true;
      });
    }

    function resolveTerminal() {
      if (mode === 'insert') {
        leadsInsertAttempts++;
        if (tableName === 'leads' && leadsInsertAttempts <= failLeadsInsertTimes) {
          return { data: null, error: { message: 'column "parent_lead_id" of relation "leads" does not exist' } };
        }
        const row = { id: `generated-${nextGeneratedId++}`, ...payload };
        rows().push(row);
        return { data: { ...row }, error: null };
      }
      if (mode === 'update') {
        const matched = rows().filter(matches);
        matched.forEach(r => Object.assign(r, payload));
        return { data: null, error: null };
      }
      // select
      return { data: rows().filter(matches).map(r => ({ ...r })), error: null };
    }

    const builder = {
      select() { return builder; },
      order() { return builder; },
      eq(field, value) { filters.push({ type: 'eq', field, value }); return builder; },
      gt(field, value) { filters.push({ type: 'gt', field, value }); return builder; },
      in(field, values) { filters.push({ type: 'in', field, values }); return builder; },
      not(field, op, value) {
        if (op === 'is' && value === null) filters.push({ type: 'not-is-null', field });
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(resolveTerminal());
      },
      // Makes `await query` work directly for calls that never chain
      // .maybeSingle()/.single() as a terminal step (matches real
      // supabase-js: the query builder itself is thenable).
      then(resolve, reject) {
        Promise.resolve(resolveTerminal()).then(resolve, reject);
      }
    };
    return builder;
  }

  return {
    from(tableName) {
      return {
        select() { return makeBuilder(tableName, 'select'); },
        update(patch) { return makeBuilder(tableName, 'update', patch); },
        insert(obj) { return makeBuilder(tableName, 'insert', obj); }
      };
    },
    _dump(tableName) { return tables[tableName].map(r => ({ ...r })); }
  };
}

function createFakeResend() {
  const calls = [];
  return { calls, emails: { send: async (opts) => { calls.push(opts); return { data: { id: 'fake-email-id' }, error: null }; } } };
}

function createFakeSendPush() {
  const calls = [];
  const fn = async (companyId, payload) => { calls.push({ companyId, payload }); return { success: true }; };
  fn.calls = calls;
  return fn;
}

function seedFixture() {
  return {
    companies: [
      { id: 'company-1', company: 'Company One', email: 'c1@test.example', postcode: 'SK1 1AA', credits: 5 },
      { id: 'company-2', company: 'Company Two', email: 'c2@test.example', postcode: 'SK1 1AA', credits: 5 },
      { id: 'company-3', company: 'Company Three', email: 'c3@test.example', postcode: 'SK1 1AA', credits: 5 }
    ],
    leads: [
      {
        id: 'lead-1',
        assigned_to: null,
        customer_name: 'Test Customer',
        customer_email: 'customer@test.example',
        customer_phone: '07700900000',
        postcode: 'SK1 1AA',
        btu: 9000,
        room_type: 'lounge',
        property_type: 'house',
        status: 'new'
      }
    ]
  };
}

// Only one eligible contractor — the secondary loop (i = 1..selected.length)
// never executes at all, since selected.length === 1.
function seedFixtureSingleCompany() {
  const fixture = seedFixture();
  fixture.companies = fixture.companies.slice(0, 1);
  return fixture;
}

let passed = 0;
async function run(name, fn) {
  await fn();
  passed++;
  console.log(`  ✅ PASS — ${name}`);
}

async function main() {
  console.log('🔒 distributeLead() secondary-insert offline tests (BLOCKER 2)\n');

  // (a) secondary insert success creates row with correct parent_lead_id
  await run('(a) successful secondary insert has correct parent_lead_id', async () => {
    const db = createFakeDb(seedFixture());
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    const leads = db._dump('leads');
    const child2 = leads.find(l => l.assigned_to === 'company-2');
    const child3 = leads.find(l => l.assigned_to === 'company-3');
    assert.ok(child2, 'expected a lead row created for company-2');
    assert.ok(child3, 'expected a lead row created for company-3');
    assert.strictEqual(child2.parent_lead_id, 'lead-1');
    assert.strictEqual(child3.parent_lead_id, 'lead-1');
  });

  // (b) successful secondary insert causes exactly one credit deduction
  await run('(b) successful secondary insert deducts exactly one credit', async () => {
    const db = createFakeDb(seedFixture());
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });

    const companies = db._dump('companies');
    assert.strictEqual(companies.find(c => c.id === 'company-2').credits, 4);
    assert.strictEqual(companies.find(c => c.id === 'company-3').credits, 4);
  });

  // (c) successful secondary insert causes notification calls
  await run('(c) successful secondary insert sends email and push', async () => {
    const db = createFakeDb(seedFixture());
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    assert.ok(resendClient.calls.some(c => c.to === 'c2@test.example'));
    assert.ok(resendClient.calls.some(c => c.to === 'c3@test.example'));
    assert.ok(sendPush.calls.some(c => c.companyId === 'company-2'));
    assert.ok(sendPush.calls.some(c => c.companyId === 'company-3'));
  });

  // (d) failed secondary insert causes zero credit deduction
  await run('(d) failed secondary insert deducts zero credit for that company', async () => {
    const db = createFakeDb(seedFixture(), { failLeadsInsertTimes: 1 }); // company-2's insert fails
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });

    const companies = db._dump('companies');
    assert.strictEqual(companies.find(c => c.id === 'company-2').credits, 5, 'company-2 credit must be untouched');
    assert.strictEqual(companies.find(c => c.id === 'company-3').credits, 4, 'company-3 (unaffected) still gets its lead');
  });

  // (e) failed secondary insert causes zero notifications
  await run('(e) failed secondary insert sends no email/push to that company', async () => {
    const db = createFakeDb(seedFixture(), { failLeadsInsertTimes: 1 }); // company-2's insert fails
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    assert.strictEqual(resendClient.calls.some(c => c.to === 'c2@test.example'), false);
    assert.strictEqual(sendPush.calls.some(c => c.companyId === 'company-2'), false);
    // company-3 must still be notified normally
    assert.ok(resendClient.calls.some(c => c.to === 'c3@test.example'));
    assert.ok(sendPush.calls.some(c => c.companyId === 'company-3'));
  });

  // (f) failure for contractor #2 does not prevent contractor #3 being attempted
  await run('(f) contractor #3 is still attempted after #2 fails', async () => {
    const db = createFakeDb(seedFixture(), { failLeadsInsertTimes: 1 });
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });

    const leads = db._dump('leads');
    const child3 = leads.find(l => l.assigned_to === 'company-3');
    assert.ok(child3, 'company-3 must still receive a lead row despite company-2 failing');
    assert.strictEqual(child3.parent_lead_id, 'lead-1');
    assert.strictEqual(db._dump('companies').find(c => c.id === 'company-3').credits, 4);
  });

  // (g) primary contractor behavior remains unaffected, even when both secondaries fail
  await run('(g) primary contractor (#1) is unaffected by secondary failures', async () => {
    const db = createFakeDb(seedFixture(), { failLeadsInsertTimes: 2 }); // both #2 and #3 fail
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    const companies = db._dump('companies');
    assert.strictEqual(companies.find(c => c.id === 'company-1').credits, 4, 'primary credit deduction still happens exactly once');
    const primaryLead = db._dump('leads').find(l => l.id === 'lead-1');
    assert.strictEqual(primaryLead.assigned_to, 'company-1');
    assert.strictEqual(resendClient.calls.filter(c => c.to === 'c1@test.example').length, 1);
    assert.strictEqual(sendPush.calls.filter(c => c.companyId === 'company-1').length, 1);
  });

  // (h) no unhandled rejection/throw escapes from a simulated secondary insert error
  await run('(h) a failing secondary insert never throws or rejects distributeLead()', async () => {
    const db = createFakeDb(seedFixture(), { failLeadsInsertTimes: 2 });
    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);

    const originalError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args.join(' '));

    try {
      await assert.doesNotReject(() =>
        distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() })
      );
    } finally {
      console.error = originalError;
      process.removeListener('unhandledRejection', onUnhandled);
    }

    assert.strictEqual(unhandled, null, 'no unhandled rejection should occur');
    assert.ok(
      loggedErrors.some(l => l.includes('Secondary lead insert failed')),
      'the failure should be logged safely via console.error, not swallowed without a trace'
    );
  });

  // (i) exactly one eligible contractor: primary path works normally and
  // the secondary loop is never entered — no insert is attempted at all.
  await run('(i) single eligible contractor: primary only, no secondary insert attempted', async () => {
    const db = createFakeDb(seedFixtureSingleCompany());
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    const originalError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args.join(' '));

    let result;
    try {
      result = await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });
    } finally {
      console.error = originalError;
    }

    assert.deepStrictEqual(result, ['Company One']);

    const companies = db._dump('companies');
    assert.strictEqual(companies.length, 1, 'no company-2/company-3 exist in this fixture');
    assert.strictEqual(companies[0].credits, 4, 'primary credit deduction still happens exactly once');

    const leads = db._dump('leads');
    assert.strictEqual(leads.length, 1, 'no secondary lead row should have been created');
    assert.strictEqual(leads[0].assigned_to, 'company-1');
    assert.strictEqual('parent_lead_id' in leads[0], false, 'the primary lead itself must never get a parent_lead_id');

    assert.strictEqual(resendClient.calls.length, 1);
    assert.strictEqual(sendPush.calls.length, 1);
    assert.strictEqual(
      loggedErrors.some(l => l.includes('Secondary lead insert failed')),
      false,
      'the secondary-insert error path must never be reached when there is only one eligible company'
    );
  });

  console.log(`\n✅ All ${passed} distributeLead() secondary-insert tests passed!`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
