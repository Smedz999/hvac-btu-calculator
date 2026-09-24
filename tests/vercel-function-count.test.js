// Regression test for the Vercel "builds successfully, then fails during
// 'Deploying outputs...'" incident.
//
// Root cause: this project has no framework Vercel recognizes (plain static
// HTML + a bare /api directory), so Vercel's zero-config detection treats
// EVERY .js file anywhere under /api (including nested subdirectories) as
// its own separate Serverless Function — see
// https://vercel.com/docs/functions/runtimes#functions-created-per-deployment:
// "every API maps directly to one Vercel Function ... For Hobby, this
// approach is limited to 12 Vercel Functions per deployment."
//
// At the time of the incident, api/ contained 4 real files (index.js,
// auth.js, server.js, migrate-coverage-areas.js) PLUS 9 files under
// api/tests/*.test.js added across the lead-distribution hardening commits
// — 13 total, one over the Hobby limit. Vercel's own recommendation (there
// is no supported per-file exclusion for a vanilla /api project — see
// https://github.com/vercel/community/discussions/46) is to keep non-handler
// files (tests, one-off scripts) in a directory outside /api entirely. That
// fix was applied: api/tests/ moved to tests/, api/migrate-coverage-areas.js
// moved to scripts/migrate-coverage-areas.js.
//
// This test guards against the same mistake recurring: it fails loudly if
// anyone adds enough .js files back under /api to approach the Hobby limit,
// or reintroduces a tests/scripts directory inside /api.
//
// Offline/pure: only reads the filesystem, no network, no DB.
//
// Run with: node tests/vercel-function-count.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '../api');

// Hobby plan limit per Vercel's own docs (see link above). Kept as a named
// constant so the intent is clear if Vercel ever changes the number.
const VERCEL_HOBBY_FUNCTION_LIMIT = 12;

// Leave real headroom below the hard limit so routine growth of the actual
// API doesn't require touching this test every time.
const SAFE_MAX_JS_FILES_UNDER_API = 8;

function listJsFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function test1_NoTestsOrScriptsDirectoryUnderApi() {
  console.log('TEST 1: no tests/ or scripts/ directory exists under api/...');
  assert(!fs.existsSync(path.join(API_DIR, 'tests')), 'api/tests/ must not exist — Vercel would register every file in it as a separate function. Put test files in the repo-root tests/ directory instead.');
  assert(!fs.existsSync(path.join(API_DIR, 'scripts')), 'api/scripts/ must not exist for the same reason — use the repo-root scripts/ directory.');
  console.log('  ✅ PASS');
}

function test2_JsFileCountUnderApiStaysWellBelowHobbyLimit() {
  console.log('TEST 2: total .js files under api/ (recursive) stay well below the Vercel Hobby function limit...');
  const jsFiles = listJsFilesRecursive(API_DIR);
  assert(
    jsFiles.length <= SAFE_MAX_JS_FILES_UNDER_API,
    `Found ${jsFiles.length} .js files under api/ (limit for this repo is ` +
    `${SAFE_MAX_JS_FILES_UNDER_API}, Vercel Hobby's hard limit is ` +
    `${VERCEL_HOBBY_FUNCTION_LIMIT} functions per deployment — every .js ` +
    `file under api/, including nested ones, becomes its own function). ` +
    `Files: ${jsFiles.map(f => path.relative(API_DIR, f)).join(', ')}. ` +
    `Move non-handler files (tests, one-off scripts) outside api/.`
  );
  console.log(`  ✅ PASS (${jsFiles.length} files: ${jsFiles.map(f => path.relative(API_DIR, f)).join(', ')})`);
}

function test3_OnlyKnownEntrypointFilesExistAtTopLevel() {
  console.log('TEST 3: only the known real entrypoint files sit directly under api/...');
  const topLevelJs = fs.readdirSync(API_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => e.name)
    .sort();
  const expected = ['auth.js', 'index.js', 'server.js'];
  assert.deepStrictEqual(
    topLevelJs,
    expected,
    `Expected exactly ${JSON.stringify(expected)} directly under api/, found ${JSON.stringify(topLevelJs)}. ` +
    `If you're adding a genuine new API route file, that's fine and this test's ` +
    `"expected" list should be updated deliberately — but if it's a helper, ` +
    `script, or test file, it belongs outside api/ instead.`
  );
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🧮 Vercel function-count regression tests (offline, filesystem only)\n');
  test1_NoTestsOrScriptsDirectoryUnderApi();
  test2_JsFileCountUnderApiStaysWellBelowHobbyLimit();
  test3_OnlyKnownEntrypointFilesExistAtTopLevel();
  console.log('\n✅ All Vercel function-count tests passed!');
}

runTests();
