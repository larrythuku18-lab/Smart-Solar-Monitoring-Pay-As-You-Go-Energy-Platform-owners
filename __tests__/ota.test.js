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
const { generateKeyPairSync } = require('node:crypto');

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

/* ECDSA P-256 keypair for the signing tests — generated here so the spawned
   OTA server signs every upload (FIRMWARE_SIGNING_KEY) and we can verify the
   signatures against the matching root public key, exactly as a device with
   the baked-in key would. */
const TEST_KEYS = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SIGNING_PRIVATE_PEM = TEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const SIGNING_PUBLIC_PEM  = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' });

/* Devices whose boot reports the after() hook must delete so repeated runs
   don't accumulate firmware_boot_reports rows. */
const createdBootReportDevices = [];

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
  /* API_RATE_LIMIT_MAX raised: every request in this suite comes from
     localhost, and the suite now makes several hundred of them — the
     production default of 120/min would 429 the later tests. */
  server = await spawnAndWait(PORT, { OTA_ENABLED: 'true', FIRMWARE_SIGNING_KEY: SIGNING_PRIVATE_PEM, API_RATE_LIMIT_MAX: '20000' }, 'OTA-enabled server');
  if (!OTA_PINNED_ON) {
    offServer = await spawnAndWait(OFF_PORT, { API_RATE_LIMIT_MAX: '20000' }, 'OTA-disabled server');
  }
});

/* Orgs created by the multi-tenant OTA tests (org-scoped firmware). The
   after() hook deletes their users/devices/firmware before the org rows, so
   repeated runs never accumulate tenant rows in the shared local DB. */
const createdOrgIds = [];
const createdOrgUserIds = [];

after(async () => {
  server?.kill('SIGKILL');
  offServer?.kill('SIGKILL');
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  try {
    const db = require('../db');
    if (createdVersions.length > 0) {
      await db.pool.query('DELETE FROM firmware_versions WHERE version = ANY($1)', [createdVersions]);
    }
    if (createdBootReportDevices.length > 0) {
      await db.pool.query('DELETE FROM firmware_boot_reports WHERE device_id = ANY($1)', [createdBootReportDevices]);
    }
    if (createdOrgIds.length > 0) {
      await db.pool.query('DELETE FROM users    WHERE organization_id = ANY($1)', [createdOrgIds]);
      await db.pool.query('DELETE FROM devices  WHERE organization_id = ANY($1)', [createdOrgIds]);
      await db.pool.query('DELETE FROM firmware_versions WHERE organization_id = ANY($1)', [createdOrgIds]);
      await db.pool.query('DELETE FROM firmware_boot_reports WHERE organization_id = ANY($1)', [createdOrgIds]);
      await db.pool.query('DELETE FROM organizations WHERE id = ANY($1)', [createdOrgIds]);
    }
    if (createdOrgUserIds.length > 0) {
      await db.pool.query('DELETE FROM users WHERE id = ANY($1)', [createdOrgUserIds]);
    }
  } catch (err) {
    console.warn('OTA test cleanup warning:', err.message);
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

describe('firmware signing (ECDSA P-256)', { skip: OTA_PINNED_OFF }, () => {
  test('uploads are signed and the signature verifies against the root public key', async () => {
    const adminToken = await loginAdmin();
    const version = freshVersion();
    const bytes = crypto.randomBytes(256);
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: bytes
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { signature, signed } = await upload.json();
    assert.equal(signed, true);
    assert.ok(signature, 'upload must carry an ECDSA signature when a signing key is configured');

    /* Device-side check, reproduced with node crypto: signature over the
       binary's SHA-256 must verify against the root public key. */
    const { verifyFirmwareSignature } = require('../firmware');
    assert.equal(verifyFirmwareSignature(bytes, signature, SIGNING_PUBLIC_PEM), true);
    assert.equal(
      verifyFirmwareSignature(Buffer.concat([bytes, Buffer.from([0])]), signature, SIGNING_PUBLIC_PEM),
      false,
      'a tampered binary must fail verification'
    );
  });

  test('/latest offers the signature so a device can verify before flashing', async () => {
    const adminToken = await loginAdmin();
    const { deviceId, key } = await provisionTestDevice();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(128)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();
    const act = await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(act.status, 200);

    const latest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(latest.status, 200);
    const info = await latest.json();
    assert.ok(info.signature, '/latest must include the signature');

    /* The download stream carries it as a header too, for devices that fetch
       the URL directly without hitting /latest first. */
    const download = await fetch(`${BASE}${info.url}`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-firmware-signature'), info.signature);
  });

  test('sign/:id re-signs an uploaded binary (idempotent)', async () => {
    const adminToken = await loginAdmin();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(64)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();

    const signed = await fetch(`${BASE}/api/firmware/sign/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(signed.status, 200);
    const body = await signed.json();
    assert.equal(body.signed, true);
    assert.ok(body.signature);

    /* Non-admin can't sign. */
    const customerToken = await loginCustomer();
    const forbidden = await fetch(`${BASE}/api/firmware/sign/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert.equal(forbidden.status, 403);
  });
});

describe('staged rollout (percentage + region)', { skip: OTA_PINNED_OFF }, () => {
  /* Upload + activate with the given rollout knobs; returns the published
     version + firmware id. */
  async function publishAndActivate({ rolloutPct, region }) {
    const adminToken = await loginAdmin();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();
    const qs = new URLSearchParams();
    if (rolloutPct !== undefined) qs.set('rollout_pct', String(rolloutPct));
    if (region) qs.set('region', region);
    const act = await fetch(`${BASE}/api/firmware/activate/${id}${qs.size ? `?${qs}` : ''}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(act.status, 200);
    return { version, id, adminToken };
  }

  test('rollout_pct=0 withholds the update from every device', async () => {
    const { deviceId, key } = await provisionTestDevice();
    await publishAndActivate({ rolloutPct: 0 });
    const r = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(r.status, 404, 'a 0% rollout must not be offered to anyone');
  });

  test('rollout_pct=100 offers it to every device (the default behavior)', async () => {
    const { deviceId, key } = await provisionTestDevice();
    await publishAndActivate({ rolloutPct: 100 });
    const r = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(r.status, 200);
  });

  test('the bucket is deterministic — raising the percentage is the only way a device joins', async () => {
    const adminToken = await loginAdmin();
    const { deviceId, key } = await provisionTestDevice();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();

    /* This device's exact bucket, computed with the same sha256(device:id)
       first-byte-mod-100 hash the server uses. */
    const bucket = crypto.createHash('sha256').update(`${deviceId}:${id}`).digest()[0] % 100;

    /* At pct == bucket the device is excluded (bucket < bucket is false)… */
    const actExcluded = await fetch(`${BASE}/api/firmware/activate/${id}?rollout_pct=${bucket}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(actExcluded.status, 200);
    const excluded = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(excluded.status, 404, `device bucket ${bucket} must be excluded at pct=${bucket}`);

    /* …and at pct == bucket + 1 it is included (bucket < bucket+1 is true). */
    const pctIncluded = Math.min(100, bucket + 1);
    const actIncluded = await fetch(`${BASE}/api/firmware/activate/${id}?rollout_pct=${pctIncluded}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(actIncluded.status, 200);
    const included = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(included.status, 200, `device bucket ${bucket} must be included at pct=${pctIncluded}`);
  });

  test('a region-scoped rollout only reaches devices whose location matches', async () => {
    const adminToken = await loginAdmin();
    const { deviceId: nairobi, key: nairobiKey } = await provisionTestDevice();
    const { deviceId: coast, key: coastKey } = await provisionTestDevice();

    const setLoc = await fetch(`${BASE}/api/admin/devices/${encodeURIComponent(nairobi)}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ location: 'Nairobi, Kenya' })
    });
    assert.equal(setLoc.status, 200, 'setting a device location must succeed');

    await publishAndActivate({ rolloutPct: 100, region: 'Nairobi' });

    const inRegion = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(nairobi, nairobiKey) });
    assert.equal(inRegion.status, 200, 'a Nairobi device must be eligible for a Nairobi rollout');
    const outRegion = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(coast, coastKey) });
    assert.equal(outRegion.status, 404, 'a device outside the region must be excluded');
  });

  test('the admin list surfaces rollout metadata', async () => {
    const adminToken = await loginAdmin();
    await publishAndActivate({ rolloutPct: 25, region: 'Kisumu' });
    const list = await fetch(`${BASE}/api/firmware`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(list.status, 200);
    const { versions } = await list.json();
    const active = versions.find(v => v.is_active);
    assert.ok(active, 'an active version must exist');
    assert.equal(active.rollout_pct, 25);
    assert.equal(active.rollout_region, 'Kisumu');
    assert.equal(active.signed, true, 'signed flag must reflect the configured key');
  });

  test('a malformed rollout_pct is rejected, never treated as 100%', async () => {
    const adminToken = await loginAdmin();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(16)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();

    for (const bad of ['abc', '50.5', '-1', '101', '']) {
      const r = await fetch(`${BASE}/api/firmware/activate/${id}?rollout_pct=${encodeURIComponent(bad)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(r.status, 400, `rollout_pct=${JSON.stringify(bad)} must be rejected`);
    }

    /* And the version is still not active afterwards. */
    const list = await fetch(`${BASE}/api/firmware`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { versions } = await list.json();
    assert.equal(versions.find(v => v.version === version).is_active, false,
      'a rejected activation must not have touched the fleet');
  });
});

describe('boot reports + 2-strike auto-pause', { skip: OTA_PINNED_OFF }, () => {
  test('the fleet-wide auto-pause needs 2 distinct failing devices; reactivating resumes it', async () => {
    const adminToken = await loginAdmin();
    const { deviceId: devA, key: keyA } = await provisionTestDevice();
    const { deviceId: devB, key: keyB } = await provisionTestDevice();
    createdBootReportDevices.push(devA, devB);
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();
    const act = await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(act.status, 200);

    const report = (deviceId, key, status) => fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(deviceId, key) },
      body: JSON.stringify({ version, status })
    });

    /* Offered before any reports. */
    const before = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA, keyA) });
    assert.equal(before.status, 200);

    /* One device failing twice is NOT enough — it must not be able to pause
       a fleet rollout on its own (it rolls itself back locally instead). */
    const r1 = await report(devA, keyA, 'fail');
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).paused, false, 'one failing device must not pause the rollout');
    const r2 = await report(devA, keyA, 'fail');
    assert.equal((await r2.json()).paused, false, 'even two failures from the SAME device must not pause');
    const still = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA, keyA) });
    assert.equal(still.status, 200);

    /* A second distinct device failing crosses the threshold → auto-pause. */
    const r3 = await report(devB, keyB, 'fail');
    assert.equal(r3.status, 200);
    assert.equal((await r3.json()).paused, true, '2 distinct failing devices must auto-pause');

    const pausedCheck = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA, keyA) });
    assert.equal(pausedCheck.status, 404, 'a paused rollout must not be offered');

    /* The pause is visible to admins. */
    const list = await fetch(`${BASE}/api/firmware`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const { versions } = await list.json();
    assert.equal(versions.find(v => v.version === version).rollout_paused, true);

    /* A single ok report does NOT unpause (that is an admin decision): the
       paused version must never reappear as an active `version` to chase.
       (devA's ok makes the paused version its last-good, so /latest may hand
       back a `previous` downgrade pointer — never a target.) */
    const ok = await report(devA, keyA, 'ok');
    assert.equal(ok.status, 200);
    const stillPaused = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA, keyA) });
    assert.equal((await stillPaused.json()).version, undefined, 'an ok report must not resume the paused rollout');

    /* Re-activating resumes the rollout. */
    const resume = await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(resume.status, 200);
    const resumed = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA, keyA) });
    assert.equal(resumed.status, 200, 're-activation must clear the pause');
  });

  test('the admin rollout-status endpoint shows the target, envelope, and boot-fail stats', async () => {
    const adminToken = await loginAdmin();
    const { deviceId, key } = await provisionTestDevice();
    createdBootReportDevices.push(deviceId);
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();
    await fetch(`${BASE}/api/firmware/activate/${id}?rollout_pct=50&region=Nairobi`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(deviceId, key) },
      body: JSON.stringify({ version, status: 'fail' })
    });

    const r = await fetch(`${BASE}/api/firmware/rollout`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.active.version, version);
    assert.equal(body.active.rollout_pct, 50);
    assert.equal(body.active.rollout_region, 'Nairobi');
    assert.equal(body.bootFailures24h.reports, 1);
    assert.equal(body.bootFailures24h.distinctDevices, 1);
    assert.equal(body.bootFailures24h.pauseThreshold, 2);

    /* Non-admin is locked out. */
    const customerToken = await loginCustomer();
    const forbidden = await fetch(`${BASE}/api/firmware/rollout`, { headers: { Authorization: `Bearer ${customerToken}` } });
    assert.equal(forbidden.status, 403);
  });

  test('manual pause works and blocks /latest', async () => {
    const adminToken = await loginAdmin();
    const { deviceId, key } = await provisionTestDevice();
    const version = freshVersion();
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upload.status, 201);
    createdVersions.push(version);
    const { id } = await upload.json();
    await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const pause = await fetch(`${BASE}/api/firmware/pause/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json()).rollout_paused, true);

    const r = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(r.status, 404);

    const customerToken = await loginCustomer();
    const forbidden = await fetch(`${BASE}/api/firmware/pause/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert.equal(forbidden.status, 403);
  });

  test('report validates version, status, and device credentials', async () => {
    const { deviceId, key } = await provisionTestDevice();
    createdBootReportDevices.push(deviceId);
    const headers = { 'Content-Type': 'application/json', ...deviceHeaders(deviceId, key) };

    const badVersion = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST', headers, body: JSON.stringify({ version: 'not-a-version', status: 'ok' })
    });
    assert.equal(badVersion.status, 400);

    const badStatus = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST', headers, body: JSON.stringify({ version: '1.2.3', status: 'maybe' })
    });
    assert.equal(badStatus.status, 400);

    const noAuth = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '1.2.3', status: 'ok' })
    });
    assert.equal(noAuth.status, 401);
  });
});

describe('rollback aid (previous pointer)', { skip: OTA_PINNED_OFF }, () => {
  test('/latest offers a device its last boot-ok version as `previous`', async () => {
    const adminToken = await loginAdmin();
    const { deviceId, key } = await provisionTestDevice();
    createdBootReportDevices.push(deviceId);

    /* vOld: published, activated, and the device boots it OK. */
    const vOld = freshVersion();
    const upOld = await fetch(`${BASE}/api/firmware/upload?version=${vOld}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upOld.status, 201);
    createdVersions.push(vOld);
    const oldId = (await upOld.json()).id;
    await fetch(`${BASE}/api/firmware/activate/${oldId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const okOld = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(deviceId, key) },
      body: JSON.stringify({ version: vOld, status: 'ok' })
    });
    assert.equal(okOld.status, 200);

    /* vNew: published + activated. */
    const vNew = freshVersion();
    const upNew = await fetch(`${BASE}/api/firmware/upload?version=${vNew}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upNew.status, 201);
    createdVersions.push(vNew);
    const newId = (await upNew.json()).id;
    await fetch(`${BASE}/api/firmware/activate/${newId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const latest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(deviceId, key) });
    assert.equal(latest.status, 200);
    const info = await latest.json();
    assert.equal(info.version, vNew);
    assert.ok(info.previous, 'a device with a boot-ok history must get a previous pointer');
    assert.equal(info.previous.version, vOld);
    assert.equal(info.previous.url, `/api/firmware/download/${oldId}`);

    /* A device with no boot reports gets no previous pointer. */
    const { deviceId: freshId, key: freshKey } = await provisionTestDevice();
    const fresh = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(freshId, freshKey) });
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).previous, undefined);
  });

  test('a quarantined device keeps its downgrade pointer even after the rollout is auto-paused', async () => {
    const adminToken = await loginAdmin();
    const { deviceId: devA, key: keyA } = await provisionTestDevice();
    const { deviceId: devB, key: keyB } = await provisionTestDevice();
    createdBootReportDevices.push(devA, devB);

    /* devA proves vOld good, then both devices fail vNew twice → pause. */
    const vOld = freshVersion();
    const upOld = await fetch(`${BASE}/api/firmware/upload?version=${vOld}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upOld.status, 201);
    createdVersions.push(vOld);
    const oldId = (await upOld.json()).id;
    await fetch(`${BASE}/api/firmware/activate/${oldId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const okOld = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(devA, keyA) },
      body: JSON.stringify({ version: vOld, status: 'ok' })
    });
    assert.equal(okOld.status, 200);

    const vNew = freshVersion();
    const upNew = await fetch(`${BASE}/api/firmware/upload?version=${vNew}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    assert.equal(upNew.status, 201);
    createdVersions.push(vNew);
    const newId = (await upNew.json()).id;
    await fetch(`${BASE}/api/firmware/activate/${newId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    /* Both devices report vNew failing; the second distinct device crosses
       the threshold and auto-pauses. */
    const failA = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(devA, keyA) },
      body: JSON.stringify({ version: vNew, status: 'fail' })
    });
    assert.equal((await failA.json()).paused, false, 'first distinct device must not pause yet');
    const failB = await fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(devB, keyB) },
      body: JSON.stringify({ version: vNew, status: 'fail' })
    });
    assert.equal((await failB.json()).paused, true, 'second distinct device must auto-pause');

    /* Even though the rollout is paused (no active target), devA — which has
       a last-known-good (vOld) it is not running — still gets the downgrade
       pointer. This is the path a crash-looping device takes to recover. */
    const latest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA, keyA) });
    assert.equal(latest.status, 200, 'a device with a downgrade path must not be 404ed');
    const body = await latest.json();
    assert.equal(body.version, undefined, 'no active target while paused');
    assert.equal(body.previous.version, vOld);
    assert.equal(body.previous.url, `/api/firmware/download/${oldId}`);
  });
});

describe('ENFORCE_PER_DEVICE_KEYS toggle', { skip: OTA_PINNED_OFF }, () => {
  let enforcePort;
  let enforceBase;
  let enforceChild;

  before(async () => {
    enforcePort = PORT + 100;
    enforceBase = `http://localhost:${enforcePort}`;
    enforceChild = await spawnAndWait(enforcePort, {
      OTA_ENABLED: 'true',
      FIRMWARE_SIGNING_KEY: SIGNING_PRIVATE_PEM,
      ENFORCE_PER_DEVICE_KEYS: 'true',
      API_RATE_LIMIT_MAX: '20000'
    }, 'enforce-keys server');
  });

  after(() => {
    if (enforceChild) { enforceChild.kill(); }
  });

  test('rejects a device without a per-device key on /latest', async () => {
    const r = await fetch(`${enforceBase}/api/firmware/latest`, {
      headers: { 'X-Device-Id': 'DEMO-001', 'X-Device-Key': 'some-shared-key' }
    });
    /* DEMO-001 has no api_key in the DB (it was seeded without one), and
       ENFORCE_PER_DEVICE_KEYS=true removes the DEVICE_API_KEY fallback. */
    assert.equal(r.status, 401, 'unprovisioned device must be rejected when enforced');
  });

  test('accepts a provisioned device with its own key on /latest', async () => {
    const { deviceId, key } = await provisionTestDevice();
    const r = await fetch(`${enforceBase}/api/firmware/latest`, {
      headers: deviceHeaders(deviceId, key)
    });
    /* 404 means the auth passed (the device is authenticated) but there's
       no active firmware — which is the expected state. */
    assert.notEqual(r.status, 401, 'provisioned device must not be rejected');
  });

  test('rejects an unprovisioned device on /report', async () => {
    const r = await fetch(`${enforceBase}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'NO-KEY-DEVICE', 'X-Device-Key': 'some-key' },
      body: JSON.stringify({ version: '1.0.0', status: 'fail' })
    });
    assert.equal(r.status, 401, 'unprovisioned device must be rejected on /report when enforced');
  });
});

describe('multi-tenant OTA (per-org firmware)', { skip: OTA_PINNED_OFF }, () => {
  /* Unique org slugs per run so repeated runs never collide. */
  const MT_SUFFIX = Date.now().toString(36);
  const ORG_A_SLUG = `ota-org-a-${MT_SUFFIX}`;
  const ORG_B_SLUG = `ota-org-b-${MT_SUFFIX}`;
  const ADMIN_A_EMAIL = `ota-admin-a-${MT_SUFFIX}@example.com`;
  const ADMIN_B_EMAIL = `ota-admin-b-${MT_SUFFIX}@example.com`;

  let orgAId;
  let orgBId;
  let orgAToken;
  let orgBToken;
  /* Devices provisioned into the test orgs, so the after() hook can remove
     their boot reports alongside the org cleanup. */
  const orgTestDevices = [];

  async function login(email, password) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await r.json();
    assert.equal(r.status, 200, `org admin login failed: ${JSON.stringify(body)}`);
    return body.token;
  }

  before(async () => {
    const adminToken = await loginAdmin();

    /* Create two tenants + one org admin each (super-admin only operation). */
    const mkOrg = async (slug) => {
      const r = await fetch(`${BASE}/api/admin/organizations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ name: `OTA Org ${slug}`, slug })
      });
      const body = await r.json();
      assert.equal(r.status, 201, `org creation failed: ${JSON.stringify(body)}`);
      return body.organization.id;
    };
    orgAId = await mkOrg(ORG_A_SLUG);
    orgBId = await mkOrg(ORG_B_SLUG);
    createdOrgIds.push(orgAId, orgBId);

    const mkAdmin = async (email, organizationId) => {
      const r = await fetch(`${BASE}/api/admin/admins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          name: 'OTA Org Admin', email, password: 'OrgAdmin@123',
          role: 'org_admin', organizationId
        })
      });
      const body = await r.json();
      assert.equal(r.status, 201, `org admin creation failed: ${JSON.stringify(body)}`);
      return body.admin;
    };
    const adminA = await mkAdmin(ADMIN_A_EMAIL, orgAId);
    const adminB = await mkAdmin(ADMIN_B_EMAIL, orgBId);
    createdOrgUserIds.push(adminA.id, adminB.id);

    orgAToken = await login(ADMIN_A_EMAIL, 'OrgAdmin@123');
    orgBToken = await login(ADMIN_B_EMAIL, 'OrgAdmin@123');
  });

  /* Provision a device into a specific org (super-admin passes ?orgId=). */
  async function provisionOrgDevice(orgId) {
    const adminToken = await loginAdmin();
    const deviceId = `OTA-MT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await fetch(`${BASE}/api/admin/devices?orgId=${orgId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deviceId })
    });
    assert.equal(r.status, 200, 'org device provisioning failed');
    const { device } = await r.json();
    orgTestDevices.push(deviceId);
    createdBootReportDevices.push(deviceId);
    return { deviceId, key: device.api_key };
  }

  /* Upload + activate as a given admin; returns the version + firmware id. */
  async function publishAs(adminToken, version, extraQs = '') {
    const upload = await fetch(`${BASE}/api/firmware/upload?version=${version}${extraQs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
      body: crypto.randomBytes(32)
    });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 201, `upload failed: ${JSON.stringify(uploadBody)}`);
    const { id } = uploadBody;
    createdVersions.push(version);
    const act = await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(act.status, 200, 'activation failed');
    return { version, id };
  }

  test('org admins can publish firmware that lands in their own org', async () => {
    const { id } = await publishAs(orgAToken, freshVersion());

    /* Org A sees its own build. */
    const listA = await fetch(`${BASE}/api/firmware`, {
      headers: { Authorization: `Bearer ${orgAToken}` }
    });
    assert.equal(listA.status, 200);
    const { versions: versionsA } = await listA.json();
    assert.ok(versionsA.find(v => v.id === id), 'org A must see its own firmware');
    assert.equal(versionsA.find(v => v.id === id).org_id, orgAId, 'version must carry the org identity');

    /* Org B must NOT see it. */
    const listB = await fetch(`${BASE}/api/firmware`, {
      headers: { Authorization: `Bearer ${orgBToken}` }
    });
    const { versions: versionsB } = await listB.json();
    assert.ok(!versionsB.find(v => v.id === id), 'org B must never see org A firmware');

    /* Super-admin sees it with the org label. */
    const listSuper = await fetch(`${BASE}/api/firmware`, {
      headers: { Authorization: `Bearer ${await loginAdmin()}` }
    });
    const { versions: versionsSuper } = await listSuper.json();
    const v = versionsSuper.find(x => x.id === id);
    assert.ok(v, 'super-admin must see every org version');
    assert.equal(v.org_id, orgAId);
    assert.ok(v.org_name, 'super-admin list must include the org name for labelling');
  });

  test('two orgs may publish the SAME version string independently', async () => {
    const sharedVersion = freshVersion();
    const inA = await publishAs(orgAToken, sharedVersion);
    const inB = await publishAs(orgBToken, sharedVersion);

    assert.ok(inA.id !== inB.id, 'each org must get its own row for the same version string');
    const both = await fetch(`${BASE}/api/firmware`, {
      headers: { Authorization: `Bearer ${await loginAdmin()}` }
    }).then(r => r.json());
    const matches = both.versions.filter(v => v.version === sharedVersion);
    assert.equal(matches.length, 2, 'both orgs must be able to publish version X simultaneously');
    assert.equal(new Set(matches.map(m => m.org_id)).size, 2, 'the two rows must live in different orgs');
  });

  test('org admins cannot activate or pause another org firmware', async () => {
    const { id } = await publishAs(orgAToken, freshVersion());

    /* Org B tries to activate org A's staged version → 404 (not 403/200). */
    const activate = await fetch(`${BASE}/api/firmware/activate/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgBToken}` }
    });
    assert.equal(activate.status, 404, 'cross-org activation must look like not-found');

    /* Org B tries to pause org A's version → 404. */
    const pause = await fetch(`${BASE}/api/firmware/pause/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgBToken}` }
    });
    assert.equal(pause.status, 404, 'cross-org pause must look like not-found');

    /* Org B tries to re-sign org A's binary → 404. */
    const sign = await fetch(`${BASE}/api/firmware/sign/${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgBToken}` }
    });
    assert.equal(sign.status, 404, 'cross-org sign must look like not-found');
  });

  test('devices only get firmware from their own org (/latest + /download)', async () => {
    const { version, id } = await publishAs(orgAToken, freshVersion());
    const devA = await provisionOrgDevice(orgAId);
    const devB = await provisionOrgDevice(orgBId);

    /* The org A device is offered the org A target. */
    const latestA = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devA.deviceId, devA.key) });
    assert.equal(latestA.status, 200, 'org A device must be offered org A firmware');
    assert.equal((await latestA.json()).version, version);

    /* The org B device may get ITS OWN org's firmware (org B published its
       own version in an earlier test) — but never org A's target. */
    const latestB = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devB.deviceId, devB.key) });
    assert.notEqual(latestB.status, 401, 'org B device must authenticate');
    const bBody = await latestB.json();
    assert.notEqual(bBody.version, version, 'org B device must never be offered org A firmware');
    if (bBody.version) {
      /* Cross-check: the version org B's device was offered must actually
         belong to org B in the admin list. */
      const superList = await fetch(`${BASE}/api/firmware`, {
        headers: { Authorization: `Bearer ${await loginAdmin()}` }
      }).then(r => r.json());
      const offered = superList.versions.find(v => v.version === bBody.version);
      assert.ok(offered, 'the offered version must exist');
      assert.equal(offered.org_id, orgBId, 'org B device must be offered an org B build');
    }

    /* The org B device cannot download org A's binary either. */
    const dlB = await fetch(`${BASE}/api/firmware/download/${id}`, { headers: deviceHeaders(devB.deviceId, devB.key) });
    assert.equal(dlB.status, 404, 'cross-org download must be blocked');

    /* The org A device can download its own org's binary. */
    const dlA = await fetch(`${BASE}/api/firmware/download/${id}`, { headers: deviceHeaders(devA.deviceId, devA.key) });
    assert.equal(dlA.status, 200, 'same-org download must work');
  });

  test('boot-failures in one org never pause another org rollout', async () => {
    const { version, id } = await publishAs(orgAToken, freshVersion());
    /* Org B publishes its own version so the cross-org probe has a target. */
    await publishAs(orgBToken, freshVersion());

    const devA1 = await provisionOrgDevice(orgAId);
    const devA2 = await provisionOrgDevice(orgAId);
    const devB = await provisionOrgDevice(orgBId);

    const report = (dev, status) => fetch(`${BASE}/api/firmware/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(dev.deviceId, dev.key) },
      body: JSON.stringify({ version, status })
    });

    /* Two distinct org A devices fail → org A's rollout pauses. */
    assert.equal((await (await report(devA1, 'fail')).json()).paused, false);
    const second = await report(devA2, 'fail');
    assert.equal((await second.json()).paused, true, '2 org-A failures must pause org A rollout');

    /* But org B's rollout is untouched — its device is still offered its target. */
    const bLatest = await fetch(`${BASE}/api/firmware/latest`, { headers: deviceHeaders(devB.deviceId, devB.key) });
    assert.equal(bLatest.status, 200, 'org B rollout must survive org A failures');

    /* And the admin list surfaces the paused flag per org: org B's active
       version is NOT paused, org A's is. */
    const superList = await fetch(`${BASE}/api/firmware`, {
      headers: { Authorization: `Bearer ${await loginAdmin()}` }
    }).then(r => r.json());
    const aRow = superList.versions.find(v => v.id === id);
    assert.equal(aRow.rollout_paused, true, 'org A version must be flagged paused');
  });
});
