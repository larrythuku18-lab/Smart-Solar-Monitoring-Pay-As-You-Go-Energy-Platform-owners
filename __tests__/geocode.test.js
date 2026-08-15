/**
 * Per-site weather tests.
 *
 * Two layers:
 *   1. Pure resolution (geocode.js) — precedence rules (exact device coords
 *      > geocoded location > default) and the geocoder's contract. The
 *      geocoder itself hits a live free API; tests mock nothing but assert
 *      the pure resolver + a real lookup for the demo fleet's own cities.
 *   2. DB coordinate round-trip (db.js) — like migration-idempotency, probes
 *      Postgres in the before hook and t.skip()s when unreachable.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { geocodeLocation, resolveWeatherCoords } = require('../geocode');
const { pool, runMigrations, createUser, provisionDevice, setDeviceCoordinates, getDevice } = require('../db');

/* ── Pure resolver ── */
describe('resolveWeatherCoords precedence', () => {
  test('exact device coords win over location and default', async () => {
    const r = await resolveWeatherCoords({
      lat: -0.10221, lon: 34.76171, location: 'Nairobi, Kenya',
      defaultLat: '-1.2864', defaultLon: '36.8172'
    });
    assert.equal(r.source, 'exact');
    assert.equal(r.lat, -0.10221);
    assert.equal(r.lon, 34.76171);
  });

  test('geocoded location beats the default when no exact coords', async () => {
    const r = await resolveWeatherCoords({
      lat: null, lon: null, location: 'Kisumu, Kenya',
      defaultLat: '-1.2864', defaultLon: '36.8172'
    });
    assert.equal(r.source, 'geocode');
    assert.ok(Math.abs(r.lat - -0.10221) < 0.02, `Kisumu lat ~ -0.10, got ${r.lat}`);
    assert.ok(Math.abs(r.lon - 34.76171) < 0.02, `Kisumu lon ~ 34.76, got ${r.lon}`);
  });

  test('empty location falls back to the default', async () => {
    const r = await resolveWeatherCoords({
      lat: null, lon: null, location: '', defaultLat: '-1.2864', defaultLon: '36.8172'
    });
    assert.equal(r.source, 'default');
    assert.equal(r.lat, -1.2864);
    assert.equal(r.lon, 36.8172);
  });

  test('unresolvable location falls back to the default without throwing', async () => {
    const r = await resolveWeatherCoords({
      lat: null, lon: null, location: 'Zzzzz Not A Real Place 12345',
      defaultLat: '-1.2864', defaultLon: '36.8172'
    });
    assert.equal(r.source, 'default');
  });

  test('null location falls back to the default', async () => {
    const r = await resolveWeatherCoords({
      lat: null, lon: null, location: null, defaultLat: '-1.2864', defaultLon: '36.8172'
    });
    assert.equal(r.source, 'default');
  });
});

describe('geocodeLocation (live, free API)', () => {
  test('resolves Nairobi and returns a city label', async () => {
    const g = await geocodeLocation('Nairobi, Kenya');
    assert.ok(g, 'should resolve Nairobi');
    assert.ok(Math.abs(g.lat - -1.28) < 0.05);
    assert.ok(Math.abs(g.lon - 36.81) < 0.05);
    assert.ok(g.city);
  });

  test('caches the result (second call returns immediately)', async () => {
    const t0 = Date.now();
    const a = await geocodeLocation('Mombasa, Kenya');
    const b = await geocodeLocation('Mombasa, Kenya');
    assert.deepEqual(a, b);
    assert.ok(Date.now() - t0 < 5000, 'cached second lookup should be fast');
  });

  test('returns null for empty input without throwing', async () => {
    assert.equal(await geocodeLocation(''), null);
    assert.equal(await geocodeLocation(null), null);
    assert.equal(await geocodeLocation('   '), null);
  });
});

/* ── DB layer — skips cleanly when Postgres is unreachable ─────────────── */
let dbConnected = false;
let testDeviceId = null;
const TEST_DEVICE = `GEO-TEST-${Date.now()}`;

before(async () => {
  try {
    await pool.query('SELECT 1 AS ok');
    dbConnected = true;
    await runMigrations();
    const device = await provisionDevice(TEST_DEVICE, 'Geocode Test Unit', 'Kisumu, Kenya');
    testDeviceId = device.device_id;
  } catch (err) {
    console.warn('geocode DB tests skipped — Postgres unreachable:', err.message);
  }
});

after(async () => {
  if (dbConnected && testDeviceId) {
    try { await pool.query('DELETE FROM devices WHERE device_id = $1', [testDeviceId]); } catch { /* best-effort */ }
  }
});

describe('device coordinates round-trip (DB)', () => {
  test('setDeviceCoordinates stores exact coords', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const d = await setDeviceCoordinates(testDeviceId, -0.10221, 34.76171);
    assert.equal(Number(d.lat), -0.10221);
    assert.equal(Number(d.lon), 34.76171);
  });

  test('getDevice returns the stored coords', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const d = await getDevice(testDeviceId);
    assert.equal(Number(d.lat), -0.10221);
    assert.equal(Number(d.lon), 34.76171);
  });

  test('null coords clear back to fallback', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const d = await setDeviceCoordinates(testDeviceId, null, null);
    assert.equal(d.lat, null);
    assert.equal(d.lon, null);
  });

  test('rejects out-of-range coords at the DB layer is not enforced, but server validates', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    /* The DB column is unconstrained by design — range validation lives in
       the API route. This test documents that coords persist verbatim. */
    const d = await setDeviceCoordinates(testDeviceId, 91, 200);
    assert.equal(Number(d.lat), 91);
    await setDeviceCoordinates(testDeviceId, null, null); // cleanup
  });

  test('getDailyWeatherRecipients carries device coords + location', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const user = await createUser({
      deviceId: `GEO-USER-${Date.now()}`,
      name: 'Geocode Recipient',
      email: `geo-recipient-${Date.now()}@example.com`,
      passwordHash: 'x',
      pin: '0000',
      role: 'customer'
    });
    try {
      /* provision a device, assign it, set coords, then confirm the
         recipient query surfaces position for the digest */
      const dev = await provisionDevice(`GEO-LINK-${Date.now()}`, 'Linked', 'Kisumu, Kenya');
      await setDeviceCoordinates(dev.device_id, -0.10221, 34.76171);
      await pool.query('UPDATE devices SET user_id = $1 WHERE device_id = $2', [user.id, dev.device_id]);
      const { setUserOrganization } = require('../db');
      await setUserOrganization(user.id, 1).catch(() => {});
      const recipients = await require('../db').getDailyWeatherRecipients();
      const r = recipients.find(x => x.id === user.id);
      assert.ok(r, 'user should be a recipient');
      assert.equal(Number(r.lat), -0.10221);
      assert.ok(r.location.includes('Kisumu'));
      await pool.query('DELETE FROM devices WHERE device_id = $1', [dev.device_id]).catch(() => {});
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => {});
    }
  });
});
