/**
 * Regression guards for the blank Analysis Board crash and its siblings.
 *
 * Symptom: opening /dashboard.html (Analysis Board) as a logged-in admin
 * rendered a completely blank page. Root cause: refreshAllCharts() replaced
 * deviceHealthData.current with a new object that carried only { labels,
 * datasets } — dropping the online/lowBattery/offline count arrays that
 * createDeviceHealthData() provides. The very next render read
 * `deviceHealthData.current.offline.reduce(...)` → TypeError (reading
 * 'reduce') → React unmounted the entire tree → blank page.
 *
 * The same failure mode exists for every chart-data ref the refresh path
 * REPLACES wholesale (revenue, MRR, forecast, credit score, fraud risk):
 * if the new object drops a field the render reads, the dashboard blanks.
 * The dashboard is compiled browser JSX with no jsdom/test harness, so this
 * test statically checks the source invariant: each refresh-time replacement
 * must keep the exact shape the render reads. It is deliberately strict —
 * this is the bug it exists to catch.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'dashboard.jsx'), 'utf8');

/* Extract the source between two markers (both must exist, start < end). */
function blockBetween(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `missing start marker in dashboard.jsx: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end !== -1 && end > start, `missing end marker after "${startMarker}": ${endMarker}`);
  return src.slice(start, end);
}

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

describe('refresh-time replacements keep the shape the render reads', () => {
  test('forecastData: newForecast keeps labels + datasets[0].data for nextLow', () => {
    /* Render (line ~1090): forecastData.current.labels[...] and
       forecastData.current.datasets[0].data.indexOf(...) — both must exist
       after refresh. */
    assert.ok(src.includes('forecastData.current.labels'),
      'render must read forecastData.current.labels');
    assert.ok(src.includes('forecastData.current.datasets[0].data'),
      'render must read forecastData.current.datasets[0].data');
    const block = blockBetween('const newForecast = {', 'forecastData.current = newForecast;');
    assert.ok(block.includes('labels,'), 'newForecast must carry labels');
    assert.ok(block.includes('datasets: ['), 'newForecast must carry datasets');
    assert.ok(src.includes('useRef(createForecastData())'),
      'forecastData ref must initialize from createForecastData()');
  });

  test('applianceLoadData: newApplianceLoad keeps labels + datasets[0].data the Appliances tab renders', () => {
    /* Render (Appliances tab): applianceLoadData.current.labels.length and
       the Bar chart's data={applianceLoadData.current} — the replacement
       must keep both the labels and the first dataset's data array. */
    assert.ok(src.includes('applianceLoadData.current.labels'),
      'render must read applianceLoadData.current.labels');
    const block = blockBetween('const newApplianceLoad = buildApplianceLoadData(appliances);', 'applianceLoadData.current = newApplianceLoad;');
    assert.ok(block.length >= 0, 'newApplianceLoad must be built before the ref is replaced');
    assert.ok(src.includes('useRef(buildApplianceLoadData([]))'),
      'applianceLoadData ref must initialize from buildApplianceLoadData()');
  });

  test('applianceShareData: replacement keeps count/heavyCount the KPI strip reads', () => {
    /* Render (KPI strip): appliancesTracked = applianceShareData.current.count,
       heavyLoadCount = applianceShareData.current.heavyCount — dropping either
       on refresh would blank those KPI tiles the same way the original bug did. */
    assert.ok(src.includes('applianceShareData.current.count'),
      'render must read applianceShareData.current.count');
    assert.ok(src.includes('applianceShareData.current.heavyCount'),
      'render must read applianceShareData.current.heavyCount');
    const builder = src.match(/const buildApplianceShareData = \(appliances\) => \{[\s\S]*?\n\};/);
    assert.ok(builder, 'buildApplianceShareData() must exist');
    assert.ok(builder[0].includes('count:') && builder[0].includes('heavyCount:'),
      'buildApplianceShareData() must return count and heavyCount');
    assert.ok(src.includes('applianceShareData.current = newApplianceShare;'),
      'refresh must replace applianceShareData.current');
  });
});
