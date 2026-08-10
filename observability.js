/**
 * observability.js — Prometheus metrics + structured JSON logging
 *
 * Section 8 of the production-hardening spec. Three pieces, all optional:
 *
 *  1. /metrics Prometheus endpoint (wired in server.js):
 *       - process_* / nodejs_* default metrics (CPU, memory, event loop)
 *       - http_request_* — every HTTP request, labeled by route/method/status
 *       - solgrid_sli_* — the three business SLIs from the spec:
 *           payments  (initiated / completed / failed, 1-minute buckets)
 *           devices   (telemetry ingest, relay commands, current online count)
 *           relay     (command latency + failure rate)
 *     Scrape-protected with a bearer token when METRICS_TOKEN is set, so
 *     the endpoint is never open to the public internet by default.
 *
 *  2. Structured JSON logging — logJson() emits one JSON object per line
 *     ({ ts, level, msg, ...fields }) when LOG_FORMAT=json, and falls back
 *     to plain console.* output otherwise so existing log parsing and the
 *     local dev experience are unchanged. All fields are passed through
 *     JSON.stringify-safe (no functions, no circular refs).
 *
 *  3. Alert helpers — `sliLabels`/`sliField` keep the metric and log labels
 *     for each SLI consistent, so Prometheus alert rules (see
 *     observability/prometheus-alerts.yml) and log queries agree on names.
 *
 * The module is side-effect free on require; server.js decides when to
 * enable metrics (METRICS_ENABLED=true) and JSON logs (LOG_FORMAT=json).
 */

const client = require('prom-client');

/* ── Registration + default (process/node) metrics ─────────────────────── */
const register = new client.Registry();
let defaultsStarted = false;

function startDefaultMetrics() {
  if (defaultsStarted) return;
  defaultsStarted = true;
  client.collectDefaultMetrics({ register, prefix: 'solgrid_' });
}

/* ── HTTP request metrics ──────────────────────────────────────────────── */
const httpRequests = new client.Counter({
  name: 'solgrid_http_requests_total',
  help: 'Total HTTP requests, labeled by route, method and status class.',
  labelNames: ['route', 'method', 'status'],
  registers: [register]
});

const httpRequestDuration = new client.Histogram({
  name: 'solgrid_http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['route', 'method'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

/* ── SLI: Payments ─────────────────────────────────────────────────────── */
const paymentsTotal = new client.Counter({
  name: 'solgrid_payments_total',
  help: 'Payment outcomes. status=initiated|completed|failed, type=energy|product|simulated.',
  labelNames: ['status', 'type'],
  registers: [register]
});

/* Time from initiation to completion for payments that finished (mostly
   useful for the real M-Pesa path; simulated payments complete in ~3s). */
const paymentSettleSeconds = new client.Histogram({
  name: 'solgrid_payment_settle_seconds',
  help: 'Seconds from payment initiation to completion.',
  buckets: [1, 3, 5, 10, 30, 60, 120, 300],
  registers: [register]
});

/* ── SLI: Devices / telemetry ──────────────────────────────────────────── */
const telemetryIngested = new client.Counter({
  name: 'solgrid_telemetry_ingested_total',
  help: 'Telemetry readings persisted, labeled by outcome.',
  labelNames: ['outcome'], // outcome=ok|unauth|invalid|rate_limited|error
  registers: [register]
});

const devicesOnline = new client.Gauge({
  name: 'solgrid_devices_online',
  help: 'Devices seen as online right now (updated by the telemetry heartbeat).',
  registers: [register]
});

/* ── SLI: Relay commands ───────────────────────────────────────────────── */
const relayCommands = new client.Counter({
  name: 'solgrid_relay_commands_total',
  help: 'Relay command outcomes. action=unlock|lock, result=success|queued|error.',
  labelNames: ['action', 'result'],
  registers: [register]
});

const relayCommandDuration = new client.Histogram({
  name: 'solgrid_relay_command_duration_seconds',
  help: 'Round-trip time to send a relay command to a device.',
  labelNames: ['action'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

/* ── SLI: OTA (rollout health) ─────────────────────────────────────────── */
const otaBootReports = new client.Counter({
  name: 'solgrid_ota_boot_reports_total',
  help: 'Firmware boot reports, labeled by status.',
  labelNames: ['status'], // status=ok|fail
  registers: [register]
});

const otaRolloutPaused = new client.Counter({
  name: 'solgrid_ota_rollout_paused_total',
  help: 'Rollouts auto-paused (fleet safety valve fired).',
  registers: [register]
});

/* Express middleware — records every request (route, method, status, dur).
   Mounted AFTER the static file handlers so CDN-cached asset hits (the
   bulk of traffic) are counted as one /static route, not per-file noise. */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path || req.baseUrl || req.path.split('?')[0] || '/';
    /* Collapse asset paths so card counts stay bounded. */
    const labelRoute = (route.startsWith('/') && !route.includes('api')) ? '/static' : route;
    const status = String(res.statusCode);
    httpRequests.inc({ route: labelRoute, method: req.method, status });
    const secs = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe({ route: labelRoute, method: req.method }, secs);
  });
  next();
}

/* ── Structured JSON logging ───────────────────────────────────────────── */
const JSON_LOGGING = process.env.LOG_FORMAT === 'json';

/* Builds one JSON line from a message + fields. Drops any value that
   wouldn't survive JSON.stringify (functions, symbols, undefined, cycles)
   rather than throwing in the hot path. */
function jsonLine(level, msg, fields) {
  const entry = { ts: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      try {
        JSON.stringify(v); // throws on circular refs / functions
        entry[k] = v;
      } catch { /* skip unserializable field */ }
    }
  }
  return JSON.stringify(entry);
}

function logJson(level, msg, fields) {
  const line = jsonLine(level, msg, fields);
  if (JSON_LOGGING) {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } else if (fields && Object.keys(fields).length > 0) {
    /* Human mode: keep the existing shape ("[TAG] msg — field=value …") so
       nothing about the current log format changes when LOG_FORMAT is unset. */
    const suffix = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    const line = `${msg} — ${suffix}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } else {
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
  }
}

/* Friendly wrappers matching the console.* signatures used across server.js */
const log = {
  info:  (msg, fields) => logJson('info',  msg, fields),
  warn:  (msg, fields) => logJson('warn',  msg, fields),
  error: (msg, fields) => logJson('error', msg, fields)
};

/* ── Metrics helpers for the SLI call-sites ────────────────────────────── */

/* Report payment outcome. type=energy|product, simulated=true/false. */
function recordPayment(status, { type = 'energy', simulated = false } = {}) {
  paymentsTotal.inc({
    status,
    type: simulated ? 'simulated' : type
  });
}

/* Report a telemetry outcome so the ingest SLI can be alerting on it. */
function recordTelemetry(outcome) {
  telemetryIngested.inc({ outcome });
}

/* Report a relay command result. */
function recordRelay(action, result) {
  relayCommands.inc({ action, result });
}

/* Pre-register the label combinations the alert rules rely on (with 0) so
   a freshly-started instance always exposes the series — Prometheus alert
   rules fire on missing series inconsistently, and a counter that has never
   been inc()'d emits nothing at all. This keeps every alert rule
   evaluatable from the first scrape. */
relayCommands.inc({ action: 'unlock', result: 'success' }, 0);
relayCommands.inc({ action: 'unlock', result: 'queued' }, 0);
relayCommands.inc({ action: 'lock',   result: 'success' }, 0);
relayCommands.inc({ action: 'lock',   result: 'queued' }, 0);
relayCommands.inc({ action: 'lock',   result: 'error' }, 0);
relayCommands.inc({ action: 'unlock', result: 'error' }, 0);
paymentsTotal.inc({ status: 'initiated', type: 'energy' }, 0);
paymentsTotal.inc({ status: 'initiated', type: 'product' }, 0);
paymentsTotal.inc({ status: 'initiated', type: 'simulated' }, 0);
paymentsTotal.inc({ status: 'completed', type: 'energy' }, 0);
paymentsTotal.inc({ status: 'completed', type: 'product' }, 0);
paymentsTotal.inc({ status: 'completed', type: 'simulated' }, 0);
paymentsTotal.inc({ status: 'failed', type: 'energy' }, 0);
paymentsTotal.inc({ status: 'failed', type: 'product' }, 0);
paymentsTotal.inc({ status: 'failed', type: 'simulated' }, 0);
telemetryIngested.inc({ outcome: 'ok' }, 0);
telemetryIngested.inc({ outcome: 'unauth' }, 0);
telemetryIngested.inc({ outcome: 'invalid' }, 0);
telemetryIngested.inc({ outcome: 'rate_limited' }, 0);
telemetryIngested.inc({ outcome: 'error' }, 0);
otaBootReports.inc({ status: 'ok' }, 0);
otaBootReports.inc({ status: 'fail' }, 0);

/* ── Exports ───────────────────────────────────────────────────────────── */
module.exports = {
  register,
  startDefaultMetrics,
  metricsMiddleware,
  /* counters/gauges exposed for direct use in call-sites */
  httpRequests,
  httpRequestDuration,
  paymentsTotal,
  paymentSettleSeconds,
  telemetryIngested,
  devicesOnline,
  relayCommands,
  relayCommandDuration,
  otaBootReports,
  otaRolloutPaused,
  /* logging */
  log,
  jsonLine,
  /* SLI helpers */
  recordPayment,
  recordTelemetry,
  recordRelay,
  /* test/ops aid */
  contentType: register.contentType,
  async metricsText() {
    return register.metrics();
  }
};
