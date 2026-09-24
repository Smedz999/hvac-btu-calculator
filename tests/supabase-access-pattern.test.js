// Regression test for the safety argument behind migration 008 (and, more
// generally, the whole "RLS-enabled-with-no-policies is safe because
// service_role bypasses it and nothing else touches these tables" pattern
// already used throughout this codebase since migration 003).
//
// That argument depends entirely on one fact staying true: EVERY Supabase
// client this application constructs uses the service-role key, and NO
// frontend/browser code ever talks to Supabase directly. This test encodes
// that fact as an executable check, so if it ever stops being true (someone
// adds an anon-key client, or wires up client-side Supabase access in a new
// HTML page), this test fails loudly instead of the assumption silently
// rotting — which would turn every "RLS enabled, no policies" table in this
// codebase into a real vulnerability instead of a safe design choice.
//
// Offline/pure: only reads source files from disk, no network, no DB.
//
// Run with: node tests/supabase-access-pattern.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

function listFilesRecursive(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// Resolves what environment variable ultimately feeds a createClient() key
// argument: either the argument IS `process.env.X` directly, or it's a local
// identifier whose nearest preceding `const <identifier> = process.env.X`
// assignment in the same file defines it.
function resolveEnvVarForKeyExpr(src, keyExpr) {
  const directMatch = keyExpr.match(/^process\.env\.(\w+)$/);
  if (directMatch) return directMatch[1];

  const identifier = keyExpr.split('.')[0];
  const assignMatch = src.match(new RegExp(`const\\s+${identifier}\\s*=\\s*process\\.env\\.(\\w+)`));
  return assignMatch ? assignMatch[1] : null;
}

function test1_EveryCreateClientCallUsesServiceKeyNotAnonKey() {
  console.log('TEST 1: every @supabase/supabase-js createClient() call in this repo is fed a SERVICE key env var, never an anon/publishable one...');
  const jsFiles = listFilesRecursive(REPO_ROOT, ['.js'])
    // Exclude this test file itself — its own source text mentions
    // createClient()/@supabase/supabase-js in comments, error-message
    // strings, and its own regex literals, which would otherwise match
    // itself as a (bogus) call site.
    .filter(f => path.resolve(f) !== path.resolve(__filename));
  let createClientSitesChecked = 0;

  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/createClient\s*\(/.test(src)) continue;
    if (!/@supabase\/supabase-js/.test(src)) continue; // ignore unrelated createClient() from other libraries, if any

    // Find the expression passed as the second argument to createClient(url, KEY, ...)
    const calls = [...src.matchAll(/createClient\s*\(\s*[^,]+,\s*([A-Za-z0-9_.]+)/g)];
    assert(calls.length > 0, `Expected at least one createClient(...) call in ${path.relative(REPO_ROOT, file)}`);

    for (const call of calls) {
      createClientSitesChecked++;
      const keyExpr = call[1];
      const envVar = resolveEnvVarForKeyExpr(src, keyExpr);
      assert(
        envVar,
        `${path.relative(REPO_ROOT, file)} passes "${keyExpr}" to createClient(), but this test couldn't trace it back to a ` +
        `\`process.env.X\` source. Make the key source traceable (assign it from process.env directly, or via a single ` +
        `\`const ${keyExpr} = process.env.X\` in the same file) so this stays auditable at a glance.`
      );
      assert(
        !/ANON/i.test(envVar) && !/PUBLISHABLE/i.test(envVar),
        `${path.relative(REPO_ROOT, file)} feeds createClient() from ${envVar} — this looks like an anon/publishable key, not a ` +
        `service key. If this is intentional, the RLS "no policies needed, service_role bypasses it" reasoning behind ` +
        `migration 008 no longer holds and every RLS-enabled-with-no-policy table needs re-review.`
      );
      assert(
        /SERVICE/i.test(envVar),
        `${path.relative(REPO_ROOT, file)} feeds createClient() from ${envVar} — expected an obviously-named SERVICE key env var ` +
        `(e.g. SUPABASE_SERVICE_KEY) so this stays auditable at a glance.`
      );
    }
  }

  assert(createClientSitesChecked >= 1, 'Expected to find at least one createClient() call to verify — if this is 0, the check above is vacuous and this test needs updating');
  console.log(`  ✅ PASS (checked ${createClientSitesChecked} createClient() call site(s))`);
}

function test2_NoHtmlFileReferencesSupabaseAtAll() {
  console.log('TEST 2: no .html file anywhere in the repo references Supabase (confirms there is no browser-side Supabase access)...');
  const htmlFiles = listFilesRecursive(REPO_ROOT, ['.html']);
  assert(htmlFiles.length > 0, 'Expected to find at least one .html file to check');

  const offenders = [];
  for (const file of htmlFiles) {
    const src = fs.readFileSync(file, 'utf8');
    if (/supabase/i.test(src)) offenders.push(path.relative(REPO_ROOT, file));
  }

  assert(
    offenders.length === 0,
    `Found "supabase" mentioned in: ${offenders.join(', ')}. If a page now talks to Supabase directly from the ` +
    `browser, it must use the anon key with real RLS policies — the "no policies needed" reasoning for every ` +
    `RLS-enabled-with-no-policy table in this codebase assumes zero browser-side Supabase access.`
  );
  console.log(`  ✅ PASS (checked ${htmlFiles.length} .html files)`);
}

function test3_LeadsProspectsTasksAreOnlyAccessedThroughTheServiceRoleClient() {
  console.log('TEST 3: every .from(\'leads\'/\'prospects\'/\'tasks\') call in server.js goes through the single module-level service-role client...');
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'api/server.js'), 'utf8');

  // The module-level client must be named `supabase` and constructed from
  // SUPABASE_SERVICE_KEY (asserted precisely, not just "contains SERVICE").
  assert(
    /const supabaseKey = process\.env\.SUPABASE_SERVICE_KEY;/.test(serverSrc),
    'Expected the module-level supabaseKey to come from SUPABASE_SERVICE_KEY'
  );
  assert(
    /const supabase = createClient\(supabaseUrl, supabaseKey/.test(serverSrc),
    'Expected the module-level `supabase` client to be constructed from that key'
  );

  for (const table of ['leads', 'prospects', 'tasks']) {
    const matches = [...serverSrc.matchAll(new RegExp(`\\.from\\('${table}'\\)`, 'g'))];
    assert(matches.length > 0, `Expected at least one .from('${table}') call in server.js`);
    // Every call site must be reached via `supabase.` or `supabaseClient.`
    // (the dependency-injected parameter that defaults to the same
    // module-level `supabase` singleton — see getLeadsForUser/distributeLead/
    // createLead), never a second, differently-keyed client.
    const otherClientNames = [...serverSrc.matchAll(/const\s+(\w+)\s*=\s*createClient\(/g)]
      .map(m => m[1])
      .filter(name => name !== 'supabase');
    assert.strictEqual(otherClientNames.length, 0, `Expected exactly one createClient() call in server.js, found extra client(s): ${otherClientNames.join(', ')}`);
  }
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔐 Supabase access-pattern regression tests (protects the reasoning behind migration 008)\n');
  test1_EveryCreateClientCallUsesServiceKeyNotAnonKey();
  test2_NoHtmlFileReferencesSupabaseAtAll();
  test3_LeadsProspectsTasksAreOnlyAccessedThroughTheServiceRoleClient();
  console.log('\n✅ All 3 Supabase access-pattern tests passed!');
}

runTests();
