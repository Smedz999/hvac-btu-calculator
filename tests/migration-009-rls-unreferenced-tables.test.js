// Static regression coverage for
// api/migrations/009-lockdown-unreferenced-tables-VERIFY-FIRST.sql
// — NOT applied to any database by this test or any other code in this repo.
//
// Offline/pure: reads the .sql file's raw text and asserts on its shape.
//
// Run with: node tests/migration-009-rls-unreferenced-tables.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../api/migrations/009-lockdown-unreferenced-tables-VERIFY-FIRST.sql'),
  'utf8'
);

function test1_EnablesRlsOnExactlyTheFourUnreferencedTables() {
  console.log('TEST 1: enables RLS on exactly suppliers, products, orders, order_items...');
  for (const table of ['suppliers', 'products', 'orders', 'order_items']) {
    assert(
      new RegExp(`ALTER TABLE IF EXISTS public\\.${table} ENABLE ROW LEVEL SECURITY`).test(src),
      `Expected ENABLE ROW LEVEL SECURITY for ${table}`
    );
  }
  // Must not touch the three service-role-only tables — those are migration
  // 008's job, deliberately kept separate.
  for (const table of ['leads', 'prospects', 'tasks']) {
    assert(!src.includes(`public.${table}`), `Migration 009 must not touch ${table} — that is migration 008's job`);
  }
  console.log('  ✅ PASS');
}

function test2_RevokesAnonAndAuthenticatedOnAllFour() {
  console.log('TEST 2: explicitly revokes anon/authenticated/PUBLIC on all four tables...');
  for (const table of ['suppliers', 'products', 'orders', 'order_items']) {
    assert(
      new RegExp(`REVOKE ALL ON public\\.${table} FROM anon, authenticated, PUBLIC`).test(src),
      `Expected REVOKE ALL for ${table}`
    );
  }
  console.log('  ✅ PASS');
}

function test3_GrantsNothingToServiceRoleEither() {
  console.log('TEST 3: grants nothing to service_role (no evidence this app needs these tables at all)...');
  const sqlOnly = src.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert(!/\bGRANT\b/.test(sqlOnly), 'Migration 009 should not contain a GRANT statement — these tables are unreferenced by this application');
  console.log('  ✅ PASS');
}

function test4_IsExplicitlyMarkedAsNeedingVerificationBeforeApplying() {
  console.log('TEST 4: the file itself documents that it must not be applied without verification first...');
  assert(
    /DO NOT APPLY WITHOUT FIRST CONFIRMING/i.test(src),
    'Expected an explicit "do not apply without verifying" warning in the migration header'
  );
  console.log('  ✅ PASS');
}

function test5_KeptAsASeparateFileFromMigration008() {
  console.log('TEST 5: this is a separate file from migration 008 (never bundled as one all-or-nothing change)...');
  const files = fs.readdirSync(path.join(__dirname, '../api/migrations'));
  assert(files.includes('008-enable-rls-service-role-only-tables.sql'), 'Expected migration 008 to exist as its own separate file');
  assert(files.includes('009-lockdown-unreferenced-tables-VERIFY-FIRST.sql'), 'Expected migration 009 to exist as its own separate file');
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔒 Migration 009 (RLS on unreferenced tables, verify-first) static shape tests (offline, not applied)\n');
  test1_EnablesRlsOnExactlyTheFourUnreferencedTables();
  test2_RevokesAnonAndAuthenticatedOnAllFour();
  test3_GrantsNothingToServiceRoleEither();
  test4_IsExplicitlyMarkedAsNeedingVerificationBeforeApplying();
  test5_KeptAsASeparateFileFromMigration008();
  console.log('\n✅ All migration 009 shape tests passed!');
}

runTests();
