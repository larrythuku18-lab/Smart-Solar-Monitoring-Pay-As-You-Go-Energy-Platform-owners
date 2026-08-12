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
// across the suite). If a developer's real .env has a live Resend key
// configured for manual testing, every one of those logins would otherwise
// fire a real email send — slow, spams the inbox, and can hang the test run
// if Resend rate-limits the rapid-fire sends. Tests should never hit a real
// external service regardless of what's configured for dev use.
//
// Set (not delete) — the spawned server.js child calls its own
// require('dotenv').config(), which only fills in keys that are *absent*.
// An empty string already counts as "set", so dotenv leaves it alone,
// keeping resendConfigured() false in the child too.
process.env.RESEND_API_KEY = '';

// Same guard for SMS — the spawned server's 15-min wallet cron could cross a
// quarter-hour boundary mid-run and fire real Africa's Talking sends if a
// developer's .env has live keys.
process.env.AT_USERNAME = '';
process.env.AT_API_KEY = '';

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
      /* 60s, not 20s — same rationale as telemetry-security.test.js: concurrent
         test files + @babel/standalone boot cost starve 20s on a loaded machine */
    }, 60_000);
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

/* Tokens are valid for 24h, so one login per role serves the whole suite.
   Memoized because every helper login counts against the server's
   authLimiter budget (20 auth requests / 15 min / IP) — with each test
   logging in fresh, the suite itself trips 429s once it grows past ~20
   auth-limited calls, which it did when the password-reset tests (whose
   forgot/reset endpoints share that limiter) were added. */
let _adminToken = null;
let _customerToken = null;

async function loginAdmin() {
  if (_adminToken) return _adminToken;
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
  _adminToken = body.token;
  return _adminToken;
}

async function loginCustomer() {
  if (_customerToken) return _customerToken;
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'DEMO-001', pin: '1234' })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `customer login failed: ${JSON.stringify(body)}`);
  _customerToken = body.token;
  return _customerToken;
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

  test('completes a real pending payment from a valid callback (idempotent on replay)', async () => {
    if (!process.env.MPESA_CALLBACK_SECRET) return;
    const db = require('../db');
    const crypto = require('node:crypto');
    const user = await db.createUser({ deviceId: `CB-TEST-${Date.now()}`, name: 'CB Test', role: 'customer' });
    const checkoutRequestId = `CB-${crypto.randomBytes(8).toString('hex')}`;
    await db.createPayment({ userId: user.id, deviceId: user.device_id, amount: 75, checkoutRequestId, paymentType: 'energy' });

    const callbackBody = (amount) => ({
      Body: { stkCallback: {
        MerchantRequestID: 'mr', CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: amount },
          { Name: 'MpesaReceiptNumber', Value: 'CB-RCPT-1' },
          { Name: 'PhoneNumber', Value: 254712345678 }
        ] }
      } }
    });

    /* First callback completes the payment. */
    const r1 = await fetch(`${BASE}/api/mpesa/callback?secret=${process.env.MPESA_CALLBACK_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackBody(75))
    });
    assert.equal(r1.status, 200);

    /* The handler processes async after the 200 — poll the DB row instead
       of sleeping a fixed duration (which flakes on slow machines). */
    const stored = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = await db.getPaymentByCheckoutId(checkoutRequestId);
        if (row?.status === 'completed') return row;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    })();
    assert.ok(stored, 'valid callback must complete the payment (timed out waiting)');
    assert.equal(stored.status, 'completed', 'valid callback must complete the payment');
    const wallet = await db.getUserById(user.id);
    assert.equal(Number(wallet.wallet_balance), 75, 'wallet credited once');

    /* Replay the same callback — must not double-credit. */
    const r2 = await fetch(`${BASE}/api/mpesa/callback?secret=${process.env.MPESA_CALLBACK_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackBody(75))
    });
    assert.equal(r2.status, 200);
    /* Give the async handler a beat to run the (no-op) second completion. */
    await new Promise(r => setTimeout(r, 150));
    const wallet2 = await db.getUserById(user.id);
    assert.equal(Number(wallet2.wallet_balance), 75, 'replayed callback must not double-credit');

    await db.pool.query('DELETE FROM payments WHERE checkout_request_id = $1', [checkoutRequestId]);
    await db.pool.query('DELETE FROM pending_commands WHERE device_id = $1', [user.device_id]);
    await db.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
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

describe('password reset flow', () => {
  test('forgot-password answers identically for known and unknown emails', async () => {
    const known = await fetch(`${BASE}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.CUSTOMER_EMAIL || 'customer@example.com' })
    });
    const unknown = await fetch(`${BASE}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nobody-${Date.now()}@example.com` })
    });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
  });

  test('a valid token resets the password; the token is then dead', async () => {
    // The raw token normally only exists in the reset email — plant one
    // directly (same as the route does) so the HTTP flow can be exercised
    // without a mailbox.
    const crypto = require('node:crypto');
    const bcrypt = require('bcrypt');
    const db = require('../db');

    const email = `reset-test-${Date.now()}@example.com`;
    const user = await db.createUser({
      deviceId: `RESET-${Date.now()}`, name: 'Reset Test', email,
      passwordHash: await bcrypt.hash('OldPass@123', 10), role: 'customer'
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await db.setPasswordResetToken(user.id, tokenHash, new Date(Date.now() + 60_000));

    const reset = await fetch(`${BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: 'NewPass@456' })
    });
    assert.equal(reset.status, 200);

    // New password logs in…
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'NewPass@456' })
    });
    assert.equal(login.status, 200);

    // …the old one doesn't, and the token can't be replayed.
    const oldLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'OldPass@123' })
    });
    assert.equal(oldLogin.status, 401);

    const replay = await fetch(`${BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: 'Another@789' })
    });
    assert.equal(replay.status, 400);
  });

  test('an expired token is rejected', async () => {
    const crypto = require('node:crypto');
    const bcrypt = require('bcrypt');
    const db = require('../db');

    const email = `expired-test-${Date.now()}@example.com`;
    const user = await db.createUser({
      deviceId: `EXPIRED-${Date.now()}`, name: 'Expired Test', email,
      passwordHash: await bcrypt.hash('OldPass@123', 10), role: 'customer'
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await db.setPasswordResetToken(user.id, tokenHash, new Date(Date.now() - 1000));

    const reset = await fetch(`${BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: 'NewPass@456' })
    });
    assert.equal(reset.status, 400);
  });
});

describe('device assignment', () => {
  test('assignment is admin-only', async () => {
    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/admin/devices/DEMO-001/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ email: 'x@example.com' })
    });
    assert.equal(r.status, 403);
  });

  test('an admin can assign a device to a customer by email, then unassign it', async () => {
    const bcrypt = require('bcrypt');
    const db = require('../db');
    const adminToken = await loginAdmin();

    const email = `assign-test-${Date.now()}@example.com`;
    const user = await db.createUser({
      deviceId: `OWNER-${Date.now()}`, name: 'Assign Test', email,
      passwordHash: await bcrypt.hash('SomePass@123', 10), role: 'customer'
    });
    const deviceId = `ASSIGN-${Date.now()}`;
    await db.provisionDevice(deviceId, 'Assignment test unit');

    const assign = await fetch(`${BASE}/api/admin/devices/${deviceId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email })
    });
    assert.equal(assign.status, 200);
    const assigned = await assign.json();
    assert.equal(assigned.device.user_id, user.id);
    assert.equal(assigned.owner.email, email);

    // Owner shows up in the fleet list
    const list = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { devices } = await list.json();
    assert.equal(devices.find(d => d.device_id === deviceId)?.owner_email, email);

    // Unassign with email: null
    const unassign = await fetch(`${BASE}/api/admin/devices/${deviceId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: null })
    });
    assert.equal(unassign.status, 200);
    assert.equal((await unassign.json()).device.user_id, null);
  });

  test('assigning to an unknown email 404s', async () => {
    const adminToken = await loginAdmin();
    const r = await fetch(`${BASE}/api/admin/devices/DEMO-001/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: `ghost-${Date.now()}@example.com` })
    });
    assert.equal(r.status, 404);
  });
});

describe('fleet management (regions + battery)', () => {
  test('provisioning accepts a region and the fleet list carries location + latest battery', async () => {
    const db = require('../db');
    const adminToken = await loginAdmin();
    const deviceId = `FLEET-${Date.now()}`;

    const prov = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId, name: 'Fleet test unit', location: 'Nakuru, Kenya' })
    });
    assert.equal(prov.status, 200);
    assert.equal((await prov.json()).device.location, 'Nakuru, Kenya');

    // Give it a low-battery reading; the fleet list must surface it
    await db.insertEnergyReading({
      deviceId, generation: 50, consumption: 90, batteryLevel: 11, voltage: 47.5, current: 6
    });

    const list = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { devices } = await list.json();
    const mine = devices.find(d => d.device_id === deviceId);
    assert.ok(mine, 'provisioned device missing from fleet list');
    assert.equal(mine.location, 'Nakuru, Kenya');
    assert.equal(Math.round(Number(mine.battery_level)), 11);
    assert.equal(typeof mine.online, 'boolean');
  });

  test('an admin can move a device between regions and clear the region', async () => {
    const adminToken = await loginAdmin();
    const deviceId = `REGION-${Date.now()}`;
    await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId, location: 'Eldoret, Kenya' })
    });

    const move = await fetch(`${BASE}/api/admin/devices/${deviceId}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ location: 'Kisumu, Kenya' })
    });
    assert.equal(move.status, 200);
    assert.equal((await move.json()).device.location, 'Kisumu, Kenya');

    const clear = await fetch(`${BASE}/api/admin/devices/${deviceId}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ location: null })
    });
    assert.equal(clear.status, 200);
    assert.equal((await clear.json()).device.location, null);
  });

  test('setting a region is admin-only', async () => {
    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/admin/devices/DEMO-001/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ location: 'Hacked, Kenya' })
    });
    assert.equal(r.status, 403);
  });
});

describe('firmware version reporting', () => {
  test('telemetry firmwareVersion is stored on the device and shown in the fleet list', async () => {
    const adminToken = await loginAdmin();
    const deviceId = `FW-${Date.now()}`;

    // Provision the device so it has its own key (mirrors the other device tests)
    const prov = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId })
    });
    assert.equal(prov.status, 200);
    const { device } = await prov.json();

    // Device reports telemetry carrying its running firmware version
    const tele = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': device.api_key },
      body: JSON.stringify({
        deviceId, voltage: 48, current: 2, generation: 96, battery: 70,
        firmwareVersion: '1.2.3'
      })
    });
    assert.equal(tele.status, 200);

    // The fleet list must surface it
    const list = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { devices } = await list.json();
    const mine = devices.find(d => d.device_id === deviceId);
    assert.ok(mine, 'provisioned device missing from fleet list');
    assert.equal(mine.firmware_version, '1.2.3');
  });

  test('a device that never reports firmwareVersion keeps it NULL in the fleet list', async () => {
    const adminToken = await loginAdmin();
    const deviceId = `FW-NULL-${Date.now()}`;
    const prov = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId })
    });
    assert.equal(prov.status, 200);

    // Telemetry WITHOUT firmwareVersion (e.g. an older build)
    const tele = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, voltage: 48, current: 2, generation: 96, battery: 70 })
    });
    assert.ok(tele.status === 200 || tele.status === 401,
      `expected 200 or 401, got ${tele.status}`);

    const list = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { devices } = await list.json();
    const mine = devices.find(d => d.device_id === deviceId);
    assert.ok(mine, 'provisioned device missing from fleet list');
    assert.equal(mine.firmware_version, null);
  });

  test('a later telemetry without firmwareVersion does not wipe the stored version', async () => {
    const adminToken = await loginAdmin();
    const deviceId = `FW-KEEP-${Date.now()}`;
    const prov = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId })
    });
    const { device } = await prov.json();
    const headers = { 'Content-Type': 'application/json', 'X-Device-Key': device.api_key };

    // First reports 1.2.3
    const first = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST', headers,
      body: JSON.stringify({ deviceId, voltage: 48, firmwareVersion: '1.2.3' })
    });
    assert.equal(first.status, 200);

    // Later telemetry omits it entirely (build stopped sending it)
    const second = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST', headers,
      body: JSON.stringify({ deviceId, voltage: 48 })
    });
    assert.equal(second.status, 200);

    const list = await fetch(`${BASE}/api/admin/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { devices } = await list.json();
    const mine = devices.find(d => d.device_id === deviceId);
    assert.equal(mine.firmware_version, '1.2.3',
      'omitting firmwareVersion on a later heartbeat must not clear the stored version');
  });
});
