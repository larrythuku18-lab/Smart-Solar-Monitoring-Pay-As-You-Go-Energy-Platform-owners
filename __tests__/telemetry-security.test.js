/**
 * Tests for telemetry security: input validation and per-device rate limiting.
 * Spawns its own server process (same pattern as api.test.js) so it doesn't
 * collide with other test files or a manually-running instance.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/* Suppress email + SMS sends — same rationale as api.test.js */
process.env.RESEND_API_KEY = '';
process.env.AT_USERNAME = '';
process.env.AT_API_KEY = '';

const PORT = process.env.TEST_PORT_TELEMETRY || 3922;
const BASE = `http://localhost:${PORT}`;

let server;
let childOutput = '';

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe'
  });

  server.stdout.on('data', d => { childOutput += d; });
  server.stderr.on('data', d => { childOutput += d; });

  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Server did not become healthy in time. Output:\n${childOutput}`));
      /* 60s, not 20s: all test files run concurrently and each spawned server
         spends seconds of pure CPU in @babel/standalone before its first log
         line — under a loaded machine the 20s window starved (empty Output:
         above means exactly that). Polling exits early when healthy, so the
         extra headroom costs nothing on a quiet box. */
    }, 60_000);
    const tryHealth = async () => {
      if (settled) return;
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) { settled = true; clearTimeout(timeout); return resolve(); }
      } catch { /* not up yet */ }
      if (!settled) setTimeout(tryHealth, 400);
    };
    tryHealth();
  });
});

after(() => {
  server.kill('SIGKILL');
});

function telemetry(body, options = {}) {
  return fetch(`${BASE}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body)
  });
}

describe('telemetry input validation', () => {
  test('rejects telemetry with missing deviceId', async () => {
    const r = await telemetry({ voltage: 48, current: 3, generation: 144, battery: 80 });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.errors?.length > 0, 'validation errors must be returned');
  });

  test('rejects telemetry with empty deviceId', async () => {
    const r = await telemetry({ deviceId: '', voltage: 48 });
    assert.equal(r.status, 400);
  });

  test('rejects telemetry with non-numeric voltage', async () => {
    const r = await telemetry({ deviceId: 'TEST-001', voltage: 'high' });
    assert.equal(r.status, 400);
  });

  test('rejects telemetry with negative voltage', async () => {
    const r = await telemetry({ deviceId: 'TEST-001', voltage: -5 });
    assert.equal(r.status, 400);
  });

  test('rejects telemetry with battery over 100%', async () => {
    const r = await telemetry({ deviceId: 'TEST-001', battery: 150 });
    assert.equal(r.status, 400);
  });

  test('rejects telemetry with negative generation', async () => {
    const r = await telemetry({ deviceId: 'TEST-001', generation: -10 });
    assert.equal(r.status, 400);
  });

  test('rejects telemetry with non-numeric battery', async () => {
    const r = await telemetry({ deviceId: 'TEST-001', battery: 'full' });
    assert.equal(r.status, 400);
  });

  test('accepts valid minimal telemetry (deviceId only)', async () => {
    const r = await telemetry({ deviceId: 'VALID-MIN-001' });
    /* 200 = accepted (no auth key configured in test env), 400 = validation */
    assert.ok(r.status === 200 || r.status === 401,
      `expected 200 or 401, got ${r.status}`);
  });

  test('accepts valid telemetry with all optional numeric fields', async () => {
    const r = await telemetry({
      deviceId: 'VALID-FULL-001',
      voltage: 48.5,
      current: 3.2,
      generation: 154,
      battery: 67,
      consumption: 120
    });
    assert.ok(r.status === 200 || r.status === 401,
      `expected 200 or 401, got ${r.status}`);
  });

  test('accepts telemetry with battery at 0% (valid boundary)', async () => {
    const r = await telemetry({ deviceId: 'VALID-B0-001', battery: 0 });
    assert.ok(r.status === 200 || r.status === 401,
      `expected 200 or 401, got ${r.status}`);
  });

  test('accepts telemetry with battery at 100% (valid boundary)', async () => {
    const r = await telemetry({ deviceId: 'VALID-B100-001', battery: 100 });
    assert.ok(r.status === 200 || r.status === 401,
      `expected 200 or 401, got ${r.status}`);
  });

  test('rejects telemetry with string in numeric field', async () => {
    const r = await telemetry({ deviceId: 'TEST-STR-001', voltage: 'abc', current: 'xyz' });
    assert.equal(r.status, 400);
  });
});

describe('per-device rate limiting', () => {
  const RATE_LIMITED_DEVICE = `RATELIMIT-${Date.now()}`;

  /* The limiter sits BEHIND the X-Device-Key check (unauthenticated
     requests must not be able to burn a device's budget), so these tests
     authenticate with the shared env key when one is configured. */
  const authHeaders = process.env.DEVICE_API_KEY
    ? { 'X-Device-Key': process.env.DEVICE_API_KEY }
    : {};

  test('rate limiter allows up to 20 requests per minute per deviceId', async () => {
    /* Send 20 valid authenticated requests in quick succession — all should
       be accepted */
    const results = [];
    for (let i = 0; i < 20; i++) {
      const r = await telemetry({
        deviceId: RATE_LIMITED_DEVICE,
        voltage: 48,
        current: 3,
        generation: 144,
        battery: 80
      }, { headers: authHeaders });
      results.push(r.status);
    }

    /* All 20 should be HTTP 2xx or 401 (auth), never 429 */
    const rateLimited = results.filter(s => s === 429);
    assert.equal(rateLimited.length, 0,
      `${rateLimited.length} of 20 requests were rate-limited unexpectedly (429)`);

    /* All must succeed or be auth-failures */
    const ok = results.filter(s => s === 200 || s === 401);
    assert.equal(ok.length, 20,
      `${20 - ok.length} requests returned unexpected status codes: [${results.join(',')}]`);
  });

  test('the 21st request from the same deviceId within the same second is rate-limited', async () => {
    /* The rate limiter allows 20 per 60-second sliding window. After sending
       20 above, the 21st within the same window should get 429. */
    const r = await telemetry({
      deviceId: RATE_LIMITED_DEVICE,
      voltage: 48,
      current: 3,
      generation: 144,
      battery: 80
    }, { headers: authHeaders });
    assert.equal(r.status, 429,
      `expected 429 rate limit, got ${r.status}`);
    const body = await r.json();
    assert.ok(body.error, 'rate limit response must include an error message');
  });

  test('unauthenticated requests cannot consume a device\'s rate-limit budget', async () => {
    /* Only meaningful when a device key is configured: 21 key-less requests
       for a fresh deviceId must all be rejected as unauthorized (401), and
       none may reach the rate limiter (429) — otherwise an attacker who
       merely knows a deviceId could starve the real device. */
    if (!process.env.DEVICE_API_KEY) return; /* open-ingest mode: no auth to bypass */
    const SPOOFED_DEVICE = `SPOOF-${Date.now()}`;
    for (let i = 0; i < 21; i++) {
      const r = await telemetry({ deviceId: SPOOFED_DEVICE, voltage: 48 });
      assert.equal(r.status, 401,
        `key-less request ${i + 1} expected 401, got ${r.status}`);
    }
    /* The real device (with its key) must still have its full budget. */
    const legit = await telemetry({ deviceId: SPOOFED_DEVICE, voltage: 48 },
      { headers: authHeaders });
    assert.notEqual(legit.status, 429,
      'legitimate device was rate-limited by unauthenticated spoofed traffic');
  });

  test('different deviceIds are not affected by each other\'s rate limits', async () => {
    /* Another device on the same IP should not be rate-limited just because
       the first device exhausted its budget. */
    for (let i = 0; i < 5; i++) {
      const r = await telemetry({
        deviceId: `OTHER-DEV-${Date.now()}-${i}`,
        voltage: 48,
        current: 3,
        generation: 144,
        battery: 80
      }, { headers: authHeaders });
      assert.notEqual(r.status, 429,
        `unrelated device was rate-limited (attempt ${i + 1})`);
    }
  });
});
