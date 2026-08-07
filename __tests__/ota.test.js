/**
 * OTA firmware update tests (feature-flagged).
 *
 * Spawns its own server with OTA_ENABLED=true on TEST_OTA_PORT so the OTA
 * routes exist for the positive tests, plus a second server WITHOUT the flag
 * to prove the routes 404 when the feature is off (the rollback posture).
 * Both require a local Postgres, exactly like the rest of the suite.
 *
 * Skip guards: server.js loads .env with { override: true }, so if a
 * developer pins OTA_ENABLED in their .env the spawned children can't
 * override it. The positive tests skip when the flag is pinned off, and the
 * flag-off test skips when it's pinned on.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Never let test logins/payment flows fire real emails or SMS.
process.env.RESEND_API_KEY = '';
process.env.AT_USERNAME = '';
process.env.AT_API_KEY = '';

/* Must not collide with the other suites' ports (api.test.js=3911,
   telemetry-security.test.js=3922). */
const PORT = Number(process.env.TEST_OTA_PORT || 3931);
const OFF_PORT = PORT + 1;

/* Versions this run publishes — deleted from the shared local DB in after()
   so repeated runs don't accumulate firmware_versions rows. */
const createdVersions = [];
const BASE = `http://localhost:${PORT}`;
const OFF_BASE = `http://localhost:${OFF_PORT}`;

const OTA_PINNED_ON = process.env.OTA_ENABLED === 'true';
const OTA_PINNED_OFF = process.env.OTA_ENABLED === 'false';

/* Binaries are written here, never into the repo. */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solgrid-ota-test-'));

let server;
let offServer;

async function spawnAndWait(port, envOverrides, label) {
  const env = { ...process.env, PORT: String(port), FIRMWARE_DIR: TMP_DIR, ...envOverrides };
  if (!('OTA_ENABLED' in envOverrides)) delete env.OTA_ENABLED;

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'pipe'
  });

  let childOutput = '';
  child.stdout.on('data', d => { childOutput += d; });
  child.stderr.on('data', d => { childOutput += d; });

  const base = `http://localhost:${port}`;
  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`${label} did not become healthy in time. Child output:\n${childOutput}`));
    }, 60_000);
    const tryHealth = async () => {
      if (settled) return;
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) { settled = true; clearTimeout(timeout); return resolve(); }
      } catch { /* not up yet */ }
      if (!settled) setTimeout(tryHealth, 400);
    };
    tryHealth();
  });
  return child;
}

before(async () => {
  server = await spawnAndWait(PORT, { OTA_ENABLED: 'true' }, 'OTA-enabled server');
  if (!OTA_PINNED_ON) {
    offServer = await spawnAndWait(OFF_PORT, {}, 'OTA-disabled server');
  }
});

after(async () => {
  server?.kill('SIGKILL');
  offServer?.kill('SIGKILL');
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  if (createdVersions.length > 0) {
    try {
      const db = require('../db');
      await db.pool.query('DELETE FROM firmware_versions WHERE version = ANY($1)', [createdVersions]);
    } catch (err) {
      console.warn('OTA test cleanup warning:', err.message);
    }
  }
});

/* ── Auth helpers (memoized — authLimiter budget is shared) ── */
let _adminToken = null;
let _customerToken = null;

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

/* Provision a throwaway device so the device-key checks have a real,
   self-contained credential (no dependency on a shared DEVICE_API_KEY). */
async function provisionTestDevice() {
  const adminToken = await loginAdmin();
  const deviceId = `OTA-DEV-${Date.now()}`;
  const r = await fetch(`${BASE}/api/admin/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ deviceId })
  });
  assert.equal(r.status, 200, 'device provisioning failed');
  const { device } = await r.json();
  return { deviceId, key: device.api_key };
}

const deviceHeaders = (deviceId, key) => ({ 'X-Device-Id': deviceId, 'X-Device-Key': key });

/* Unique-but-valid semver per run so repeat runs against the shared local
   DB never trip the version UNIQUE constraint. Segments must stay within
   1-4 digits (the server's VERSION_RE), hence % 10000. The sequence counter
   keeps two calls inside the same millisecond distinct. */
let _versionSeq = 0;
function freshVersion() {
  _versionSeq = (_versionSeq + 1) % 1000;
  return `1.${Date.now() % 10000}.${(process.pid % 800) + 100 + _versionSeq}`;
}

describe('OTA feature flag', () => {
  test('firmware routes 404 when OTA_ENABLED is not true', { skip: OTA_PINNED_ON }, async () => {
    const r = await fetch(`${OFF_BASE}/api/firmware/latest`, {
      headers: deviceHeaders('DEMO-001', 'whatever-key')
    });
    assert.equal(r.status, 404, 'routes must not exist when the flag is off');

    const adminToken = await fetch(`${OFF_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    process.env.ADMIN_EMAIL    || 'admin@solarpayg.com',
        password: process.env.ADMIN_PASSWORD || 'Admin@12345'
      })
    }).then(r => r.json()).then(b => b.token);

    const upload = await fetch(`${OFF_BASE}/api/firmware/upload?version=1.2.3`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3])
    });
    assert.equal(upload.status, 404, 'upload must not exist when the flag is off');
  });
});

describe('device-credential enforcement', { skip: OTA_PINNED_OFF }, () => {
  test('latest rejects missing device credentials', async () => {
    const r = await fetch(`${BASE}/api/firmware/latest`);
    assert.equal(r.status, 401);
  });

  test('latest rejects a wrong device key', async () => {
    const r = await fetch(`${BASE}/api/firmware/latest`, {
      headers: deviceHeaders('DEMO-001', 'definitely-not-the-key')
    });
    assert.equal(r.status, 401);
  });

  test('download rejects requests without valid device credentials', async () => {
    const r = await fetch(`${BASE}/api/firmware/download/1`);
    assert.equal(r.status, 401);
  });
});

describe('OTA upload authorization', { skip: OTA_PINNED_OFF }, () => {
  test('non-admin upload is rejected with 403', async () => {
    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/firmware/upload?version=1.2.3`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3])
    });
    assert.equal(r.status, 403);
  });

  test('upload rejects a malformed version', async () => {
    const adminToken = await loginAdmin();
    const r = await fetch(`${BASE}/api/firmware/upload?version=not-a-version`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3])
    });
    assert.equal(r.status, 400);
  });

  test('upload rejects an empty body', async () => {
    const adminToken = await loginAdmin();
    const r = await fetch(`${BASE}/api/firmware/upload?version=1.2.3`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0)
    });
    assert.equal(r.status, 400);
  });
});

describe('OTA publish (stage) → activate → check → download', { skip: OTA_PINNED_OFF }, () => {
  test('upload stages without targeting the fleet; activate promotes; devices then fetch and verify', async () => {
    const adminToken = await loginAdmin();
    const { deviceId, key } = await provisionTestDevice();
    const version = freshVersion();
    const bytes = crypto.randomBytes(512);
    const expectedSha = crypto.createHash('sha256').update(bytes).digest('hex');

    /* 1. Publish — staged, NOT active */
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}&changelog=${encodeURIComponent('Test release')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: bytes
    });
    assert.equal(upload.status, 201, 'upload should succeed');
    const published = await upload.json();
    assert.equal(published.checksum, expectedSha);
    assert.equal(published.version, version);
    assert.equal(published.is_active, false, 'upload must stage, never auto-activate');
    createdVersions.push(version);

    /* 2. While staged, /latest must NOT offer it (404 or an older active one) */
    const stagedCheck = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    if (stagedCheck.status === 200) {
      assert.notEqual((await stagedCheck.json()).version, version,
        'a staged version must not be offered to devices');
    } else {
      assert.equal(stagedCheck.status, 404, 'no active firmware yet');
    }

    /* 3. Activate (admin-only) */
    const activate = await fetch(`${BASE}/api/firmware/activate/${published.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(activate.status, 200);
    assert.equal((await activate.json()).is_active, true);

    /* 4. Devices now discover it via /latest (device-key auth) */
    const latest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(latest.status, 200);
    const info = await latest.json();
    assert.equal(info.version, version);
    assert.equal(info.checksum, expectedSha);
    assert.equal(info.url, `/api/firmware/download/${published.id}`);

    /* 5. Devices download it and get back byte-identical content */
    const download = await fetch(`${BASE}${info.url}`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    const received = Buffer.from(await download.arrayBuffer());
    assert.equal(received.length, bytes.length);
    assert.deepEqual(received, bytes);
    assert.equal(crypto.createHash('sha256').update(received).digest('hex'), expectedSha);

    /* 6. The admin list surfaces the new version as active */
    const list = await fetch(`${BASE}/api/firmware`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(list.status, 200);
    const { versions } = await list.json();
    const mine = versions.find(v => v.version === version);
    assert.ok(mine, 'published version missing from admin list');
    assert.equal(mine.is_active, true);
    assert.equal(mine.size_bytes, bytes.length);
  });

  test('activation is admin-only', async () => {
    const adminToken = await loginAdmin();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3])
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();

    const customerToken = await loginCustomer();
    const r = await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert.equal(r.status, 403);
  });

  test('activating an unknown id 404s', async () => {
    const adminToken = await loginAdmin();
    const r = await fetch(`${BASE}/api/firmware/activate/2147483647`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(r.status, 404);
  });

  test('publishing the same version again is rejected with 409', async () => {
    const adminToken = await loginAdmin();
    const version = freshVersion();
    const first = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([9, 9, 9])
    });
    assert.equal(first.status, 201);
    createdVersions.push(version);

    const dup = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([9, 9, 9])
    });
    assert.equal(dup.status, 409);
  });

  test('only the explicitly activated version is the target (activation switches atomically)', async () => {
    const adminToken = await loginAdmin();
    const vOld = freshVersion();
    const vNew = freshVersion();
    const ids = [];
    for (const v of [vOld, vNew]) {
      const r = await fetch(`${BASE}/api/firmware/upload?version=${v}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
        body: crypto.randomBytes(64)
      });
      assert.equal(r.status, 201);
      createdVersions.push(v);
      ids.push((await r.json()).id);
    }

    const { deviceId, key } = await provisionTestDevice();

    /* Neither staged version is offered yet */
    const before = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    if (before.status === 200) {
      const beforeBody = await before.json();
      assert.notEqual(beforeBody.version, vOld);
      assert.notEqual(beforeBody.version, vNew);
    } else {
      assert.equal(before.status, 404);
    }

    /* Activating the OLD one makes it the target… */
    const actOld = await fetch(`${BASE}/api/firmware/activate/${ids[0]}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(actOld.status, 200);
    let latest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal((await latest.json()).version, vOld);

    /* …then the NEW one replaces it atomically */
    const actNew = await fetch(`${BASE}/api/firmware/activate/${ids[1]}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(actNew.status, 200);
    latest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal((await latest.json()).version, vNew);

    /* The old one is no longer active in the admin list */
    const list = await fetch(`${BASE}/api/firmware`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { versions } = await list.json();
    assert.equal(versions.find(v => v.id === ids[0]).is_active, false);
    assert.equal(versions.find(v => v.id === ids[1]).is_active, true);
  });
});
