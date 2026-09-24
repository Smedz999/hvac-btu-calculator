// Offline regression tests for BLOCKER 3: distributeLead() must delegate
// primary and secondary contractor allocation entirely to the atomic
// assign_primary_lead / assign_secondary_lead RPCs (migration 006) —
// no local `credits - 1` arithmetic, and no direct `.insert()` of the
// secondary lead row from JavaScript any more (both now happen inside
// the RPC, atomically with the credit deduction and the ledger entry).
//
// This file supersedes the pre-Blocker-3 version of itself, which tested
// the old raw `.from('leads').insert(...)` + separate credit UPDATE
// pattern — that code path no longer exists in server.js.
//
// Fully offline: no HTTP requests, no sockets, no real Supabase project.
// The real server.js module is required directly and its exported
// distributeLead() is called with fake Supabase/Resend/push dependencies
// injected via its `deps` parameter — this exercises the actual
// production logic, not a reimplementation. The fake Supabase client's
// `.rpc()` implements the SAME status/return-shape contract as migration
// 006's SQL functions (see api/migrations/006-lead-credit-atomicity.sql),
// so these tests verify distributeLead()'s handling of that contract, not
// PostgreSQL itself.
//
// IMPORTANT LIMITATION: these tests cannot and do not prove PostgreSQL's
// row-locking (FOR UPDATE) is actually safe under real concurrent
// transactions — that guarantee lives entirely in the database engine and
// can only be verified with a live-database integration test. What is
// tested here is that distributeLead() (a) calls each atomic RPC exactly
// once per company instead of doing its own read-then-write, and
// (b) correctly branches notifications on the RPC's reported outcome.
//
// Run with: node tests/distribute-lead-secondary-insert.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.VERCEL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'offline-test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'offline-test-admin';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const app = require(path.join(__dirname, '../api/server.js'));
const { distributeLead } = app;
const serverSrc = fs.readFileSync(path.join(__dirname, '../api/server.js'), 'utf8');

assert.strictEqual(typeof distributeLead, 'function', 'server.js must export distributeLead on app');

function extractDistributeLeadBody() {
  const start = serverSrc.indexOf('async function distributeLead(lead, deps = {}) {');
  assert(start !== -1, 'Could not locate distributeLead() in server.js');
  const end = serverSrc.indexOf('// CRM — PROSPECTS', start);
  assert(end !== -1, 'Could not locate the end of distributeLead() (CRM — PROSPECTS section marker)');
  return serverSrc.slice(start, end);
}

// =====================
// Fake Supabase client — in-memory only. `.from()` still backs the
// eligibility/lead-count queries distributeLead() runs directly; `.rpc()`
// implements assign_primary_lead / assign_secondary_lead's status
// contract (see migration 006) entirely in JS, including the credits
// guard, the atomic "claim only if unassigned" check, and the
// (parent-or-own-id, company) uniqueness rule.
// =====================
function createFakeDb(seed, { simulateRpcErrorForCompanies = new Set(), drainCreditsBeforeRpcFor = new Set() } = {}) {
  const tables = {
    companies: seed.companies.map(c => ({ ...c })),
    leads: seed.leads.map(l => ({ ...l })),
    credit_ledger: []
  };
  const assignedPairs = new Set(); // `${originalInquiryId}:${companyId}`
  let nextLeadId = 1000;
  const rpcCalls = [];

  function originalInquiryId(row) {
    return row.parent_lead_id != null ? row.parent_lead_id : row.id;
  }

  function fromBuilder(tableName, mode, payload) {
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
      if (mode === 'select') return { data: rows().filter(matches).map(r => ({ ...r })), error: null };
      return { data: null, error: null };
    }
    const builder = {
      select() { return builder; },
      order() { return builder; },
      eq(field, value) { filters.push({ type: 'eq', field, value }); return builder; },
      gt(field, value) { filters.push({ type: 'gt', field, value }); return builder; },
      in(field, values) { filters.push({ type: 'in', field, values }); return builder; },
      not(field, op, value) { if (op === 'is' && value === null) filters.push({ type: 'not-is-null', field }); return builder; },
      then(resolve, reject) { Promise.resolve(resolveTerminal()).then(resolve, reject); }
    };
    return builder;
  }

  function assignPrimaryLead(args) {
    const company = tables.companies.find(c => c.id === args.p_company_id);
    if (!company) return { status: 'company_not_found', new_balance: null };
    // Simulates a concurrent spend that happened between the earlier
    // eligibility SELECT (which saw credits > 0) and this RPC call — the
    // RPC re-locks and re-checks the row itself, exactly as
    // assign_primary_lead's `SELECT ... FOR UPDATE` does.
    if (drainCreditsBeforeRpcFor.has(company.id)) company.credits = 0;
    if (company.credits <= 0) return { status: 'insufficient_credits', new_balance: company.credits };

    const lead = tables.leads.find(l => l.id === args.p_lead_id);
    if (!lead) return { status: 'lead_not_found', new_balance: company.credits };
    if (lead.assigned_to != null) return { status: 'already_assigned', new_balance: company.credits };

    const key = `${originalInquiryId(lead)}:${company.id}`;
    if (assignedPairs.has(key)) return { status: 'already_assigned', new_balance: company.credits };

    lead.assigned_to = company.id;
    company.credits -= 1;
    assignedPairs.add(key);
    tables.credit_ledger.push({ company_id: company.id, change_amount: -1, balance_after: company.credits, reason: 'lead_assignment', reference_id: `lead-${lead.id}` });

    return { status: 'assigned', new_balance: company.credits };
  }

  function assignSecondaryLead(args) {
    const company = tables.companies.find(c => c.id === args.p_company_id);
    if (!company) return { status: 'company_not_found', new_lead_id: null, new_balance: null };
    if (drainCreditsBeforeRpcFor.has(company.id)) company.credits = 0;
    if (company.credits <= 0) return { status: 'insufficient_credits', new_lead_id: null, new_balance: company.credits };

    const key = `${args.p_parent_lead_id}:${company.id}`;
    if (assignedPairs.has(key)) return { status: 'already_assigned', new_lead_id: null, new_balance: company.credits };

    const newLead = {
      id: `generated-${nextLeadId++}`,
      customer_name: args.p_customer_name,
      customer_email: args.p_customer_email,
      customer_phone: args.p_customer_phone,
      postcode: args.p_postcode,
      btu: args.p_btu,
      room_type: args.p_room_type,
      property_type: args.p_property_type,
      status: 'new',
      assigned_to: company.id,
      parent_lead_id: args.p_parent_lead_id
    };
    tables.leads.push(newLead);
    company.credits -= 1;
    assignedPairs.add(key);
    tables.credit_ledger.push({ company_id: company.id, change_amount: -1, balance_after: company.credits, reason: 'lead_assignment', reference_id: `lead-${newLead.id}` });

    return { status: 'assigned', new_lead_id: newLead.id, new_balance: company.credits };
  }

  return {
    from(tableName) {
      return {
        select() { return fromBuilder(tableName, 'select'); },
        update(patch) { return fromBuilder(tableName, 'update', patch); },
        insert(obj) { return fromBuilder(tableName, 'insert', obj); }
      };
    },
    rpc(name, args) {
      rpcCalls.push({ name, args });
      return {
        maybeSingle: () => Promise.resolve(new Promise(resolve => {
          if (simulateRpcErrorForCompanies.has(args.p_company_id)) {
            resolve({ data: null, error: { message: `simulated RPC-level failure calling ${name}` } });
            return;
          }
          const result = name === 'assign_primary_lead' ? assignPrimaryLead(args)
            : name === 'assign_secondary_lead' ? assignSecondaryLead(args)
            : (() => { throw new Error(`fake rpc: unknown function ${name}`); })();
          resolve({ data: result, error: null });
        }))
      };
    },
    _dump(tableName) { return tables[tableName].map(r => ({ ...r })); },
    _rpcCalls: rpcCalls
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
        parent_lead_id: null,
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
  console.log('🔒 distributeLead() atomic-RPC offline tests (BLOCKER 3)\n');

  // (a) primary successful allocation calls the atomic RPC exactly once
  await run('(a) primary allocation calls assign_primary_lead exactly once', async () => {
    const db = createFakeDb(seedFixture());
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });

    const primaryCalls = db._rpcCalls.filter(c => c.name === 'assign_primary_lead');
    assert.strictEqual(primaryCalls.length, 1);
    assert.strictEqual(primaryCalls[0].args.p_company_id, 'company-1');
    assert.strictEqual(primaryCalls[0].args.p_lead_id, 'lead-1');
  });

  // (b) secondary successful allocation calls the atomic RPC exactly once (per company)
  await run('(b) each secondary allocation calls assign_secondary_lead exactly once', async () => {
    const db = createFakeDb(seedFixture());
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });

    const secondaryCalls = db._rpcCalls.filter(c => c.name === 'assign_secondary_lead');
    assert.strictEqual(secondaryCalls.length, 2);
    assert.deepStrictEqual(secondaryCalls.map(c => c.args.p_company_id).sort(), ['company-2', 'company-3']);
    secondaryCalls.forEach(c => assert.strictEqual(c.args.p_parent_lead_id, 'lead-1'));
  });

  // (c) success causes notifications, and the credit/lead/ledger side effects are exactly right
  await run('(c) successful allocation notifies and leaves correct DB state', async () => {
    const db = createFakeDb(seedFixture());
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    const result = await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    assert.deepStrictEqual(result.sort(), ['Company One', 'Company Three', 'Company Two']);

    const companies = db._dump('companies');
    companies.forEach(c => assert.strictEqual(c.credits, 4, `${c.id} should have exactly one credit deducted`));

    const leads = db._dump('leads');
    assert.ok(leads.find(l => l.id === 'lead-1' && l.assigned_to === 'company-1'));
    assert.ok(leads.find(l => l.assigned_to === 'company-2' && l.parent_lead_id === 'lead-1'));
    assert.ok(leads.find(l => l.assigned_to === 'company-3' && l.parent_lead_id === 'lead-1'));

    const ledger = db._dump('credit_ledger');
    assert.strictEqual(ledger.length, 3);
    ledger.forEach(entry => assert.strictEqual(entry.reason, 'lead_assignment'));

    assert.strictEqual(resendClient.calls.length, 3);
    assert.strictEqual(sendPush.calls.length, 3);
  });

  // (d) RPC failure (error, not a status) causes zero notifications for that company
  await run('(d) RPC-level error for one company sends it no notification', async () => {
    const db = createFakeDb(seedFixture(), { simulateRpcErrorForCompanies: new Set(['company-2']) });
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    assert.strictEqual(resendClient.calls.some(c => c.to === 'c2@test.example'), false);
    assert.strictEqual(sendPush.calls.some(c => c.companyId === 'company-2'), false);
    assert.strictEqual(db._dump('companies').find(c => c.id === 'company-2').credits, 5, 'no credit deducted on RPC error');
    // company-3 still processed normally
    assert.ok(resendClient.calls.some(c => c.to === 'c3@test.example'));
  });

  // (e) insufficient credits (already zero at eligibility time) causes zero notifications
  await run('(e) a company already at 0 credits is never even attempted', async () => {
    const fixture = seedFixture();
    fixture.companies[1].credits = 0; // company-2 has none
    const db = createFakeDb(fixture);
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    // Correctly excluded upstream by the eligibility SELECT ... WHERE
    // credits > 0 — never even attempted, which is the stronger outcome.
    assert.strictEqual(db._rpcCalls.some(c => c.args.p_company_id === 'company-2'), false);
    assert.strictEqual(resendClient.calls.some(c => c.to === 'c2@test.example'), false);
    assert.strictEqual(db._dump('companies').find(c => c.id === 'company-2').credits, 0);
  });

  // (e2) the RPC's OWN credits guard — not just the upstream eligibility
  // filter — is what distributeLead() actually relies on: a company that
  // looked eligible (credits > 0) when the eligibility SELECT ran, but
  // whose credits a concurrent transaction already drained to 0 by the
  // time the atomic RPC executes, must still be correctly refused with
  // zero notification and zero further deduction (the RPC's own
  // `FOR UPDATE` + credits check catches exactly this).
  await run('(e2) RPC-time insufficient credits (race with eligibility read) sends no notification', async () => {
    const db = createFakeDb(seedFixture(), { drainCreditsBeforeRpcFor: new Set(['company-2']) });
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    assert.strictEqual(resendClient.calls.some(c => c.to === 'c2@test.example'), false);
    assert.strictEqual(sendPush.calls.some(c => c.companyId === 'company-2'), false);
    assert.strictEqual(db._dump('companies').find(c => c.id === 'company-2').credits, 0);
    assert.strictEqual(db._dump('leads').some(l => l.assigned_to === 'company-2'), false);
    // company-3 is unaffected by company-2's race loss
    assert.ok(resendClient.calls.some(c => c.to === 'c3@test.example'));
  });

  // (f) duplicate/already-assigned result causes zero notifications
  await run('(f) an already-assigned RPC result sends no notification', async () => {
    const db = createFakeDb(seedFixture());
    // Pre-assign company-2 to this exact parent inquiry, simulating a
    // prior successful (or concurrently-won) allocation.
    const result1 = await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });
    assert.ok(result1.includes('Company Two'));

    // Re-run distributeLead on the SAME lead id (simulating a duplicate
    // invocation) — the unique (inquiry, company) pairing must reject it.
    const resendClient2 = createFakeResend();
    const sendPush2 = createFakeSendPush();
    const leadRow = db._dump('leads').find(l => l.id === 'lead-1');
    await distributeLead(leadRow, { supabaseClient: db, resendClient: resendClient2, sendPush: sendPush2 });

    // Primary lead is already assigned, so the primary branch reports
    // 'already_assigned' and does not renotify; credits must not move
    // again for any company on this second run.
    assert.strictEqual(resendClient2.calls.length, 0);
    assert.strictEqual(sendPush2.calls.length, 0);
    const companies = db._dump('companies');
    companies.forEach(c => assert.strictEqual(c.credits, 4, `${c.id} must not be charged twice for the same inquiry`));
  });

  // (g) failure for contractor #2 does not prevent contractor #3 being attempted
  await run('(g) contractor #3 is still attempted after #2 errors', async () => {
    const db = createFakeDb(seedFixture(), { simulateRpcErrorForCompanies: new Set(['company-2']) });
    await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient: createFakeResend(), sendPush: createFakeSendPush() });

    const secondaryCalls = db._rpcCalls.filter(c => c.name === 'assign_secondary_lead');
    assert.deepStrictEqual(secondaryCalls.map(c => c.args.p_company_id).sort(), ['company-2', 'company-3']);
    assert.strictEqual(db._dump('companies').find(c => c.id === 'company-3').credits, 4);
  });

  // (h) JavaScript no longer performs local credits - 1 arithmetic in distributeLead()
  await run('(h) distributeLead() contains no local credit arithmetic', async () => {
    const body = extractDistributeLeadBody();
    assert.strictEqual(/credits\s*[:=]\s*\w+\.credits\s*-\s*1/.test(body), false,
      'distributeLead() must not compute credits - 1 in JavaScript any more');
    assert.strictEqual(/\.update\(\{\s*credits:/.test(body), false,
      'distributeLead() must not directly UPDATE companies.credits any more');
  });

  // (i) JavaScript no longer separately inserts the secondary lead before deduction
  await run('(i) distributeLead() no longer inserts the secondary lead directly', async () => {
    const body = extractDistributeLeadBody();
    assert.strictEqual(/\.from\(['"]leads['"]\)\s*\.insert\(/.test(body), false,
      'distributeLead() must not call leads.insert() directly — assign_secondary_lead does this atomically');
    assert(/rpc\(\s*['"]assign_primary_lead['"]/.test(body), 'Expected a call to assign_primary_lead');
    assert(/rpc\(\s*['"]assign_secondary_lead['"]/.test(body), 'Expected a call to assign_secondary_lead');
  });

  // (j) primary contractor flow still behaves correctly
  await run('(j) primary contractor flow: success and already-assigned both handled', async () => {
    const db = createFakeDb(seedFixture());
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    const result = await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });
    assert.ok(result.includes('Company One'));
    assert.strictEqual(resendClient.calls.filter(c => c.to === 'c1@test.example').length, 1);
    assert.strictEqual(sendPush.calls.filter(c => c.companyId === 'company-1').length, 1);
    assert.strictEqual(db._dump('leads').find(l => l.id === 'lead-1').assigned_to, 'company-1');
  });

  // single eligible contractor: primary only, no secondary RPC attempted
  await run('single eligible contractor: primary only, no secondary RPC attempted', async () => {
    const db = createFakeDb(seedFixtureSingleCompany());
    const resendClient = createFakeResend();
    const sendPush = createFakeSendPush();
    const result = await distributeLead(db._dump('leads')[0], { supabaseClient: db, resendClient, sendPush });

    assert.deepStrictEqual(result, ['Company One']);
    assert.strictEqual(db._rpcCalls.filter(c => c.name === 'assign_secondary_lead').length, 0);
    assert.strictEqual(resendClient.calls.length, 1);
    assert.strictEqual(sendPush.calls.length, 1);
  });

  // no unhandled rejection/throw escapes when every RPC call errors
  await run('no unhandled rejection/throw escapes when all RPC calls error', async () => {
    const db = createFakeDb(seedFixture(), { simulateRpcErrorForCompanies: new Set(['company-1', 'company-2', 'company-3']) });
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

    assert.strictEqual(unhandled, null);
    assert.ok(loggedErrors.some(l => l.includes('Primary lead assignment RPC error')));
    assert.ok(loggedErrors.some(l => l.includes('Secondary lead assignment RPC error')));
  });

  console.log(`\n✅ All ${passed} distributeLead() atomic-RPC tests passed!`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
