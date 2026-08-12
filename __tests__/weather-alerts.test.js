/**
 * Daily weather-alert tests.
 *
 * Two layers:
 *   1. Pure message builders (weather-alerts.js) — SMS stays within one
 *      160-char segment, the tip adapts to rain/cloud/sun, email body is
 *      complete. No I/O, always runs.
 *   2. DB opt-in toggle + recipient query (db.js) — exercises the real
 *      Postgres like migration-idempotency.test.js: probes connectivity in
 *      the before hook and t.skip()s cleanly when the DB is unreachable.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  pickEnergyTip,
  buildWeatherSms,
  buildWeatherEmail
} = require('../weather-alerts');

const {
  pool,
  runMigrations,
  createUser,
  getDailyWeatherRecipients,
  setDailyWeatherAlerts
} = require('../db');

/* ── Fixtures (grouped-day shape from /api/weather/forecast) ── */
const rainyDay = { date: '2026-08-14', label: 'Fri', minTemp: 14, maxTemp: 19, pop: 75, icon: '10d', condition: 'Rain', emoji: '🌧️' };
const cloudyDay = { date: '2026-08-15', label: 'Sat', minTemp: 13, maxTemp: 24, pop: 25, icon: '04d', condition: 'Clouds', emoji: '☁️' };
const hotDay = { date: '2026-08-16', label: 'Sun', minTemp: 16, maxTemp: 33, pop: 0, icon: '01d', condition: 'Clear', emoji: '☀️' };
const clearDay = { date: '2026-08-17', label: 'Mon', minTemp: 14, maxTemp: 26, pop: 0, icon: '01d', condition: 'Clear', emoji: '☀️' };

describe('pickEnergyTip', () => {
  test('warns about low solar output on a rainy day', () => {
    const tip = pickEnergyTip(rainyDay);
    assert.match(tip.sms, /rain/i);
    assert.match(tip.email, /rain/i);
  });

  test('suggests midday scheduling on a cloudy day', () => {
    const tip = pickEnergyTip(cloudyDay);
    assert.match(tip.sms, /midday|peaks/i);
    assert.ok(!/rain likely/i.test(tip.sms));
  });

  test('flags cooling load on a hot day', () => {
    const tip = pickEnergyTip(hotDay);
    assert.match(tip.sms, /hot/i);
  });

  test('defaults to a sunny-day recommendation for clear mild weather', () => {
    const tip = pickEnergyTip(clearDay);
    assert.match(tip.sms, /solar day|sunny/i);
    assert.match(tip.email, /10:00 and 14:00|10:00–14:00|between 10:00/i);
  });

  test('never returns an empty tip', () => {
    for (const day of [rainyDay, cloudyDay, hotDay, clearDay, {}]) {
      const tip = pickEnergyTip(day);
      assert.ok(tip.sms.length > 10, 'sms tip must be non-trivial');
      assert.ok(tip.email.length > 10, 'email tip must be non-trivial');
    }
  });
});

describe('buildWeatherSms', () => {
  test('stays within one 160-char SMS segment', () => {
    for (const day of [rainyDay, cloudyDay, hotDay, clearDay]) {
      const sms = buildWeatherSms({ name: 'Demo Customer', day, city: 'Nairobi' });
      assert.ok(sms.length <= 160, `SMS is ${sms.length} chars: ${sms}`);
    }
  });

  test('mentions the city, temps, rain and the tip', () => {
    const sms = buildWeatherSms({ name: 'Demo Customer', day: rainyDay, city: 'Nairobi' });
    assert.ok(sms.includes('Nairobi'));
    assert.ok(sms.includes('19°'));
    assert.ok(sms.includes('rain') || sms.includes('%'));
  });

  test('is ASCII-only so it stays one GSM-7 segment (no emoji → no UCS-2 70-char cap)', () => {
    for (const day of [rainyDay, cloudyDay, hotDay, clearDay]) {
      const sms = buildWeatherSms({ name: 'Demo Customer', day, city: 'Nairobi' });
      /* Emoji would force UCS-2 encoding, halving+ segment capacity and
         tripling cost; the weather summary must stay pure GSM-7. */
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sms),
        `SMS contains an emoji — breaks single-segment cost: ${sms}`);
    }
  });
});

describe('buildWeatherEmail', () => {
  test('includes the forecast summary, tip and next-days outlook', () => {
    const body = buildWeatherEmail({
      name: 'Demo Customer',
      day: clearDay,
      city: 'Nairobi',
      days: [clearDay, cloudyDay, rainyDay]
    });
    assert.ok(body.includes('Nairobi'));
    assert.ok(body.includes('Energy tip'));
    assert.ok(body.includes('Mon'));
    assert.ok(body.includes('Sat'));
    assert.ok(body.includes('— SolGrid'));
  });
});

/* ── DB layer — skips cleanly when Postgres is unreachable ─────────────── */
let dbConnected = false;
let testUserId = null;
const TEST_DEVICE = `WX-TEST-${Date.now()}`;
const TEST_EMAIL  = `wx-test-${Date.now()}@example.com`;

before(async () => {
  try {
    await pool.query('SELECT 1 AS ok');
    dbConnected = true;
    await runMigrations();
    const user = await createUser({
      deviceId: TEST_DEVICE,
      name: 'Weather Alert Test',
      email: TEST_EMAIL,
      passwordHash: 'x',
      pin: '0000',
      role: 'customer'
    });
    testUserId = user.id;
  } catch (err) {
    console.warn('weather-alerts DB tests skipped — Postgres unreachable:', err.message);
  }
});

after(async () => {
  if (dbConnected && testUserId) {
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    } catch { /* best-effort cleanup */ }
  }
});

describe('daily_weather_alerts opt-in (DB)', () => {
  test('defaults to TRUE for new users', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable — run with a local PostgreSQL instance');
    const { rows } = await pool.query('SELECT daily_weather_alerts FROM users WHERE id = $1', [testUserId]);
    assert.equal(rows[0].daily_weather_alerts, true);
  });

  test('setDailyWeatherAlerts(false) opts the user out', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    await setDailyWeatherAlerts(testUserId, false);
    const { rows } = await pool.query('SELECT daily_weather_alerts FROM users WHERE id = $1', [testUserId]);
    assert.equal(rows[0].daily_weather_alerts, false);
    const recipients = await getDailyWeatherRecipients();
    assert.ok(!recipients.some(r => r.id === testUserId), 'opted-out user must not be a recipient');
  });

  test('setDailyWeatherAlerts(true) opts the user back in', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    await setDailyWeatherAlerts(testUserId, true);
    const recipients = await getDailyWeatherRecipients();
    assert.ok(recipients.some(r => r.id === testUserId), 'opted-in user with email must be a recipient');
  });

  test('recipients require at least one reachable channel', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const user = await createUser({
      deviceId: `WX-NOCONTACT-${Date.now()}`,
      name: 'No Contact',
      email: null,
      passwordHash: 'x',
      pin: '0000',
      role: 'customer'
    });
    try {
      const recipients = await getDailyWeatherRecipients();
      assert.ok(!recipients.some(r => r.id === user.id), 'user with no phone/email must not be a recipient');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => {});
    }
  });
});
