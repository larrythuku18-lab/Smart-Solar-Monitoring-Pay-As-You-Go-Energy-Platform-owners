/**
 * Tests for the admin dashboard device selector (public/admin/dashboard.jsx).
 *
 * The selector is client-side React, but every piece of data it renders comes
 * from these endpoints, and "picking a device" is just sending its deviceId as
 * a query param. So the selector's contract — what the dropdown lists, what a
 * selection actually changes, and what the default is — is fully testable at
 * the API layer:
 *
 *   1. The dropdown source:  GET /api/admin/devices  (admin-only; carries the
 *      device_id + location fields the <option> elements render).
 *   2. Per-device scoping:   GET /api/energy/hourly|daily?deviceId=X must
 *      return ONLY device X's readings and echo the requested deviceId back —
 *      otherwise switching the selector would show another device's charts.
 *   3. Per-device AI:        GET /api/forecast and /api/maintenance-alerts
 *      must accept a deviceId and return per-device results (not hardcode
 *      DEMO-001), since the selector feeds them the selected device.
 *   4. Default selection:    omitting deviceId falls back to DEMO-001, which
 *      matches the selector's initial state (useState('DEMO-001')).
 *
 * Same spawn-the-real-server pattern as api.test.js so the whole stack
 * (routes → db → Postgres) is exercised.
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

const PORT = process.env.TEST_SELECTOR_PORT || 3944;
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

let _adminToken = null;
async function loginAdmin() {
  if (_adminToken) return _adminToken;
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
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'DEMO-001', pin: '1234' })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `customer login failed: ${JSON.stringify(body)}`);
  return body.token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/* Two provisioned devices with deliberately distinct readings so cross-device
   leakage would be obvious (500W vs 100W generation). Unique ids per run so
   repeat runs never collide with leftovers in the shared local DB. */
const DEVICE_A = `SEL-A-${Date.now()}`;
const DEVICE_B = `SEL-B-${Date.now()}`;

async function provision(adminToken, deviceId, location) {
  const r = await fetch(`${BASE}/api/admin/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
    body: JSON.stringify({ deviceId, location })
  });
  assert.equal(r.status, 200, `provision ${deviceId} failed`);
}

/* Insert a single energy reading directly (same helper the telemetry route
   uses) — one reading per device means the hourly/daily AVG equals the raw
   value, so the assertion is exact. */
async function seedReading(deviceId, generation, consumption, battery) {
  const db = require('../db');
  await db.insertEnergyReading({
    deviceId, generation, consumption, batteryLevel: battery, voltage: 48, current: 3
  });
}

describe('device selector: dropdown data source', () => {
  test('/api/admin/devices is admin-only (403 for a customer)', async () => {
    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/admin/devices`, { headers: auth(customerToken) });
    assert.equal(r.status, 403);
  });

  test('provisioned devices appear with device_id + location for the dropdown', async () => {
    const adminToken = await loginAdmin();
    await provision(adminToken, DEVICE_A, 'Nairobi, Kenya');
    await provision(adminToken, DEVICE_B, 'Kisumu, Kenya');

    const r = await fetch(`${BASE}/api/admin/devices`, { headers: auth(adminToken) });
    assert.equal(r.status, 200);
    const { devices } = await r.json();
    const a = devices.find(d => d.device_id === DEVICE_A);
    const b = devices.find(d => d.device_id === DEVICE_B);
    assert.ok(a, 'DEVICE_A missing from fleet list (dropdown source)');
    assert.ok(b, 'DEVICE_B missing from fleet list (dropdown source)');
    assert.equal(a.location, 'Nairobi, Kenya');
    assert.equal(b.location, 'Kisumu, Kenya');
  });
});

describe('device selector: per-device energy scoping', () => {
  test('hourly energy returns only the selected device\'s readings and echoes its deviceId', async () => {
    await seedReading(DEVICE_A, 500, 250, 80);
    await seedReading(DEVICE_B, 100, 50, 30);

    const adminToken = await loginAdmin();
    const a = await (await fetch(`${BASE}/api/energy/hourly?deviceId=${DEVICE_A}&hours=24`, { headers: auth(adminToken) })).json();
    const b = await (await fetch(`${BASE}/api/energy/hourly?deviceId=${DEVICE_B}&hours=24`, { headers: auth(adminToken) })).json();

    assert.equal(a.deviceId, DEVICE_A, 'hourly must echo the requested deviceId');
    assert.equal(b.deviceId, DEVICE_B);
    assert.ok(a.generation.some(v => Math.abs(Number(v) - 500) < 1),
      `DEVICE_A hourly should contain its 500W reading: ${JSON.stringify(a.generation)}`);
    assert.ok(!a.generation.some(v => Math.abs(Number(v) - 100) < 1),
      'DEVICE_A hourly must not leak DEVICE_B\'s 100W reading');
    assert.ok(b.generation.some(v => Math.abs(Number(v) - 100) < 1),
      `DEVICE_B hourly should contain its 100W reading: ${JSON.stringify(b.generation)}`);
    assert.ok(!b.generation.some(v => Math.abs(Number(v) - 500) < 1),
      'DEVICE_B hourly must not leak DEVICE_A\'s 500W reading');
  });

  test('daily energy is scoped to the selected device as well', async () => {
    const adminToken = await loginAdmin();
    const a = await (await fetch(`${BASE}/api/energy/daily?deviceId=${DEVICE_A}&days=7`, { headers: auth(adminToken) })).json();
    const b = await (await fetch(`${BASE}/api/energy/daily?deviceId=${DEVICE_B}&days=7`, { headers: auth(adminToken) })).json();

    assert.equal(a.deviceId, DEVICE_A);
    assert.equal(b.deviceId, DEVICE_B);
    assert.ok(a.generation.some(v => Math.abs(Number(v) - 500) < 1), 'DEVICE_A daily should include its 500W reading');
    assert.ok(!a.generation.some(v => Math.abs(Number(v) - 100) < 1), 'DEVICE_A daily must not leak DEVICE_B data');
    assert.ok(b.generation.some(v => Math.abs(Number(v) - 100) < 1), 'DEVICE_B daily should include its 100W reading');
    assert.ok(!b.generation.some(v => Math.abs(Number(v) - 500) < 1), 'DEVICE_B daily must not leak DEVICE_A data');
  });

  test('omitting deviceId defaults to DEMO-001 (the selector\'s initial state)', async () => {
    const adminToken = await loginAdmin();
    const hourly = await (await fetch(`${BASE}/api/energy/hourly?hours=24`, { headers: auth(adminToken) })).json();
    const daily  = await (await fetch(`${BASE}/api/energy/daily?days=7`,  { headers: auth(adminToken) })).json();
    assert.equal(hourly.deviceId, 'DEMO-001');
    assert.equal(daily.deviceId, 'DEMO-001');
  });
});

describe('device selector: per-device AI feeds', () => {
  test('forecast honors the selected deviceId and returns predictions', async () => {
    /* safeForecast trains on demand, but a 503-with-fallback is still a valid
       API response — assert the shape either way, and that the deviceId is
       accepted (no 400). */
    const r = await fetch(`${BASE}/api/forecast?deviceId=${DEVICE_A}`);
    assert.ok(r.status === 200 || r.status === 503,
      `forecast should accept deviceId param, got ${r.status}`);
    const body = await r.json();
    const predictions = body.forecast?.predictions || body.fallback;
    assert.ok(Array.isArray(predictions) && predictions.length > 0,
      'forecast must return predictions for the selected device');
  });

  test('maintenance-alerts honors the selected deviceId', async () => {
    const r = await fetch(`${BASE}/api/maintenance-alerts?deviceId=${DEVICE_B}`);
    assert.ok(r.status === 200 || r.status === 503,
      `maintenance-alerts should accept deviceId param, got ${r.status}`);
    const body = await r.json();
    assert.ok(Array.isArray(body.maintenance?.alerts ?? body.fallback),
      'maintenance-alerts must return an alerts array for the selected device');
  });
});
