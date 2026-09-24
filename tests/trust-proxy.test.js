// Verifies the fix for the Vercel "X-Forwarded-For header is set but the
// Express 'trust proxy' setting..." ValidationError from express-rate-limit.
//
// Vercel puts exactly one trusted proxy hop (its own edge) in front of this
// function and sets X-Forwarded-For to the real client IP. Without
// `app.set('trust proxy', 1)`, req.ip falls back to the internal socket
// peer address, which collapses express-rate-limit's per-client buckets
// into one shared bucket (and is what express-rate-limit's validation was
// warning about).
//
// Offline/pure: does not touch the database, Stripe, Resend, or any
// external network — the IP-resolution test spins up a real Express app on
// a loopback-only ephemeral port and talks to it over 127.0.0.1.
//
// Run with: node tests/trust-proxy.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const serverSrc = fs.readFileSync(path.join(__dirname, '../api/server.js'), 'utf8');
// express lives in api/node_modules (this file sits outside api/ on purpose —
// see the Vercel function-count fix — so it isn't hoisted to a shared
// top-level node_modules).
const express = require(path.join(__dirname, '../api/node_modules/express'));

function test1_TrustProxySetToExactlyOne() {
  console.log('TEST 1: trust proxy is set to exactly 1...');
  assert(
    /app\.set\(\s*'trust proxy'\s*,\s*1\s*\)/.test(serverSrc),
    "Expected app.set('trust proxy', 1) in server.js"
  );
  console.log('  ✅ PASS');
}

function test2_TrustProxySetBeforeRateLimitMiddleware() {
  console.log('TEST 2: trust proxy is set before rate-limit middleware is defined/mounted...');

  const trustProxyIdx = serverSrc.search(/app\.set\(\s*'trust proxy'/);
  const firstRateLimitCallIdx = serverSrc.indexOf('rateLimit({');
  const mountIdx = serverSrc.indexOf("app.use('/api/', apiLimiter)");

  assert(trustProxyIdx !== -1, "Could not find app.set('trust proxy', ...) in server.js");
  assert(firstRateLimitCallIdx !== -1, 'Could not find any rateLimit({...}) definition in server.js');
  assert(mountIdx !== -1, "Could not find app.use('/api/', apiLimiter) in server.js");

  assert(trustProxyIdx < firstRateLimitCallIdx, 'trust proxy must be set before the first rateLimit({...}) definition');
  assert(trustProxyIdx < mountIdx, 'trust proxy must be set before rate-limit middleware is mounted with app.use');

  console.log('  ✅ PASS');
}

function test3_TrustProxyTrueIsNotUsed() {
  console.log('TEST 3: trust proxy is never set to `true` (spoofable)...');
  assert(
    !/trust proxy'\s*,\s*true\s*\)/.test(serverSrc),
    "app.set('trust proxy', true) must not be used — it trusts the entire client-controlled X-Forwarded-For chain"
  );
  console.log('  ✅ PASS');
}

function getJson(port, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/whoami', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function test4_SingleHopIpResolution() {
  console.log('TEST 4: single-hop IP resolution matches the configured trust proxy value (offline, loopback only)...');

  // Extract the actual configured hop count from server.js so this test
  // tracks real production configuration rather than a hardcoded guess.
  const match = serverSrc.match(/app\.set\(\s*'trust proxy'\s*,\s*(\d+)\s*\)/);
  assert(match, 'Could not find a numeric trust proxy setting in server.js');
  const hopCount = Number(match[1]);

  // A minimal, isolated Express app exercising the real express/proxy-addr
  // trust-proxy resolution logic — not a reimplementation of it.
  const app = express();
  app.set('trust proxy', hopCount);
  app.get('/whoami', (req, res) => res.json({ ip: req.ip }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Vercel's edge (the one trusted hop) forwards the real client IP.
    const singleHop = await getJson(port, { 'X-Forwarded-For': '203.0.113.7' });
    assert.strictEqual(
      singleHop.ip,
      '203.0.113.7',
      'A single forwarded hop (the trusted proxy) must resolve as the client IP'
    );

    // A client trying to spoof an extra, earlier hop ahead of the trusted
    // proxy must NOT be believed — only the nearest (rightmost) hop counts.
    const spoofAttempt = await getJson(port, {
      'X-Forwarded-For': '198.51.100.9, 203.0.113.7'
    });
    assert.strictEqual(
      spoofAttempt.ip,
      '203.0.113.7',
      'Only the single trusted hop must be honored; a client-prepended extra hop must not be trusted as the client IP'
    );
  } finally {
    server.close();
  }

  console.log('  ✅ PASS');
}

async function runTests() {
  console.log('🛡️  Trust-proxy configuration tests (offline, loopback only)\n');
  test1_TrustProxySetToExactlyOne();
  test2_TrustProxySetBeforeRateLimitMiddleware();
  test3_TrustProxyTrueIsNotUsed();
  await test4_SingleHopIpResolution();
  console.log('\n✅ All trust-proxy tests passed!');
}

runTests();
