/**
 * Engineer panel tests — the 'engineer' role and its read-only technical
 * diagnostics surface.
 *
 * Covers:
 *   1. Role gates: /api/engineer/* 403s for customers AND admins (engineers
 *      are the only role with access — admins have the admin dashboard).
 *   2. Account creation: a super-admin can mint an engineer via
 *      POST /api/admin/admins with role:'engineer'; engineers log in and
 *      the JWT carries the role.
 *   3. Fleet + device detail: engineers read connectivity, panel health,
 *      and firmware/OTA state for the whole fleet.
 *   4. No admin surface: engineers are 403'd on admin-only routes
 *      (payments stats, admin device list).
 *   5. panelType telemetry is stored and surfaces on the fleet.
 *
 * Same spawn pattern as api.test.js / ota.test.js: a real server on its own
 * port, with external senders disabled so tests never touch real services.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

process.env.RESEND_API_KEY = '';
process.env.AT_USERNAME = '';
process.env.AT_API_KEY = '';

const PORT = process.env.ENGINEER_TEST_PORT || 4417;
const BASE = `http://localhost:${PORT}`;

let server;
let _adminToken;
let _engineerToken;
let _customerToken;

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

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

/* Unique email per run so repeat runs against the shared local DB never
   collide on the users.email UNIQUE constraint. */
const ENGINEER_EMAIL = `engineer-${Date.now().toString(36)}@example.com`;
const ENGINEER_PASSWORD = 'Engineer@12345';

async function loginEngineer() {
  if (_engineerToken) return _engineerToken;
  /* Mint the account as the super-admin (the only role that can). */
  const adminToken = await loginAdmin();
  const create = await fetch(`${BASE}/api/admin/admins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
    body: JSON.stringify({
      name:     'Test Engineer',
      email:    ENGINEER_EMAIL,
      password: ENGINEER_PASSWORD,
      role:     'engineer'
    })
  });
  const created = await create.json().catch(() => ({}));
  assert.equal(create.status, 201, `engineer account creation failed: ${JSON.stringify(created)}`);

  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ENGINEER_EMAIL, password: ENGINEER_PASSWORD })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `engineer login failed: ${JSON.stringify(body)}`);
  assert.equal(body.user.role, 'engineer', 'JWT must carry role engineer');
  _engineerToken = body.token;
  return _engineerToken;
}

async function provisionTestDevice() {
  const adminToken = await loginAdmin();
  const deviceId = `ENG-DEV-${Date.now()}`;
  const r = await fetch(`${BASE}/api/admin/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
    body: JSON.stringify({ deviceId })
  });
  assert.equal(r.status, 200, 'device provisioning failed');
  const { device } = await r.json();
  return { deviceId, key: device.api_key };
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe'
  });

  let childOutput = '';
  server.stdout.on('data', d => { childOutput += d; });
  server.stderr.on('data', d => { childOutput += d; });

  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Server did not become healthy in time. Child output:\n${childOutput}`));
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

describe('engineer role gates', () => {
  test('/api/engineer/fleet 403 for customers', async () => {
    const token = await loginCustomer();
    const r = await fetch(`${BASE}/api/engineer/fleet`, { headers: auth(token) });
    assert.equal(r.status, 403, 'customers must never see the engineer fleet');
  });

  test('/api/engineer/fleet 403 for admins (they have the admin dashboard)', async () => {
    const token = await loginAdmin();
    const r = await fetch(`${BASE}/api/engineer/fleet`, { headers: auth(token) });
    assert.equal(r.status, 403, 'admins are not engineers — 403 expected');
  });

  test('/api/engineer/fleet 401 without a token', async () => {
    const r = await fetch(`${BASE}/api/engineer/fleet`);
    assert.equal(r.status, 401);
  });
});

describe('engineer account lifecycle', () => {
  test('super-admin creates an engineer; engineer logs in', async () => {
    const token = await loginEngineer();
    assert.ok(token);
  });

  test('the seeded demo engineer account logs in out of the box', async () => {
    /* seedDemoData() creates engineer@solarpayg.com / Engineer@12345 on
       every boot — the account a human tester uses to open the panel. */
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    process.env.ENGINEER_EMAIL    || 'engineer@solarpayg.com',
        password: process.env.ENGINEER_PASSWORD || 'Engineer@12345'
      })
    });
    const body = await r.json();
    assert.equal(r.status, 200, `seeded engineer login failed: ${JSON.stringify(body)}`);
    assert.equal(body.user.role, 'engineer', 'seeded account must carry role engineer');

    /* And that token can actually open the panel's data feed. */
    const fleet = await fetch(`${BASE}/api/engineer/fleet`, { headers: auth(body.token) });
    assert.equal(fleet.status, 200, 'seeded engineer must reach /api/engineer/fleet');
  });

  test('an org admin cannot create an engineer (privilege escalation)', async () => {
    /* Only super-admins may mint privileged accounts. An org admin trying
       role:'engineer' must be 403'd before any account is created. */
    const adminToken = await loginAdmin();
    /* Create a throwaway org admin account first, then attempt with it. */
    const email = `notsuper-${Date.now().toString(36)}@example.com`;
    const create = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
      body: JSON.stringify({
        name: 'Escalation Try', email,
        password: 'OrgAdmin@12345', role: 'org_admin',
        organizationId: 1
      })
    });
    assert.equal(create.status, 201, 'setup: org admin creation failed');

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'OrgAdmin@12345' })
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200);
    const attempt = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(loginBody.token) },
      body: JSON.stringify({
        name: 'Engineer Escalation',
        email: `escalate-${Date.now().toString(36)}@example.com`,
        password: 'Engineer@12345',
        role: 'engineer'
      })
    });
    assert.equal(attempt.status, 403, 'org admins must not create engineers');
  });
});

describe('engineer diagnostics surface', () => {
  test('engineer reads the fleet with connectivity + panel + firmware fields', async () => {
    const token = await loginEngineer();
    const r = await fetch(`${BASE}/api/engineer/fleet`, { headers: auth(token) });
    assert.equal(r.status, 200);
    const { fleet } = await r.json();
    assert.ok(Array.isArray(fleet), 'fleet must be an array');
    /* The demo device DEMO-001 is seeded by seedDemoData() and reports
       telemetry, so it must appear with the technical fields populated. */
    const demo = fleet.find(d => d.device_id === 'DEMO-001');
    assert.ok(demo, 'DEMO-001 must be in the fleet (seeded demo unit)');
    for (const key of ['online', 'device_ip', 'last_seen', 'firmware_version',
                       'battery_level', 'voltage', 'generation_watts',
                       'avg_interval_s', 'gap_count', 'ota_target', 'org_name']) {
      assert.ok(key in demo, `fleet row must carry ${key}`);
    }
  });

  test('engineer reads a specific device + its boot reports', async () => {
    const token = await loginEngineer();
    const { deviceId } = await provisionTestDevice();
    const r = await fetch(`${BASE}/api/engineer/devices/${deviceId}`, { headers: auth(token) });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.device.device_id, deviceId);
    assert.ok(Array.isArray(data.readings));
    assert.ok(Array.isArray(data.bootReports), 'bootReports must be an array');
  });

  test('engineer device detail 404s for an unknown device', async () => {
    const token = await loginEngineer();
    const r = await fetch(`${BASE}/api/engineer/devices/NO-SUCH-DEVICE-${Date.now()}`, { headers: auth(token) });
    assert.equal(r.status, 404);
  });

  test('panelType from telemetry is stored and surfaces on the fleet', async () => {
    const token = await loginEngineer();
    const { deviceId, key } = await provisionTestDevice();
    /* Post telemetry with a panelType — the firmware does this on every
       heartbeat (see buildTelemetryJSON in esp32-firmware.ino). */
    const tel = await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, 'X-Device-Key': key },
      body: JSON.stringify({
        deviceId, panelType: 'MONO-330W',
        voltage: 48.2, current: 3.5, generation: 168, battery: 82, consumption: 100
      })
    });
    assert.equal(tel.status, 200, 'telemetry with panelType must be accepted');

    const r = await fetch(`${BASE}/api/engineer/fleet`, { headers: auth(token) });
    const { fleet } = await r.json();
    const row = fleet.find(d => d.device_id === deviceId);
    assert.ok(row, 'provisioned device must appear in the fleet');
    assert.equal(row.panel_type, 'MONO-330W', 'panel_type must be stored from telemetry');
    assert.ok(Number(row.voltage) > 0, 'latest voltage should be populated');
  });
});

describe('engineers have no admin surface', () => {
  test('/api/payments/stats 403 for engineers', async () => {
    const token = await loginEngineer();
    const r = await fetch(`${BASE}/api/payments/stats`, { headers: auth(token) });
    assert.equal(r.status, 403, 'engineers must not see payment aggregates');
  });

  test('/api/admin/devices 403 for engineers', async () => {
    const token = await loginEngineer();
    const r = await fetch(`${BASE}/api/admin/devices`, { headers: auth(token) });
    assert.equal(r.status, 403, 'engineers must not manage the device fleet');
  });

  test('engineers cannot provision devices', async () => {
    const token = await loginEngineer();
    const r = await fetch(`${BASE}/api/admin/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(token) },
      body: JSON.stringify({ deviceId: `ENG-BLOCKED-${Date.now()}` })
    });
    assert.equal(r.status, 403, 'engineers must not provision devices');
  });
});
