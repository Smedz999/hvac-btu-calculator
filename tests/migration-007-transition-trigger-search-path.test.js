// Static regression coverage for
// api/migrations/007-harden-transition-trigger-search-path.sql
// — NOT applied to any database by this test or any other code in this repo.
//
// Offline/pure: does not touch the database, does not require the server to
// be running, and does not apply the migration — it only reads the .sql
// files' raw text and asserts on their shape, following the same convention
// as migration-005/006's tests.
//
// Run with: node tests/migration-007-transition-trigger-search-path.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migration007Src = fs.readFileSync(
  path.join(__dirname, '../api/migrations/007-harden-transition-trigger-search-path.sql'),
  'utf8'
);
const migration003Src = fs.readFileSync(
  path.join(__dirname, '../api/migrations/003-payment-reservation-architecture.sql'),
  'utf8'
);

function test1_HardensSecurityDefinerAndSearchPath() {
  console.log('TEST 1: prevent_invalid_transitions() gets SECURITY DEFINER + pinned search_path...');
  const fnMatch = migration007Src.match(
    /CREATE OR REPLACE FUNCTION prevent_invalid_transitions\(\)[\s\S]*?\$\$;/
  );
  assert(fnMatch, 'Expected a CREATE OR REPLACE FUNCTION prevent_invalid_transitions() definition');
  const fnBody = fnMatch[0];
  assert(/SECURITY DEFINER/.test(fnBody), 'Expected SECURITY DEFINER');
  assert(/SET search_path = public, pg_temp/.test(fnBody), 'Expected SET search_path = public, pg_temp');
  console.log('  ✅ PASS');
}

function test2_PreservesOriginalTransitionLogicExactly() {
  console.log('TEST 2: transition rules are preserved exactly (no behavior change)...');
  const rules = [
    "IF OLD.status = NEW.status THEN",
    "OLD.status = 'succeeded' AND NEW.status != 'succeeded'",
    "OLD.status = 'cancelled' AND NEW.status != 'cancelled'",
    "OLD.status = 'expired' AND NEW.status != 'expired'",
    "OLD.status = 'pending' AND NEW.status NOT IN ('processing', 'expired')",
    "OLD.status = 'processing' AND NEW.status NOT IN ('succeeded', 'cancelled')"
  ];
  for (const rule of rules) {
    assert(migration007Src.includes(rule), `Expected unchanged transition rule: ${rule}`);
  }
  console.log('  ✅ PASS');
}

function test3_OriginalMigration003DefinitionIsUnmodified() {
  console.log('TEST 3: migration 003\'s original definition is untouched (007 is additive/append-only)...');
  assert(
    /CREATE OR REPLACE FUNCTION prevent_invalid_transitions\(\)\s*\nRETURNS TRIGGER AS \$\$/.test(migration003Src),
    'migration 003 should retain its original (unhardened) definition unchanged — 007 supersedes it at apply-time via CREATE OR REPLACE, without editing 003 itself'
  );
  console.log('  ✅ PASS');
}

function test4_IsIdempotentCreateOrReplace() {
  console.log('TEST 4: uses CREATE OR REPLACE (idempotent, safe to run multiple times)...');
  assert(
    migration007Src.includes('CREATE OR REPLACE FUNCTION prevent_invalid_transitions()'),
    'Expected CREATE OR REPLACE FUNCTION (not CREATE FUNCTION, which would fail on a second run)'
  );
  console.log('  ✅ PASS');
}

function test5_DoesNotTouchTriggerDefinitionOrCreateNewObjects() {
  console.log('TEST 5: migration 007 touches only the existing function (body + grants), nothing else...');
  assert(!/CREATE TABLE/i.test(migration007Src), 'Should not create tables');
  assert(!/DROP TRIGGER/i.test(migration007Src), 'Should not touch the trigger — replacing the function is sufficient');
  assert(!/CREATE POLICY/i.test(migration007Src), 'Should not add RLS policies — out of scope for this function');
  console.log('  ✅ PASS');
}

// Verified against the isolated ACConnX-Test Supabase project: after
// migrations 003-009 were applied, Supabase's Security Advisor flagged
// prevent_invalid_transitions() as SECURITY DEFINER but still executable by
// anon/authenticated — i.e. hardening the search_path (test 1, above) without
// also revoking EXECUTE left this trigger-only function directly callable by
// unprivileged roles with owner privileges. Applying the three REVOKE
// statements below in ACConnX-Test made that specific advisor warning
// disappear completely.
function test6_RevokesExecuteFromAnonAuthenticatedAndPublic() {
  console.log('TEST 6: EXECUTE is revoked from anon, authenticated, and PUBLIC (fixes the SECURITY DEFINER execution warning verified in ACConnX-Test)...');
  const expectedRevokes = [
    'REVOKE EXECUTE ON FUNCTION prevent_invalid_transitions() FROM anon;',
    'REVOKE EXECUTE ON FUNCTION prevent_invalid_transitions() FROM authenticated;',
    'REVOKE EXECUTE ON FUNCTION prevent_invalid_transitions() FROM PUBLIC;'
  ];
  for (const stmt of expectedRevokes) {
    assert(migration007Src.includes(stmt), `Expected exact statement: ${stmt}`);
  }
  // Must come after the CREATE OR REPLACE FUNCTION — revoking EXECUTE on a
  // function that doesn't exist yet would fail.
  const createIdx = migration007Src.indexOf('CREATE OR REPLACE FUNCTION prevent_invalid_transitions()');
  const firstRevokeIdx = migration007Src.indexOf('REVOKE EXECUTE ON FUNCTION prevent_invalid_transitions()');
  assert(createIdx !== -1 && firstRevokeIdx !== -1 && firstRevokeIdx > createIdx,
    'REVOKE statements must come after the function is (re)created');
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔒 Migration 007 (transition trigger search_path hardening) static shape tests (offline, not applied)\n');
  test1_HardensSecurityDefinerAndSearchPath();
  test2_PreservesOriginalTransitionLogicExactly();
  test3_OriginalMigration003DefinitionIsUnmodified();
  test4_IsIdempotentCreateOrReplace();
  test5_DoesNotTouchTriggerDefinitionOrCreateNewObjects();
  test6_RevokesExecuteFromAnonAuthenticatedAndPublic();
  console.log('\n✅ All migration 007 shape tests passed!');
}

runTests();
