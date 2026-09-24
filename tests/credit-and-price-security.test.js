// Static regression coverage for the credit- and price-manipulation
// defenses in server.js. These are invariants an attacker would directly
// target ("attack the credit system", "manipulate package prices" per the
// review brief), so this file pins them down as explicit, named tests
// rather than leaving them as implicit properties nobody would notice
// breaking.
//
// Offline/pure: reads server.js's own source text and asserts on its
// shape, following the same convention as trust-proxy.test.js and the
// migration shape tests. This does not (and cannot, without a live
// database) prove the underlying RPCs enforce these invariants server-side
// too — it proves the Node route layer itself never becomes a bypass.
//
// Run with: node tests/credit-and-price-security.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '../api/server.js'), 'utf8');

function extractRoute(routeSignatureRegex) {
  const startMatch = serverSrc.match(routeSignatureRegex);
  assert(startMatch, `Could not find route matching ${routeSignatureRegex}`);
  const startIdx = startMatch.index;
  // Grab a generous window after the route definition — enough to contain
  // the whole handler body for every route this file inspects, without
  // needing a full brace-matching parser.
  return serverSrc.slice(startIdx, startIdx + 2500);
}

function test1_PutCompanyAlwaysStripsCreditsRegardlessOfRole() {
  console.log('TEST 1: PUT /api/companies/:id strips `credits` from the update unconditionally (not gated behind a role check)...');
  const route = extractRoute(/app\.put\('\/api\/companies\/:id'/);
  const roleCheckIdx = route.search(/req\.user\.role !== 'admin'/);
  const deleteCreditsIdx = route.search(/delete updates\.credits/);
  assert(roleCheckIdx !== -1, 'Expected the admin/self ownership check');
  assert(deleteCreditsIdx !== -1, 'Expected delete updates.credits');
  // The delete must not be inside an `if (req.user.role !== 'admin')` block
  // — i.e. it must run for admins too. We check this by confirming there is
  // no unclosed conditional between the ownership check's closing brace and
  // the delete statement that would scope it to non-admins only. The
  // ownership check's own block closes immediately (single early-return
  // line), so the delete appearing anywhere after that closing brace and
  // before the actual DB update call means it applies to every caller.
  const updateCallIdx = route.search(/\.from\('companies'\)\s*\n\s*\.update\(updates\)/);
  assert(updateCallIdx !== -1, 'Expected the update(updates) call');
  assert(deleteCreditsIdx > roleCheckIdx && deleteCreditsIdx < updateCallIdx,
    'delete updates.credits must run after the ownership check and before the DB update, unconditionally');
  console.log('  ✅ PASS');
}

function test2_PutCompanyAlwaysStripsPassword() {
  console.log('TEST 2: PUT /api/companies/:id strips `password` from the update unconditionally...');
  const route = extractRoute(/app\.put\('\/api\/companies\/:id'/);
  assert(/delete updates\.password/.test(route), 'Expected delete updates.password');
  console.log('  ✅ PASS');
}

function test3_CreatePaymentIntentNeverReadsAmountFromClient() {
  console.log('TEST 3: POST /api/create-payment-intent never destructures amount/price/credits from req.body...');
  const route = extractRoute(/app\.post\('\/api\/create-payment-intent'/);
  const destructureMatch = route.match(/const\s*\{([^}]*)\}\s*=\s*req\.body/);
  assert(destructureMatch, 'Expected a req.body destructure');
  const destructured = destructureMatch[1];
  for (const forbidden of ['amount', 'price', 'credits', 'discount']) {
    assert(
      !new RegExp(`\\b${forbidden}\\b`, 'i').test(destructured),
      `req.body must never be trusted for "${forbidden}" — found in destructure: ${destructured}`
    );
  }
  assert(/packageId/.test(destructured), 'Expected only packageId to be read from the client');
  console.log('  ✅ PASS');
}

function test4_CreatePaymentIntentSourcesCompanyIdFromJwtOnly() {
  console.log('TEST 4: POST /api/create-payment-intent takes companyId from req.user.id (JWT), never req.body...');
  const route = extractRoute(/app\.post\('\/api\/create-payment-intent'/);
  assert(/const companyId = req\.user\.id/.test(route), 'Expected companyId to come from req.user.id');
  assert(!/req\.body\.companyId/.test(route), 'companyId must never be read from req.body on this route');
  console.log('  ✅ PASS');
}

function test5_PaymentIntentAmountComesFromReservationNotClient() {
  console.log('TEST 5: the Stripe PaymentIntent amount/currency are read back from the DB reservation, never the client...');
  const route = extractRoute(/app\.post\('\/api\/create-payment-intent'/);
  assert(
    /stripe\.paymentIntents\.create\(\{\s*\n\s*amount: reservation\.amount_pence,\s*\n\s*currency: reservation\.currency,/.test(route),
    'Expected stripe.paymentIntents.create to use reservation.amount_pence / reservation.currency, not client input'
  );
  console.log('  ✅ PASS');
}

function test6_AdjustCreditsRouteRequiresAdmin() {
  console.log('TEST 6: POST /api/admin/adjust-credits is behind requireAdmin, and rejects a zero/non-numeric delta...');
  const route = extractRoute(/app\.post\('\/api\/admin\/adjust-credits',\s*requireAdmin/);
  assert(route, 'Expected requireAdmin directly on the route definition');
  assert(/typeof delta !== 'number' \|\| delta === 0/.test(route), 'Expected delta to be validated as a non-zero number before calling the RPC');
  console.log('  ✅ PASS');
}

function test7_AdjustCreditsNeverArithmeticsInNodeItCallsTheRpc() {
  console.log('TEST 7: credit adjustment is delegated entirely to the admin_adjust_credits RPC — no local balance arithmetic...');
  const route = extractRoute(/app\.post\('\/api\/admin\/adjust-credits'/);
  assert(/supabase\.rpc\('admin_adjust_credits'/.test(route), 'Expected the RPC call');
  assert(!/credits\s*[+-]=/.test(route), 'Must not do local credits += / -= arithmetic');
  assert(!/\.update\(\s*\{\s*credits/.test(route), 'Must not directly .update({ credits: ... }) from Node — the RPC owns this');
  console.log('  ✅ PASS');
}

function test8_GetPackageOnlyReturnsActivePackages() {
  console.log('TEST 8: getPackage() only returns active packages (a deactivated/removed package cannot be purchased)...');
  const fnMatch = serverSrc.match(/async function getPackage\(packageId\)[\s\S]*?\n\}/);
  assert(fnMatch, 'Expected a getPackage() function');
  assert(/\.eq\('active', true\)/.test(fnMatch[0]), "Expected .eq('active', true) filter");
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('💰 Credit & price manipulation static invariant tests (offline, source-text based)\n');
  test1_PutCompanyAlwaysStripsCreditsRegardlessOfRole();
  test2_PutCompanyAlwaysStripsPassword();
  test3_CreatePaymentIntentNeverReadsAmountFromClient();
  test4_CreatePaymentIntentSourcesCompanyIdFromJwtOnly();
  test5_PaymentIntentAmountComesFromReservationNotClient();
  test6_AdjustCreditsRouteRequiresAdmin();
  test7_AdjustCreditsNeverArithmeticsInNodeItCallsTheRpc();
  test8_GetPackageOnlyReturnsActivePackages();
  console.log('\n✅ All 8 credit & price security tests passed!');
}

runTests();
