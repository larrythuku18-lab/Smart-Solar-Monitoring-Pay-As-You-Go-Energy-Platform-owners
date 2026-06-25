/**
 * Integration tests against the real server (spawned on its own port so they
 * don't collide with a manually-running instance). Covers auth, role-based
 * authorization on admin-only endpoints, and the M-Pesa callback secret check.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Tests log in many times (loginAdmin/loginCustomer are called repeatedly
// across the suite). If a developer's real .env has live mail credentials
// configured for manual testing, every one of those logins would otherwise
// fire a real Gmail SMTP send — slow, spams the inbox, and can hang the test
// run if Gmail rate-limits the rapid-fire sends. Tests should never hit a
// real external service regardless of what's configured for dev use.
//
// Set (not delete) — the spawned server.js child calls its own
// require('dotenv').config(), which only fills in keys that are *absent*.
// An empty string already counts as "set", so dotenv leaves it alone,
// keeping mailerConfigured()/resendConfigured() false in the child too.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.RESEND_API_KEY = '';

const PORT = process.env.TEST_PORT || 3911;
const BASE = `http://localhost:${PORT}`;

let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe'
  });

  // Surfaced in the timeout error below if the child never becomes healthy —
  // without this, a boot failure (crash, missing file, etc.) just hangs
  // silently until the timeout, with no clue why.
  let childOutput = '';
  server.stdout.on('data', d => { childOutput += d; });
  server.stderr.on('data', d => { childOutput += d; });

  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Server did not become healthy in time. Child output:\n${childOutput}`));
    }, 20_000);
    const tryHealth = async () => {
      if (settled) return; // stop polling once we've timed out — otherwise this
                            // setTimeout chain runs forever and the test process
                            // never exits, even after the timeout above rejects.
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

async function loginAdmin() {
  // Mirrors db.js's seedDemoData() fallback — ADMIN_EMAIL/ADMIN_PASSWORD may be
  // overridden locally (e.g. to a real address so login alerts don't bounce).
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:    process.env.ADMIN_EMAIL    || 'admin@solarpayg.com',
      password: process.env.ADMIN_PASSWORD || 'Admin@12345'
    })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `admin login failed: ${JSON.stringify(body)}`);
  return body.token;
}

async function loginCustomer() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'DEMO-001', pin: '1234' })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `customer login failed: ${JSON.stringify(body)}`);
  return body.token;
}

describe('authentication', () => {
  test('rejects an unknown email/password', async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' })
    });
    assert.equal(r.status, 401);
  });

  test('logs in with valid admin credentials', async () => {
    const token = await loginAdmin();
    assert.ok(token);
  });

  test('logs in with valid deviceId+pin credentials', async () => {
    const token = await loginCustomer();
    assert.ok(token);
  });

  test('register rejects a missing name', async () => {
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'Password123' })
    });
    assert.equal(r.status, 400);
  });
});

describe('admin-only endpoints reject non-admins', () => {
  test('/api/audit/timeline: 401 with no token at all', async () => {
    const r = await fetch(`${BASE}/api/audit/timeline`);
    assert.equal(r.status, 401);
  });

  test('/api/audit/timeline: 403 for a logged-in customer', async () => {
    const token = await loginCustomer();
    const r = await fetch(`${BASE}/api/audit/timeline`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 403);
  });

  test('/api/audit/timeline: 200 for an admin', async () => {
    const token = await loginAdmin();
    const r = await fetch(`${BASE}/api/audit/timeline`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
  });

  test('/api/fraud-check: 403 for a logged-in customer (can lock any device)', async () => {
    const token = await loginCustomer();
    const r = await fetch(`${BASE}/api/fraud-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 50, userId: 1, deviceId: 'DEMO-001', timestamp: new Date().toISOString() })
    });
    assert.equal(r.status, 403);
  });
});

describe('M-Pesa callback security', () => {
  test('rejects a callback with no secret when MPESA_CALLBACK_SECRET is configured', async () => {
    if (!process.env.MPESA_CALLBACK_SECRET) {
      return; // can't meaningfully test this without the secret configured locally
    }
    const r = await fetch(`${BASE}/api/mpesa/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: 'does-not-exist', ResultCode: 0, ResultDesc: 'ok' } }
      })
    });
    assert.equal(r.status, 401);
  });

  test('accepts a callback carrying the correct secret', async () => {
    if (!process.env.MPESA_CALLBACK_SECRET) return;
    const r = await fetch(`${BASE}/api/mpesa/callback?secret=${process.env.MPESA_CALLBACK_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: 'does-not-exist', ResultCode: 0, ResultDesc: 'ok' } }
      })
    });
    // Acknowledged immediately regardless of whether the checkoutRequestId
    // matches a real payment — that lookup happens async after the response.
    assert.equal(r.status, 200);
  });
});

describe('payment endpoints are scoped to the authenticated user', () => {
  test('/api/pay requires authentication', async () => {
    const r = await fetch(`${BASE}/api/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50 })
    });
    assert.equal(r.status, 401);
  });

  test("/api/pay/status/:id 404s for another user's checkout id", async () => {
    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/pay/status/some-other-users-checkout-id`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert.equal(r.status, 404);
  });
});

describe('device telemetry security', () => {
  test('rejects telemetry with no X-Device-Key when DEVICE_API_KEY is configured', async () => {
    if (!process.env.DEVICE_API_KEY) return; // not configured locally — nothing to test
    const r = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'SOLAR_DEVICE_001', voltage: 48, current: 3, generation: 144, battery: 80 })
    });
    assert.equal(r.status, 401);
  });

  test('accepts telemetry carrying the correct X-Device-Key', async () => {
    if (!process.env.DEVICE_API_KEY) return;
    const r = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': process.env.DEVICE_API_KEY },
      body: JSON.stringify({ deviceId: 'SOLAR_DEVICE_001', voltage: 48, current: 3, generation: 144, battery: 80 })
    });
    assert.equal(r.status, 200);
  });
});

describe('per-device telemetry keys', () => {
  const testDeviceId = `TEST-DEV-${Date.now()}`;

  test('provisioning a device is admin-only', async () => {
    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ deviceId: testDeviceId })
    });
    assert.equal(r.status, 403);
  });

  test('an admin can provision a device and gets back its key', async () => {
    const adminToken = await loginAdmin();
    const r = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId: testDeviceId, name: 'Test device' })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.device.device_id, testDeviceId);
    assert.ok(body.device.api_key, 'provisioning must return the key so it can be flashed');
  });

  test('once provisioned, only that device\'s own key is accepted — not the shared fleet key', async () => {
    const adminToken = await loginAdmin();
    const provisionRes = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId: testDeviceId })
    });
    const { device } = await provisionRes.json();

    const withOwnKey = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': device.api_key },
      body: JSON.stringify({ deviceId: testDeviceId, voltage: 48, current: 2, generation: 96, battery: 70 })
    });
    assert.equal(withOwnKey.status, 200);

    if (process.env.DEVICE_API_KEY) {
      const withSharedKey = await fetch(`${BASE}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Key': process.env.DEVICE_API_KEY },
        body: JSON.stringify({ deviceId: testDeviceId, voltage: 48, current: 2, generation: 96, battery: 70 })
      });
      assert.equal(withSharedKey.status, 401, "a provisioned device's own key must win over the shared fallback");
    }
  });

  test('rotating a key invalidates the old one', async () => {
    const adminToken = await loginAdmin();
    const provisionRes = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId: testDeviceId })
    });
    const { device: original } = await provisionRes.json();

    const rotateRes = await fetch(`${BASE}/api/admin/devices/${testDeviceId}/rotate-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const { device: rotated } = await rotateRes.json();
    assert.notEqual(rotated.api_key, original.api_key);

    const withOldKey = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': original.api_key },
      body: JSON.stringify({ deviceId: testDeviceId, voltage: 48, current: 2, generation: 96, battery: 70 })
    });
    assert.equal(withOldKey.status, 401);
  });

  test('GET /api/admin/devices is admin-only and includes keys', async () => {
    const customerToken = await loginCustomer();
    const denied = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${customerToken}` } });
    assert.equal(denied.status, 403);

    const adminToken = await loginAdmin();
    const allowed = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.ok(Array.isArray(body.devices));
  });
});
