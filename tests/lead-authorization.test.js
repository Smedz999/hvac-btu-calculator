// Offline regression tests for BLOCKER 1: contractor authorization on the
// lead GET/PUT routes (getLeadsForUser / updateLeadForUser in server.js).
//
// Fully offline: no HTTP requests, no sockets, no real Supabase project.
// The real server.js module is required directly and its two exported
// authorization functions are called with a small in-memory fake Supabase
// client — this exercises the actual production logic, not a reimplementation.
//
// Run with: node tests/lead-authorization.test.js

const assert = require('assert');
const path = require('path');

// Prevent server.js from starting a real listener or touching a real
// Supabase project when required as a module:
//  - VERCEL=1 makes server.js export `app` instead of calling app.listen().
//  - JWT_SECRET/ADMIN_PASSWORD are required by api/auth.js at load time
//    (it process.exit(1)s if missing) but are never exercised by these
//    tests, which call getLeadsForUser/updateLeadForUser directly.
//  - SUPABASE_URL/SUPABASE_SERVICE_KEY are set to obvious dummy values;
//    server.js's module-level Supabase client is never queried by these
//    tests because a fake client is passed explicitly to every call.
// dotenv.config() (called inside server.js) never overwrites variables
// that are already set, so these values are guaranteed to win even if
// api/.env also defines them.
process.env.VERCEL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'offline-test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'offline-test-admin';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const app = require(path.join(__dirname, '../api/server.js'));
const { getLeadsForUser, updateLeadForUser } = app;

assert.strictEqual(typeof getLeadsForUser, 'function', 'server.js must export getLeadsForUser on app');
assert.strictEqual(typeof updateLeadForUser, 'function', 'server.js must export updateLeadForUser on app');

// =====================
// Fake Supabase client — in-memory only, supports exactly the chains used
// by getLeadsForUser/updateLeadForUser (.select/.order/.eq/.update/.maybeSingle
// plus direct await on a select chain). No network, no disk, no real client.
// =====================
function createFakeSupabase(seedLeads) {
  let rows = seedLeads.map(r => ({ ...r }));

  function makeBuilder() {
    const filters = [];
    let pendingUpdate = null;

    function applyFilters(source) {
      return source.filter(row => filters.every(([field, value]) => String(row[field]) === String(value)));
    }

    const builder = {
      select() { return builder; },
      order() { return builder; },
      eq(field, value) { filters.push([field, value]); return builder; },
      update(patch) { pendingUpdate = patch; return builder; },
      maybeSingle() {
        const matches = applyFilters(rows);
        if (pendingUpdate) {
          matches.forEach(row => Object.assign(row, pendingUpdate));
        }
        return Promise.resolve({ data: matches[0] ? { ...matches[0] } : null, error: null });
      },
      // Makes `await query` work directly for the GET path, which never
      // calls .select()/.maybeSingle() as a terminal step.
      then(resolve, reject) {
        const matches = applyFilters(rows).map(r => ({ ...r }));
        Promise.resolve({ data: matches, error: null }).then(resolve, reject);
      }
    };
    return builder;
  }

  return {
    from(table) {
      assert.strictEqual(table, 'leads', 'fake only models the leads table');
      return makeBuilder();
    },
    _dump() { return rows.map(r => ({ ...r })); }
  };
}

function seedFixture() {
  return createFakeSupabase([
    {
      id: 'lead-1',
      assigned_to: 'company-A',
      customer_name: 'Alice Customer',
      customer_email: 'alice@customer.example',
      postcode: 'SK1 1AA',
      btu: 10000,
      status: 'new'
    },
    {
      id: 'lead-2',
      assigned_to: 'company-B',
      customer_name: 'Bob Customer',
      customer_email: 'bob@customer.example',
      postcode: 'OL1 1AA',
      btu: 8000,
      status: 'new'
    }
  ]);
}

let passed = 0;
async function run(name, fn) {
  await fn();
  passed++;
  console.log(`  ✅ PASS — ${name}`);
}

async function main() {
  console.log('🔒 Lead authorization offline tests (BLOCKER 1)\n');

  // (a) contractor A sees only their own leads
  await run('(a) contractor sees only their own leads', async () => {
    const db = seedFixture();
    const result = await getLeadsForUser({ role: 'contractor', id: 'company-A' }, undefined, db);
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].id, 'lead-1');
  });

  // (b) contractor B cannot see contractor A's leads
  await run('(b) contractor B cannot see contractor A leads', async () => {
    const db = seedFixture();
    const result = await getLeadsForUser({ role: 'contractor', id: 'company-B' }, undefined, db);
    assert.strictEqual(result.data.some(l => l.id === 'lead-1'), false);
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].id, 'lead-2');
  });

  // (c) companyId query tampering cannot bypass ownership
  await run('(c) companyId query param cannot be used to read another company', async () => {
    const db = seedFixture();
    const result = await getLeadsForUser({ role: 'contractor', id: 'company-B' }, 'company-A', db);
    assert.strictEqual(result.data.some(l => l.id === 'lead-1'), false,
      'company-B must not see company-A leads even when passing companyId=company-A');
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].assigned_to, 'company-B');
  });

  // (d) contractor cannot update another contractor's lead
  await run('(d) contractor cannot update another contractor\'s lead', async () => {
    const db = seedFixture();
    const result = await updateLeadForUser({ role: 'contractor', id: 'company-B' }, 'lead-1', { status: 'won' }, db);
    assert.strictEqual(result.data, null);
    assert.strictEqual(result.error, null);
    const stored = db._dump().find(l => l.id === 'lead-1');
    assert.strictEqual(stored.status, 'new', 'lead-1 status must be unchanged');
  });

  // (e) contractor can update their own status
  await run('(e) contractor can update their own lead status', async () => {
    const db = seedFixture();
    const result = await updateLeadForUser({ role: 'contractor', id: 'company-A' }, 'lead-1', { status: 'contacted' }, db);
    assert.strictEqual(result.error, null);
    assert.ok(result.data);
    assert.strictEqual(result.data.status, 'contacted');
  });

  // (f) contractor can only change status — other fields in the body are ignored
  await run('(f) contractor update ignores non-status fields', async () => {
    const db = seedFixture();
    await updateLeadForUser(
      { role: 'contractor', id: 'company-A' },
      'lead-1',
      { status: 'won', customer_email: 'attacker@evil.example', postcode: 'ZZ99 9ZZ', btu: 1 },
      db
    );
    const stored = db._dump().find(l => l.id === 'lead-1');
    assert.strictEqual(stored.status, 'won');
    assert.strictEqual(stored.customer_email, 'alice@customer.example', 'customer_email must be unchanged');
    assert.strictEqual(stored.postcode, 'SK1 1AA', 'postcode must be unchanged');
    assert.strictEqual(stored.btu, 10000, 'btu must be unchanged');
  });

  // (g) assigned_to / credits cannot be changed by a contractor
  await run('(g) contractor cannot reassign a lead or touch credits', async () => {
    const db = seedFixture();
    await updateLeadForUser(
      { role: 'contractor', id: 'company-A' },
      'lead-1',
      { status: 'won', assigned_to: 'company-B', credits: 999 },
      db
    );
    const stored = db._dump().find(l => l.id === 'lead-1');
    assert.strictEqual(stored.assigned_to, 'company-A', 'assigned_to must be unchanged');
    assert.strictEqual('credits' in stored, false, 'credits must never be written onto a lead row');
  });

  // (h) invalid contractor statuses are rejected
  await run('(h) invalid statuses are rejected, including reverting to "new"', async () => {
    const db = seedFixture();
    for (const badStatus of ['new', 'deleted', 'won; DROP TABLE leads', undefined]) {
      const result = await updateLeadForUser({ role: 'contractor', id: 'company-A' }, 'lead-1', { status: badStatus }, db);
      assert.strictEqual(result.invalidStatus, true, `status ${JSON.stringify(badStatus)} should be rejected`);
    }
    const stored = db._dump().find(l => l.id === 'lead-1');
    assert.strictEqual(stored.status, 'new', 'no rejected status should have been applied');
  });

  // (i) unknown/missing roles get 403 (fail closed), on both GET and PUT paths
  await run('(i) unknown or missing role fails closed (forbidden)', async () => {
    const db = seedFixture();
    const cases = [{ role: 'manager', id: 'company-A' }, { id: 'company-A' }, {}, { role: '' }];
    for (const user of cases) {
      const getResult = await getLeadsForUser(user, undefined, db);
      assert.strictEqual(getResult.forbidden, true, `GET should be forbidden for user ${JSON.stringify(user)}`);
      const putResult = await updateLeadForUser(user, 'lead-1', { status: 'won' }, db);
      assert.strictEqual(putResult.forbidden, true, `PUT should be forbidden for user ${JSON.stringify(user)}`);
    }
    // Confirm this isn't relying on an undefined id happening to match zero rows —
    // it must be forbidden even for a company id that genuinely exists.
    const result = await getLeadsForUser({ role: 'manager', id: 'company-A' }, undefined, db);
    assert.strictEqual(result.data, undefined, 'forbidden responses must not also carry data');
  });

  // (j) admin behavior remains unchanged (unfiltered read, optional filter, unrestricted write)
  await run('(j) admin retains full read and write access', async () => {
    const db = seedFixture();

    const allLeads = await getLeadsForUser({ role: 'admin' }, undefined, db);
    assert.strictEqual(allLeads.data.length, 2, 'admin with no filter must see every lead');

    const filtered = await getLeadsForUser({ role: 'admin' }, 'company-A', db);
    assert.strictEqual(filtered.data.length, 1);
    assert.strictEqual(filtered.data[0].id, 'lead-1');

    const updateResult = await updateLeadForUser(
      { role: 'admin' },
      'lead-2',
      { status: 'won', customer_email: 'corrected@customer.example', assigned_to: 'company-A' },
      db
    );
    assert.strictEqual(updateResult.error, null);
    assert.strictEqual(updateResult.data.status, 'won');
    assert.strictEqual(updateResult.data.customer_email, 'corrected@customer.example');
    assert.strictEqual(updateResult.data.assigned_to, 'company-A', 'admin must still be able to reassign leads');
  });

  // (k) not-owned vs nonexistent lead are indistinguishable at the data layer
  await run('(k) not-owned and nonexistent leads produce identical results', async () => {
    const db = seedFixture();
    const notOwned = await updateLeadForUser({ role: 'contractor', id: 'company-B' }, 'lead-1', { status: 'won' }, db);
    const nonexistent = await updateLeadForUser({ role: 'contractor', id: 'company-B' }, 'lead-does-not-exist', { status: 'won' }, db);
    assert.deepStrictEqual(notOwned, { data: null, error: null });
    assert.deepStrictEqual(nonexistent, { data: null, error: null });
    // Since both produce the exact same shape, the route handler's single
    // `if (!result.data) return res.status(404)...` check necessarily
    // returns the identical response body for both cases.
  });

  console.log(`\n✅ All ${passed} lead authorization tests passed!`);
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
