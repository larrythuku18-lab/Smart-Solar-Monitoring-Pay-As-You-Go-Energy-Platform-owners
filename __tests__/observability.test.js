/**
 * observability.test.js — Section 8 (Prometheus /metrics + SLI counters)
 *
 * Spawns a metrics-enabled server and asserts:
 *   - /metrics returns Prometheus text format with the default + custom metrics
 *   - METRICS_TOKEN protects the endpoint (401 without it)
 *   - HTTP request counters accumulate
 *   - telemetry, payment, and relay SLI counters appear with the right labels
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.TEST_OBS_PORT || 3988);
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'obs-test-token-123';

let child;

async function spawnAndWait(port, envOverrides, label) {
  const env = { ...process.env, PORT: String(port), ...envOverrides };
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'pipe'
  });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });

  const base = `http://localhost:${port}`;
  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`${label} did not become healthy in time. Output:\n${output}`));
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
  return proc;
}

before(async () => {
  child = await spawnAndWait(PORT, {
    METRICS_ENABLED: 'true',
    METRICS_TOKEN: TOKEN,
    API_RATE_LIMIT_MAX: '20000'
  }, 'metrics-enabled server');
});

after(() => {
  child?.kill('SIGKILL');
});

describe('/metrics endpoint', () => {
  test('returns 401 without the bearer token', async () => {
    const r = await fetch(`${BASE}/metrics`);
    assert.equal(r.status, 401);
  });

  test('returns 401 with a wrong token', async () => {
    const r = await fetch(`${BASE}/metrics`, {
      headers: { Authorization: 'Bearer wrong-token' }
    });
    assert.equal(r.status, 401);
  });

  test('returns Prometheus text format with the right token', async () => {
    const r = await fetch(`${BASE}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    const body = await r.text();

    /* Default (process/node) metrics with the solgrid_ prefix */
    assert.match(body, /^# HELP solgrid_process_cpu_user_seconds_total/m);
    assert.match(body, /^solgrid_nodejs_heap_size_total_bytes/m);
    /* Our custom SLI metrics must be present */
    assert.match(body, /^solgrid_payments_total/m);
    assert.match(body, /^solgrid_telemetry_ingested_total/m);
    assert.match(body, /^solgrid_relay_commands_total/m);
    assert.match(body, /^solgrid_ota_boot_reports_total/m);
    assert.match(body, /^solgrid_http_requests_total/m);
  });

  test('has no-store cache header', async () => {
    const r = await fetch(`${BASE}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

describe('SLI counters accumulate', () => {
  test('HTTP requests are counted on /metrics scrapes', async () => {
    /* The scrape above already hit /metrics (plus /health at boot) — the
       counter for the /metrics route itself must be >= the scrapes we made. */
    const r = await fetch(`${BASE}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const body = await r.text();
    const line = body.split('\n').find(l => l.startsWith('solgrid_http_requests_total{'));
    assert.ok(line, 'http request counter must exist');
    const count = Number(line.split(' ').pop());
    assert.ok(count >= 3, `expected >= 3 scrapes counted, got ${count}`);
  });

  test('relay SLI counters exist with success label', async () => {
    /* Trigger a real relay command path indirectly: the boot-time seed and
       health checks don't fire relay commands, but the metrics must still
       be registered with the success label for the alert rule to match. */
    const r = await fetch(`${BASE}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const body = await r.text();
    assert.match(body, /solgrid_relay_commands_total\{action="lock",result="success"\}/m);
    assert.match(body, /solgrid_relay_commands_total\{action="unlock",result="success"\}/m);
  });
});

describe('observability module unit checks', () => {
  test('recordPayment / recordTelemetry / recordRelay are safe to call', () => {
    const obs = require('../observability');
    obs.recordPayment('initiated', { type: 'energy' });
    obs.recordPayment('completed', { type: 'energy' });
    obs.recordPayment('failed', { type: 'energy' });
    obs.recordTelemetry('ok');
    obs.recordTelemetry('unauth');
    obs.recordRelay('unlock', 'success');
    obs.recordRelay('lock', 'queued');
  });

  test('jsonLine produces parseable single-line JSON', () => {
    const obs = require('../observability');
    const line = obs.jsonLine('info', 'hello', { deviceId: 'DEMO-001', n: 42 });
    const parsed = JSON.parse(line);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.msg, 'hello');
    assert.equal(parsed.deviceId, 'DEMO-001');
    assert.equal(parsed.n, 42);
    /* Must be a single line (newline-joined logs stay parseable per line) */
    assert.equal((line.match(/\n/g) || []).length, 0);
  });

  test('jsonLine drops unserializable fields without throwing', () => {
    const obs = require('../observability');
    const circular = {};
    circular.self = circular;
    const line = obs.jsonLine('warn', 'circular', { ok: 1, bad: circular });
    const parsed = JSON.parse(line);
    assert.equal(parsed.ok, 1);
    assert.equal(parsed.bad, undefined);
  });
});
