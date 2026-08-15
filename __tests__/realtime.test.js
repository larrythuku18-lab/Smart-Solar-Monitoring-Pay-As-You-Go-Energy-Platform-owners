/**
 * Realtime SSE feed tests (/api/live + realtime.js broadcasts).
 *
 * Covers:
 *   1. Auth gates — 401 without a token, 403 for customers (staff only).
 *   2. Snapshot — the first frame on connect carries recent events +
 *      online-device counts scoped to the caller's org.
 *   3. Live delivery — a telemetry POST surfaces as a `reading` event on
 *      connected boards the moment it lands.
 *   4. Org scoping — an org admin receives their own org's device readings
 *      but never another tenant's (e.g. the default org's DEMO-001).
 *
 * Same spawn pattern as engineer.test.js: a real server on its own port
 * with external senders disabled.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

process.env.RESEND_API_KEY = '';
process.env.AT_USERNAME = '';
process.env.AT_API_KEY = '';

const PORT = process.env.REALTIME_TEST_PORT || 4423;
const BASE = `http://localhost:${PORT}`;

let server;
let _adminToken;
let orgBDevice = null;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function loginAdmin() {
  if (_adminToken) return _adminToken;
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL || 'admin@solarpayg.com',
      password: process.env.ADMIN_PASSWORD || 'Admin@12345'
    })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `admin login failed: ${JSON.stringify(body)}`);
  _adminToken = body.token;
  return _adminToken;
}

/* Parse one SSE frame → { event, data } or null for keep-alives. */
function parseFrame(frame) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

/* Read SSE frames from an open response until `predicate(events)` is true
   or the timeout elapses. Returns the collected events. */
async function collectUntil(res, predicate, timeoutMs = 8000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const timer = setTimeout(() => { reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) {
          events.push(ev);
          if (predicate(events)) return events;
        }
      }
    }
  } catch { /* cancelled by the timer */ } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return events;
}

async function openLive(token) {
  const res = await fetch(`${BASE}/api/live`, { headers: auth(token) });
  return res;
}

async function postTelemetry(deviceId, key, extra = {}) {
  const r = await fetch(`${BASE}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, 'X-Device-Key': key },
    body: JSON.stringify({
      deviceId,
      voltage: 48.2, current: 3.5, generation: 168, battery: 82, consumption: 100,
      ...extra
    })
  });
  assert.equal(r.status, 200, `telemetry for ${deviceId} failed: ${await r.text()}`);
}

const db = require('../db');

let orgBId = null;
let orgAdminEmail = null;
const cleanup = [];

before(async () => {
  await db.runMigrations();
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

  /* Tenant fixture: a second org with its own device, so org scoping can be
     tested against the default org's DEMO-001. */
  const suffix = Date.now().toString(36);
  const org = await db.createOrganization({ name: `Live Test Org ${suffix}`, slug: `live-${suffix}` });
  orgBId = org.id;
  orgAdminEmail = `live-orgadmin-${suffix}@example.com`;
  await db.createUser({
    deviceId: `LIVE-UA-${suffix}`,
    name: 'Live Org Admin',
    email: orgAdminEmail,
    passwordHash: await require('bcrypt').hash('OrgAdmin@12345', 4),
    pin: '0000',
    role: 'org_admin',
    organizationId: orgBId
  });
  const devB = await db.provisionDevice(`LIVE-B-${suffix}`, 'Org B Unit', 'Mombasa, Kenya');
  await db.pool.query('UPDATE devices SET organization_id = $1 WHERE device_id = $2', [orgBId, devB.device_id]);
  cleanup.push(
    ['DELETE FROM energy_readings WHERE device_id = $1', [devB.device_id]],
    ['DELETE FROM devices WHERE device_id = $1', [devB.device_id]],
    ['DELETE FROM users WHERE email = $1', [orgAdminEmail]],
    ['DELETE FROM organizations WHERE id = $1', [orgBId]]
  );
  /* Remember the org-B device key for telemetry posts. */
  orgBDevice = { deviceId: devB.device_id, key: devB.api_key };
});

after(async () => {
  server?.kill('SIGKILL');
  for (const [sql, params] of cleanup) {
    try { await db.pool.query(sql, params); } catch { /* best-effort */ }
  }
  await db.pool.end();
});

describe('realtime auth gates', () => {
  test('/api/live 401 without a token', async () => {
    const r = await fetch(`${BASE}/api/live`);
    assert.equal(r.status, 401);
  });

  test('/api/live 403 for customers (staff only)', async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'DEMO-001', pin: '1234' })
    });
    const body = await login.json();
    assert.equal(login.status, 200);
    const r = await fetch(`${BASE}/api/live`, { headers: auth(body.token) });
    assert.equal(r.status, 403);
  });
});

describe('realtime live delivery', () => {
  test('snapshot frame arrives first with recent events + online count', async () => {
    const token = await loginAdmin();
    const res = await openLive(token);
    const events = await collectUntil(res, evs => evs[0]?.event === 'snapshot');
    assert.equal(events[0].event, 'snapshot');
    assert.ok(Array.isArray(events[0].data.onlineDevices), 'snapshot carries onlineDevices');
    assert.equal(typeof events[0].data.onlineCount, 'number');
    assert.ok(Array.isArray(events[0].data.ring), 'snapshot carries the event ring');
  });

  test('a telemetry POST surfaces as a live reading event for admins', async () => {
    const token = await loginAdmin();
    const res = await openLive(token);
    const deviceId = `LIVE-ADM-${Date.now()}`;
    const dev = await db.provisionDevice(deviceId, 'Admin Live Unit', 'Nairobi, Kenya');
    cleanup.push(
      ['DELETE FROM energy_readings WHERE device_id = $1', [deviceId]],
      ['DELETE FROM devices WHERE device_id = $1', [deviceId]]
    );
    const readingPromise = collectUntil(
      res,
      evs => evs.some(e => e.event === 'reading' && e.data.deviceId === deviceId)
    );
    await postTelemetry(deviceId, dev.api_key);
    const events = await readingPromise;
    const reading = events.find(e => e.event === 'reading' && e.data.deviceId === deviceId);
    assert.ok(reading, 'admin must receive the live reading event');
    assert.equal(Number(reading.data.generation_watts), 168);
    assert.equal(Number(reading.data.voltage), 48.2);
    assert.equal(Number(reading.data.battery_level), 82);
  });

  test('heartbeats are broadcast too (firmware/panel metadata ride along)', async () => {
    const token = await loginAdmin();
    const res = await openLive(token);
    const deviceId = `LIVE-HB-${Date.now()}`;
    const dev = await db.provisionDevice(deviceId, 'HB Unit', 'Kisumu, Kenya');
    cleanup.push(
      ['DELETE FROM devices WHERE device_id = $1', [deviceId]]
    );
    const hbPromise = collectUntil(
      res,
      evs => evs.some(e => e.event === 'heartbeat' && e.data.deviceId === deviceId)
    );
    await postTelemetry(deviceId, dev.api_key, { firmwareVersion: '1.2.0', panelType: 'MONO-330W' });
    const events = await hbPromise;
    const hb = events.find(e => e.event === 'heartbeat' && e.data.deviceId === deviceId);
    assert.ok(hb, 'admin must receive the heartbeat event');
    assert.equal(hb.data.online, true);
    assert.equal(hb.data.firmware_version, '1.2.0');
    assert.equal(hb.data.panel_type, 'MONO-330W');
  });
});

describe('realtime org scoping', () => {
  test('org admins only receive their own org\'s device events', async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: orgAdminEmail, password: 'OrgAdmin@12345' })
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200, `org admin login failed: ${JSON.stringify(loginBody)}`);

    /* Connection 1: the org's OWN device reading MUST arrive live. */
    const res1 = await openLive(loginBody.token);
    const p1 = collectUntil(
      res1,
      evs => evs.some(e => e.event === 'reading' && e.data.deviceId === orgBDevice.deviceId)
    );
    await postTelemetry(orgBDevice.deviceId, orgBDevice.key);
    const events1 = await p1;
    assert.ok(
      events1.some(e => e.event === 'reading' && e.data.deviceId === orgBDevice.deviceId),
      'org admin must receive their own org\'s reading'
    );

    /* Connection 2: the default org's DEMO-001 must never appear — neither
       in the (org-scoped) snapshot nor as a live event while it reports. */
    const res2 = await openLive(loginBody.token);
    const p2 = collectUntil(res2, () => false, 3000);
    await postTelemetry('DEMO-001', process.env.DEVICE_API_KEY, { generation: 777 });
    const events2 = await p2;
    const leak = events2.find(e => e.event === 'reading' && e.data.deviceId === 'DEMO-001');
    assert.ok(!leak, 'org admin must never receive another org\'s readings');
  });

  test('org admin snapshot is scoped to their org (no DEMO-001)', async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: orgAdminEmail, password: 'OrgAdmin@12345' })
    });
    const body = await login.json();
    const res = await openLive(body.token);
    const events = await collectUntil(res, evs => evs[0]?.event === 'snapshot');
    const snapshot = events[0].data;
    assert.ok(!snapshot.onlineDevices.includes('DEMO-001'), 'org-admin snapshot must not list the default org\'s demo device');
    assert.ok(!snapshot.ring.some(e => e.deviceId === 'DEMO-001'), 'org-admin ring must not leak other tenants\' events');
  });
});
