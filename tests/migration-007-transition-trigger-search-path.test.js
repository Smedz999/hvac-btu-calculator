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

function test5_DoesNotTouchTriggerDefinitionOrOtherObjects() {
  console.log('TEST 5: migration 007 touches only the function body, nothing else...');
  assert(!/CREATE TABLE/i.test(migration007Src), 'Should not create tables');
  assert(!/DROP TRIGGER/i.test(migration007Src), 'Should not touch the trigger — replacing the function is sufficient');
  assert(!/GRANT|REVOKE/i.test(migration007Src), 'Should not touch grants — same function name/signature/owner, no new object');
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔒 Migration 007 (transition trigger search_path hardening) static shape tests (offline, not applied)\n');
  test1_HardensSecurityDefinerAndSearchPath();
  test2_PreservesOriginalTransitionLogicExactly();
  test3_OriginalMigration003DefinitionIsUnmodified();
  test4_IsIdempotentCreateOrReplace();
  test5_DoesNotTouchTriggerDefinitionOrOtherObjects();
  console.log('\n✅ All migration 007 shape tests passed!');
}

runTests();
