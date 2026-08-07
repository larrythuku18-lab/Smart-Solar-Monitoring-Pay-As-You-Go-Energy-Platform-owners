/**
 * Regression guard for the blank Analysis Board crash.
 *
 * Symptom: opening /dashboard.html (Analysis Board) as a logged-in admin
 * rendered a completely blank page. Root cause: refreshAllCharts() replaced
 * deviceHealthData.current with a new object that carried only { labels,
 * datasets } — dropping the online/lowBattery/offline count arrays that
 * createDeviceHealthData() provides. The very next render read
 * `deviceHealthData.current.offline.reduce(...)` → TypeError (reading
 * 'reduce') → React unmounted the entire tree → blank page.
 *
 * The dashboard is compiled browser JSX with no jsdom/test harness, so this
 * test statically checks the source invariant: every chart-data object the
 * dashboard replaces at refresh time must keep the exact shape the render
 * reads. It is deliberately strict — this is the bug it exists to catch.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'dashboard.jsx'), 'utf8');

describe('dashboard chart-data shape invariant (blank-page regression)', () => {
  test('createDeviceHealthData() returns online/lowBattery/offline count arrays', () => {
    const m = src.match(/const createDeviceHealthData = \(\) => \{[\s\S]*?\n\};/);
    assert.ok(m, 'createDeviceHealthData() must exist');
    for (const field of ['online', 'lowBattery', 'offline']) {
      assert.ok(m[0].includes(`${field} = labels.map`),
        `createDeviceHealthData() must build a ${field} count array`);
    }
  });

  test('newDeviceHealth keeps the same shape when real device data arrives', () => {
    const m = src.match(/const newDeviceHealth = \{[\s\S]*?\n      \};/);
    assert.ok(m, 'newDeviceHealth literal must exist');
    for (const field of ['online', 'lowBattery', 'offline']) {
      assert.ok(m[0].includes(field),
        `newDeviceHealth must carry ${field} — dropping it blanked the whole dashboard`);
    }
  });

  test('the render reads only fields the device-health ref always provides', () => {
    /* The render sums deviceHealthData.current.offline — that array must be
       present in BOTH the initial shape and the refresh-time replacement. */
    assert.ok(src.includes('deviceHealthData.current.offline.reduce'),
      'render must read deviceHealthData.current.offline (this is the line that crashed)');
    assert.ok(src.includes("useRef(createDeviceHealthData())"),
      'deviceHealthData ref must initialize from createDeviceHealthData()');
  });

  test('customer-fallback device is normalized to device_id (not camelCase)', () => {
    /* /api/customer/summary returns { deviceId, name, location }; the
       selector reads d.device_id everywhere, so the fallback must map it. */
    const fallback = src.match(/devices = \[\{[\s\S]*?\}\];/);
    assert.ok(fallback, 'customer fallback must build a normalized device object');
    assert.ok(fallback[0].includes('device_id:'), 'fallback device must expose device_id');
  });
});
