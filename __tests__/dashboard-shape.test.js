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
  test('revenueData: newRevenue keeps datasets[0].data for the KPI computations', () => {
    /* Render (line ~1085): revenueData.current.datasets[0].data.at(-1) and
       .slice(-7).reduce(...) — so the replacement must still expose a
       datasets array whose first dataset has a data array. */
    assert.ok(src.includes('revenueData.current.datasets[0].data'),
      'render must read revenueData.current.datasets[0].data');
    const block = blockBetween('const newRevenue = {', 'revenueData.current = newRevenue;');
    assert.ok(block.includes('datasets: ['), 'newRevenue must carry a datasets array');
    assert.ok(block.includes("label: 'Daily Revenue (KES)'"),
      'newRevenue must keep the revenue dataset');
    /* The dataset must actually carry the data array (the render does
       .data.at(-1) and .data.slice(-7).reduce) — checking the label alone
       would let a regression where data: is dropped slip through. */
    assert.ok(block.match(/data[,:]/), 'newRevenue dataset must carry the data array');
    assert.ok(src.includes("useRef(createRevenueData())"),
      'revenueData ref must initialize from createRevenueData()');
  });

  test('mrrData: newMRR keeps the values array the growth footer reads', () => {
    /* Render (line ~1094): mrrData.current.values.at(-1) and .values.length
       — the replacement must keep the top-level values array, not just
       datasets[0].data. */
    assert.ok(src.includes('mrrData.current.values'),
      'render must read mrrData.current.values');
    const block = blockBetween('const newMRR = {', 'mrrData.current = newMRR;');
    assert.ok(block.includes('values: mrrValues'),
      'newMRR must carry the top-level values array');
    assert.ok(src.includes('useRef(createMRRData())'),
      'mrrData ref must initialize from createMRRData()');
  });

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

  test('creditScoreTrendData: replacement goes through buildCreditScoreTrendData() which returns datasets', () => {
    /* Render (line ~1072, 1303): creditScoreTrendData.current.datasets.map
       and .datasets.length — the ref must always carry a datasets array. */
    assert.ok(src.includes('creditScoreTrendData.current.datasets'),
      'render must read creditScoreTrendData.current.datasets');
    assert.ok(src.includes('creditScoreTrendData.current = newCreditScoreTrend;'),
      'refresh must replace creditScoreTrendData.current');
    const builder = src.match(/const buildCreditScoreTrendData = \(labels, customers\) => \(\{[\s\S]*?\n\}\);/);
    assert.ok(builder, 'buildCreditScoreTrendData() must exist');
    assert.ok(builder[0].includes('datasets:'), 'builder must return a datasets array');
    assert.ok(src.includes('useRef(buildCreditScoreTrendData([], []))'),
      'creditScoreTrendData ref must initialize from buildCreditScoreTrendData()');
  });

  test('fraudRiskData: replacement goes through buildFraudRiskData() which returns points', () => {
    /* Render (line ~1092): fraudRiskData.current.points.filter(...) — the
       ref must always carry the points array. */
    assert.ok(src.includes('fraudRiskData.current.points'),
      'render must read fraudRiskData.current.points');
    assert.ok(src.includes('fraudRiskData.current = newFraudRisk;'),
      'refresh must replace fraudRiskData.current');
    const builder = src.match(/const buildFraudRiskData = \(points\) => \{[\s\S]*?\n\};/);
    assert.ok(builder, 'buildFraudRiskData() must exist');
    assert.ok(builder[0].includes('points: colored'),
      'builder must return the points array');
    assert.ok(src.includes('useRef(buildFraudRiskData([]))'),
      'fraudRiskData ref must initialize from buildFraudRiskData()');
  });
});
