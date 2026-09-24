// Static regression coverage for
// api/migrations/008-enable-rls-service-role-only-tables.sql
// — NOT applied to any database by this test or any other code in this repo.
//
// Offline/pure: reads the .sql file's raw text and asserts on its shape,
// following the same convention as migrations 005/006/007's tests.
//
// Run with: node tests/migration-008-rls-service-role-tables.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../api/migrations/008-enable-rls-service-role-only-tables.sql'),
  'utf8'
);

function test1_EnablesRlsOnExactlyTheThreeServiceRoleOnlyTables() {
  console.log('TEST 1: enables RLS on exactly leads, prospects, tasks...');
  for (const table of ['leads', 'prospects', 'tasks']) {
    assert(
      new RegExp(`ALTER TABLE IF EXISTS public\\.${table} ENABLE ROW LEVEL SECURITY`).test(src),
      `Expected ENABLE ROW LEVEL SECURITY for ${table}`
    );
  }
  // Must NOT touch the four unreferenced tables — those are migration 009's
  // job, deliberately kept separate (see that file's own header).
  for (const table of ['suppliers', 'products', 'orders', 'order_items']) {
    assert(!src.includes(`public.${table}`), `Migration 008 must not touch ${table} — that belongs in migration 009`);
  }
  console.log('  ✅ PASS');
}

function test2_RevokesAnonAndAuthenticatedOnAllThree() {
  console.log('TEST 2: explicitly revokes anon/authenticated/PUBLIC on all three tables...');
  for (const table of ['leads', 'prospects', 'tasks']) {
    assert(
      new RegExp(`REVOKE ALL ON public\\.${table} FROM anon, authenticated, PUBLIC`).test(src),
      `Expected REVOKE ALL for ${table}`
    );
  }
  console.log('  ✅ PASS');
}

function test3_GrantsNothingNewToServiceRole() {
  console.log('TEST 3: does not add any new GRANT to service_role (it already has what it needs via BYPASSRLS + existing schema grants)...');
  const sqlOnly = src.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert(!/\bGRANT\b/.test(sqlOnly), 'Migration 008 should not need to GRANT anything new to service_role');
  console.log('  ✅ PASS');
}

function test4_AddsNoPolicies() {
  console.log('TEST 4: adds no CREATE POLICY statements (none are needed — service_role bypasses RLS, anon/authenticated get nothing)...');
  const sqlOnly = src.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert(!/CREATE POLICY/i.test(sqlOnly), 'Migration 008 should not add policies — matches migration 003\'s established deny-all pattern');
  console.log('  ✅ PASS');
}

function test5_UsesIfExistsForSafety() {
  console.log('TEST 5: uses IF EXISTS so this is safe even if a table name is ever wrong or already handled...');
  const alterStatements = src.match(/ALTER TABLE IF EXISTS public\.\w+ ENABLE ROW LEVEL SECURITY/g) || [];
  assert(alterStatements.length === 3, `Expected exactly 3 ALTER TABLE statements, found ${alterStatements.length}`);
  for (const stmt of alterStatements) {
    assert(stmt.includes('IF EXISTS'), `Expected IF EXISTS in: ${stmt}`);
  }
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔒 Migration 008 (RLS on service-role-only tables) static shape tests (offline, not applied)\n');
  test1_EnablesRlsOnExactlyTheThreeServiceRoleOnlyTables();
  test2_RevokesAnonAndAuthenticatedOnAllThree();
  test3_GrantsNothingNewToServiceRole();
  test4_AddsNoPolicies();
  test5_UsesIfExistsForSafety();
  console.log('\n✅ All migration 008 shape tests passed!');
}

runTests();
