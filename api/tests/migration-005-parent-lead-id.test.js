// Static regression coverage for api/migrations/005-leads-parent-lead-id.sql
// — the migration BLOCKER 2 depends on (see distribute-lead-secondary-insert
// tests), which is NOT applied by this test or any other code in this repo.
//
// Offline/pure: does not touch the database, does not require the server to
// be running, and does not apply the migration — it only reads the .sql
// file's raw text and asserts on its shape, following the same convention
// as api/tests/receipt-cron-auth.test.js (tests 7-9) for migration 004.
//
// Run with: node api/tests/migration-005-parent-lead-id.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationSrc = fs.readFileSync(
  path.join(__dirname, '../migrations/005-leads-parent-lead-id.sql'),
  'utf8'
);

function test1_ColumnIsBigint() {
  console.log('TEST 1: parent_lead_id is declared BIGINT...');
  assert(
    /ADD COLUMN IF NOT EXISTS parent_lead_id BIGINT/.test(migrationSrc),
    'Expected ADD COLUMN IF NOT EXISTS parent_lead_id BIGINT'
  );
  console.log('  ✅ PASS');
}

function test2_ColumnIsNullableAndAdditiveOnly() {
  console.log('TEST 2: column addition is nullable/additive, safe for existing rows...');
  const columnStmt = migrationSrc.match(/ALTER TABLE public\.leads\s+ADD COLUMN IF NOT EXISTS parent_lead_id BIGINT[^;]*;/);
  assert(columnStmt, 'Expected an ADD COLUMN IF NOT EXISTS parent_lead_id statement');
  assert(
    !/NOT NULL/.test(columnStmt[0]),
    'parent_lead_id must not be NOT NULL — existing rows have no value for it'
  );
  assert(
    !/DEFAULT/.test(columnStmt[0]),
    'parent_lead_id must not carry a DEFAULT — it should only ever be set explicitly for secondary lead rows'
  );
  assert(
    /ADD COLUMN IF NOT EXISTS/.test(migrationSrc),
    'Column addition must be idempotent (IF NOT EXISTS)'
  );
  console.log('  ✅ PASS');
}

function test3_SelfReferencesLeadsId() {
  console.log('TEST 3: foreign key self-references public.leads(id)...');
  assert(
    /FOREIGN KEY \(parent_lead_id\) REFERENCES public\.leads\(id\)/.test(migrationSrc),
    'Expected FOREIGN KEY (parent_lead_id) REFERENCES public.leads(id)'
  );
  console.log('  ✅ PASS');
}

function test4_OnDeleteSetNull() {
  console.log('TEST 4: foreign key uses ON DELETE SET NULL...');
  assert(
    /FOREIGN KEY \(parent_lead_id\) REFERENCES public\.leads\(id\) ON DELETE SET NULL/.test(migrationSrc),
    'Expected ON DELETE SET NULL on the parent_lead_id foreign key'
  );
  assert(
    !/ON DELETE CASCADE/.test(migrationSrc),
    'Must not cascade-delete a contractor\'s own lead record when the original lead is deleted'
  );
  console.log('  ✅ PASS');
}

function test5_FkExistenceCheckScopedToLeadsTable() {
  console.log('TEST 5: FK existence check is scoped to public.leads via conrelid...');
  const guardMatch = migrationSrc.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint[\s\S]*?\) THEN/);
  assert(guardMatch, 'Expected an IF NOT EXISTS (SELECT 1 FROM pg_constraint ...) guard before adding the FK');
  const guardSrc = guardMatch[0];
  assert(
    /conname = 'leads_parent_lead_id_fkey'/.test(guardSrc),
    'Expected the guard to filter on conname = \'leads_parent_lead_id_fkey\''
  );
  assert(
    /conrelid = 'public\.leads'::regclass/.test(guardSrc),
    'Expected the guard to also filter on conrelid = \'public.leads\'::regclass ' +
    '— otherwise a same-named constraint on a different table would be mistaken for this one'
  );
  console.log('  ✅ PASS');
}

function test6_ColumnAndConstraintGuardsAreIdempotent() {
  console.log('TEST 6: column and constraint guards make re-running the migration safe...');
  assert(
    /ADD COLUMN IF NOT EXISTS parent_lead_id/.test(migrationSrc),
    'Column add must be guarded with IF NOT EXISTS'
  );
  assert(
    /CREATE INDEX IF NOT EXISTS idx_leads_parent_lead_id/.test(migrationSrc),
    'Index creation must be guarded with IF NOT EXISTS'
  );
  // The FK itself has no native "ADD CONSTRAINT IF NOT EXISTS" in Postgres,
  // so idempotency for it must come from the explicit existence check
  // asserted in test5, wrapping the ADD CONSTRAINT.
  const fkGuardWrapsAddConstraint = /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint[\s\S]*?\) THEN[\s\S]*?ADD CONSTRAINT leads_parent_lead_id_fkey[\s\S]*?END IF;/.test(migrationSrc);
  assert(fkGuardWrapsAddConstraint, 'Expected the ADD CONSTRAINT to be wrapped inside the existence-check IF block');
  console.log('  ✅ PASS');
}

function test7_PartialIndexOnParentLeadId() {
  console.log('TEST 7: partial index on parent_lead_id excludes NULLs...');
  assert(
    /CREATE INDEX IF NOT EXISTS idx_leads_parent_lead_id\s+ON public\.leads\(parent_lead_id\)/.test(migrationSrc),
    'Expected CREATE INDEX IF NOT EXISTS idx_leads_parent_lead_id ON public.leads(parent_lead_id)'
  );
  assert(
    /WHERE parent_lead_id IS NOT NULL/.test(migrationSrc),
    'Expected the index to be partial: WHERE parent_lead_id IS NOT NULL'
  );
  console.log('  ✅ PASS');
}

function test8_DoesNotModifyUnrelatedTablesOrExistingData() {
  console.log('TEST 8: migration touches only public.leads, never writes row data...');
  const withoutComments = migrationSrc.replace(/--.*$/gm, '');
  // Match actual DML statement shapes, not incidental prose (e.g. a RAISE
  // EXCEPTION message telling an operator to "update this migration").
  const dataModifyingPatterns = [
    { label: 'UPDATE ... SET', pattern: /\bUPDATE\s+\S+\s+SET\b/i },
    { label: 'DELETE FROM', pattern: /\bDELETE\s+FROM\b/i },
    { label: 'TRUNCATE', pattern: /\bTRUNCATE\b/i }
  ];
  for (const { label, pattern } of dataModifyingPatterns) {
    assert(!pattern.test(withoutComments), `Migration must not contain a ${label} statement`);
  }
  const forbiddenTables = ['companies', 'purchases', 'payment_reservations', 'credit_ledger'];
  for (const table of forbiddenTables) {
    assert(
      !new RegExp(`ALTER TABLE\\s+(public\\.)?${table}\\b`, 'i').test(withoutComments),
      `Migration must not ALTER ${table}`
    );
  }
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🗄️  Migration 005 (parent_lead_id) static shape tests (offline, not applied)\n');
  test1_ColumnIsBigint();
  test2_ColumnIsNullableAndAdditiveOnly();
  test3_SelfReferencesLeadsId();
  test4_OnDeleteSetNull();
  test5_FkExistenceCheckScopedToLeadsTable();
  test6_ColumnAndConstraintGuardsAreIdempotent();
  test7_PartialIndexOnParentLeadId();
  test8_DoesNotModifyUnrelatedTablesOrExistingData();
  console.log('\n✅ All migration 005 shape tests passed!');
}

runTests();
