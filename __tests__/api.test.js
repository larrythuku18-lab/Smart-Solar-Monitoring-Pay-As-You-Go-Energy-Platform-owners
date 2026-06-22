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

const PORT = process.env.TEST_PORT || 3911;
const BASE = `http://localhost:${PORT}`;

let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe'
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not become healthy in time')), 20_000);
    const tryHealth = async () => {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) { clearTimeout(timeout); return resolve(); }
      } catch { /* not up yet */ }
      setTimeout(tryHealth, 400);
    };
    tryHealth();
  });
});

after(() => {
  server.kill('SIGKILL');
});

async function loginAdmin() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@solarpayg.com', password: 'Admin@12345' })
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
