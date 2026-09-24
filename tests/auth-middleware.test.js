// Offline regression tests for api/auth.js: requireAuth, requireAdmin,
// generateToken, generateAdminToken.
//
// Before this file, these functions — the entire JWT authorization boundary
// for every non-public route in the app — had no direct test coverage.
// lead-authorization.test.js exercises the route-level authorization
// FUNCTIONS (getLeadsForUser/updateLeadForUser) with a `req.user` object
// handed to them directly; it never runs a real token through the actual
// requireAuth/requireAdmin middleware that produces `req.user` in
// production. This file closes that gap: forged tokens, tampered role
// claims, wrong-role access, expired tokens, and malformed headers.
//
// Fully offline: no network, no database. Uses the real `jsonwebtoken`
// library (not a mock) so signature verification is genuinely exercised.
//
// Run with: node tests/auth-middleware.test.js

const assert = require('assert');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'offline-test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'offline-test-admin';

const { generateToken, generateAdminToken, requireAuth, requireAdmin } =
  require(path.join(__dirname, '../api/auth.js'));
const jwt = require(path.join(__dirname, '../api/node_modules/jsonwebtoken'));

function fakeReq(authHeader) {
  return { headers: authHeader ? { authorization: authHeader } : {} };
}

function fakeRes() {
  const res = { statusCode: null, jsonBody: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.jsonBody = body; return res; };
  return res;
}

function runMiddleware(middleware, req) {
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

function test1_ValidContractorTokenIsAccepted() {
  console.log('TEST 1: a validly signed contractor token is accepted by requireAuth...');
  const token = generateToken({ id: 42, email: 'a@example.com', company: 'Acme' });
  const req = fakeReq(`Bearer ${token}`);
  const { res, nextCalled } = runMiddleware(requireAuth, req);
  assert(nextCalled, 'next() should be called for a valid token');
  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(req.user.id, 42);
  assert.strictEqual(req.user.role, 'contractor');
  console.log('  ✅ PASS');
}

function test2_ValidAdminTokenIsAcceptedByRequireAdmin() {
  console.log('TEST 2: a validly signed admin token is accepted by requireAdmin...');
  const token = generateAdminToken();
  const req = fakeReq(`Bearer ${token}`);
  const { res, nextCalled } = runMiddleware(requireAdmin, req);
  assert(nextCalled);
  assert.strictEqual(req.user.role, 'admin');
  console.log('  ✅ PASS');
}

function test3_ContractorTokenIsRejectedByRequireAdmin() {
  console.log('TEST 3: a valid CONTRACTOR token is rejected by requireAdmin (403, not 401)...');
  const token = generateToken({ id: 1, email: 'a@example.com', company: 'Acme' });
  const req = fakeReq(`Bearer ${token}`);
  const { res, nextCalled } = runMiddleware(requireAdmin, req);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  console.log('  ✅ PASS');
}

function test4_NoAuthorizationHeaderIsRejected() {
  console.log('TEST 4: a request with no Authorization header is rejected (401) by both middlewares...');
  for (const mw of [requireAuth, requireAdmin]) {
    const { res, nextCalled } = runMiddleware(mw, fakeReq(undefined));
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
  }
  console.log('  ✅ PASS');
}

function test5_MalformedHeaderIsRejected() {
  console.log('TEST 5: malformed Authorization headers (no Bearer prefix, empty, garbage) are rejected...');
  const badHeaders = ['NotBearer sometoken', 'Bearer', 'Bearer ', 'totally-invalid', ''];
  for (const header of badHeaders) {
    const { res, nextCalled } = runMiddleware(requireAuth, fakeReq(header));
    assert.strictEqual(nextCalled, false, `expected rejection for header: ${JSON.stringify(header)}`);
    assert.strictEqual(res.statusCode, 401);
  }
  console.log('  ✅ PASS');
}

function test6_TokenSignedWithWrongSecretIsRejected() {
  console.log('TEST 6: a token signed with a DIFFERENT secret (forged) is rejected...');
  const forgedToken = jwt.sign({ id: 1, role: 'admin' }, 'a-completely-different-guessed-secret', { expiresIn: '1h' });
  const { res, nextCalled } = runMiddleware(requireAdmin, fakeReq(`Bearer ${forgedToken}`));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  console.log('  ✅ PASS');
}

function test7_TamperedPayloadInvalidatesSignature() {
  console.log('TEST 7: editing a valid token\'s payload (privilege escalation attempt) invalidates its signature...');
  const validToken = generateToken({ id: 1, email: 'a@example.com', company: 'Acme' }); // role: contractor
  const [headerB64, payloadB64, sig] = validToken.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  assert.strictEqual(payload.role, 'contractor');
  payload.role = 'admin'; // attacker escalates role client-side without knowing JWT_SECRET
  const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sig}`;

  const { res, nextCalled } = runMiddleware(requireAdmin, fakeReq(`Bearer ${tamperedToken}`));
  assert.strictEqual(nextCalled, false, 'a tampered token must never reach next()');
  assert.strictEqual(res.statusCode, 401, 'signature mismatch must be rejected as invalid, not merely wrong-role');
  console.log('  ✅ PASS');
}

function test8_ExpiredTokenIsRejected() {
  console.log('TEST 8: an expired token is rejected...');
  const expiredToken = jwt.sign(
    { id: 1, email: 'a@example.com', company: 'Acme', role: 'contractor' },
    process.env.JWT_SECRET,
    { expiresIn: -10 } // already expired
  );
  const { res, nextCalled } = runMiddleware(requireAuth, fakeReq(`Bearer ${expiredToken}`));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  console.log('  ✅ PASS');
}

function test9_TokenSignedWithNoneAlgorithmIsRejected() {
  console.log('TEST 9: a classic "alg: none" forged token (no signature at all) is rejected...');
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ id: 1, role: 'admin' })).toString('base64url');
  const noneToken = `${header}.${payload}.`;
  const { res, nextCalled } = runMiddleware(requireAdmin, fakeReq(`Bearer ${noneToken}`));
  assert.strictEqual(nextCalled, false, 'jsonwebtoken.verify must reject alg:none tokens by default');
  assert.strictEqual(res.statusCode, 401);
  console.log('  ✅ PASS');
}

function test10_MissingRoleClaimFailsClosedOnRequireAdmin() {
  console.log('TEST 10: a validly-signed token with no role claim at all is rejected by requireAdmin (fail closed)...');
  const noRoleToken = jwt.sign({ id: 1, email: 'a@example.com' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { res, nextCalled } = runMiddleware(requireAdmin, fakeReq(`Bearer ${noRoleToken}`));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  console.log('  ✅ PASS');
}

function runTests() {
  console.log('🔑 Auth middleware offline tests (real jsonwebtoken, no network)\n');
  test1_ValidContractorTokenIsAccepted();
  test2_ValidAdminTokenIsAcceptedByRequireAdmin();
  test3_ContractorTokenIsRejectedByRequireAdmin();
  test4_NoAuthorizationHeaderIsRejected();
  test5_MalformedHeaderIsRejected();
  test6_TokenSignedWithWrongSecretIsRejected();
  test7_TamperedPayloadInvalidatesSignature();
  test8_ExpiredTokenIsRejected();
  test9_TokenSignedWithNoneAlgorithmIsRejected();
  test10_MissingRoleClaimFailsClosedOnRequireAdmin();
  console.log('\n✅ All 10 auth middleware tests passed!');
}

runTests();
