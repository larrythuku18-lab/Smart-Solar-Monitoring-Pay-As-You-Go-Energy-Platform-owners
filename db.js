/**
 * db.js — PostgreSQL persistence layer (node-postgres / pg)
 *
 * Connection: reads DATABASE_URL from the environment.
 * On Render.com, attach a PostgreSQL add-on and the variable is set automatically.
 * Locally, create a .env file:  DATABASE_URL=postgresql://user:pass@localhost:5432/solarpayg
 *
 * All functions are async and return plain JS objects (same shape as the
 * old SQLite helpers so server.js / relay.js call-sites only need `await`).
 */

require('dotenv').config();
const { Pool, types } = require('pg');

/* ── Type parsers ────────────────────────────────────────────────────────────
   pg returns NUMERIC columns as strings by default. Override so arithmetic
   on wallet_balance, amounts, sensor values, etc. works without manual casts.
   BIGINT (INT8) is also returned as a string by default — parse to Number. */
types.setTypeParser(types.builtins.NUMERIC, Number.parseFloat);
types.setTypeParser(types.builtins.INT8, Number);

/* ── Connection pool ─────────────────────────────────────────────────────── */
const isLocal =
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/solarpayg',
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

/** Thin wrapper — always returns the pg Result object. */
async function q(text, params) {
  return pool.query(text, params);
}

/* ══════════════════════════════════════════════════════════════════════════
   MIGRATIONS
   Creates all tables and indexes if they do not already exist.
   Safe to call on every startup.
══════════════════════════════════════════════════════════════════════════ */
async function runMigrations() {
  await q(`
    -- ── Users ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL        PRIMARY KEY,
      device_id      VARCHAR(64)   UNIQUE NOT NULL,
      name           VARCHAR(128),
      pin            VARCHAR(20)   NOT NULL,
      phone          VARCHAR(20),
      wallet_balance NUMERIC(12,2) DEFAULT 0,
      relay_unlocked BOOLEAN       DEFAULT FALSE,
      created_at     TIMESTAMPTZ   DEFAULT NOW()
    );

    -- ── Devices ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS devices (
      id          SERIAL      PRIMARY KEY,
      device_id   VARCHAR(64) UNIQUE NOT NULL,
      user_id     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      name        VARCHAR(128),
      location    VARCHAR(256),
      device_ip   VARCHAR(45),
      status      VARCHAR(20) DEFAULT 'active',
      relay_state VARCHAR(10) DEFAULT 'off',
      is_active   BOOLEAN     DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Energy readings (IoT telemetry from ESP32) ─────────────────────────
    CREATE TABLE IF NOT EXISTS energy_readings (
      id                SERIAL        PRIMARY KEY,
      device_id         VARCHAR(64)   NOT NULL,
      generation_watts  NUMERIC(10,2) DEFAULT 0,
      consumption_watts NUMERIC(10,2) DEFAULT 0,
      battery_level     NUMERIC(5,2)  DEFAULT 0,
      voltage           NUMERIC(6,2)  DEFAULT 48,
      current_amps      NUMERIC(6,2)  DEFAULT 0,
      power_output      NUMERIC(10,2) DEFAULT 0,
      recorded_at       TIMESTAMPTZ   DEFAULT NOW()
    );

    -- ── Payments (M-Pesa STK Push) ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS payments (
      id                   SERIAL        PRIMARY KEY,
      user_id              INTEGER       NOT NULL REFERENCES users(id),
      device_id            VARCHAR(64),
      amount               NUMERIC(12,2) NOT NULL,
      phone_number         VARCHAR(20),
      mpesa_ref            VARCHAR(64),
      status               VARCHAR(20)   DEFAULT 'pending',
      merchant_request_id  VARCHAR(128),
      checkout_request_id  VARCHAR(128),
      mpesa_receipt_number VARCHAR(64),
      fraud_score          NUMERIC(4,3)  DEFAULT 0,
      result_code          VARCHAR(10),
      result_desc          TEXT,
      created_at           TIMESTAMPTZ   DEFAULT NOW(),
      processed_at         TIMESTAMPTZ
    );

    -- ── AI predictions ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ai_predictions (
      id              SERIAL      PRIMARY KEY,
      device_id       VARCHAR(64) NOT NULL,
      prediction_type VARCHAR(64) NOT NULL,
      prediction_data JSONB,
      payload         TEXT,
      confidence      NUMERIC(4,3),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Maintenance alerts ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS maintenance_alerts (
      id         SERIAL      PRIMARY KEY,
      user_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      device_id  VARCHAR(64),
      type       VARCHAR(64) NOT NULL,
      alert_type VARCHAR(64),
      severity   VARCHAR(20) DEFAULT 'medium',
      message    TEXT        NOT NULL,
      resolved   BOOLEAN     DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Relay command retry queue ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS pending_commands (
      id            SERIAL      PRIMARY KEY,
      device_id     VARCHAR(64) NOT NULL,
      command       VARCHAR(64) NOT NULL,
      attempts      INTEGER     DEFAULT 0,
      max_attempts  INTEGER     DEFAULT 5,
      last_error    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      next_retry_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── Indexes ────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_energy_device_ts  ON energy_readings(device_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_user     ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_checkout ON payments(checkout_request_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_device     ON maintenance_alerts(device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pred_device       ON ai_predictions(device_id, created_at DESC);
  `);

  console.log('✅ PostgreSQL migrations complete');
}

/* ── Demo data seed ─────────────────────────────────────────────────────── */
async function seedDemoData() {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  const { rows: [user] } = await q(
    `INSERT INTO users (device_id, pin, phone, wallet_balance, relay_unlocked)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['DEMO-001', '1234', '254712345678', 50, true]
  );

  await q(
    `INSERT INTO devices (device_id, user_id, name, device_ip, relay_state, status, location)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['DEMO-001', user.id, 'Demo Solar Kit', '192.168.1.100' /* demo only */, 'on', 'active', 'Nairobi, Kenya']
  );

  /* Seed 13 energy readings covering the last hour (5-min intervals) */
  const now = Date.now();
  for (let i = 12; i >= 0; i--) {
    const ts = new Date(now - i * 5 * 60_000);
    const hour = ts.getHours();
    const seasonal = Math.sin(((hour - 6) * Math.PI) / 12) * 80 + 150;
    const gen = Math.max(0, seasonal + Math.random() * 30);
    await q(
      `INSERT INTO energy_readings
         (device_id, generation_watts, consumption_watts, battery_level, voltage, current_amps, power_output, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      ['DEMO-001', gen, 120 + Math.random() * 20, 70 + Math.random() * 10, 48, 10, gen * 0.95, ts]
    );
  }

  console.log('✅ Demo data seeded  (deviceId: DEMO-001  pin: 1234)');
}

/* ══════════════════════════════════════════════════════════════════════════
   USER QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function getUserByDeviceId(deviceId) {
  const { rows } = await q('SELECT * FROM users WHERE device_id = $1', [deviceId]);
  return rows[0] ?? null;
}

async function getUserById(id) {
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function updateWallet(userId, amount) {
  await q(
    'UPDATE users SET wallet_balance = wallet_balance + $1, relay_unlocked = TRUE WHERE id = $2',
    [amount, userId]
  );
}

async function setWalletBalance(userId, balance) {
  await q('UPDATE users SET wallet_balance = $1 WHERE id = $2', [balance, userId]);
}

async function getExpiredWalletUsers() {
  const { rows } = await q(`
    SELECT u.*, d.device_id AS linked_device_id, d.device_ip
    FROM   users   u
    LEFT JOIN devices d ON d.user_id = u.id
    WHERE  u.wallet_balance <= 0
    AND    u.relay_unlocked = TRUE
  `);
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   DEVICE QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function getDevice(deviceId) {
  const { rows } = await q('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
  return rows[0] ?? null;
}

async function getDeviceByUserId(userId) {
  const { rows } = await q(
    'SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [userId]
  );
  return rows[0] ?? null;
}

async function setRelayState(deviceId, state) {
  const relayStr = state ? 'on' : 'off';
  await q('UPDATE devices SET relay_state = $1 WHERE device_id = $2', [relayStr, deviceId]);
  const device = await getDevice(deviceId);
  if (device?.user_id) {
    await q('UPDATE users SET relay_unlocked = $1 WHERE id = $2', [state, device.user_id]);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ENERGY READINGS
══════════════════════════════════════════════════════════════════════════ */

async function insertEnergyReading(data) {
  const powerOutput = (data.generation || 0) * 0.95;
  await q(
    `INSERT INTO energy_readings
       (device_id, generation_watts, consumption_watts, battery_level, voltage, current_amps, power_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [data.deviceId, data.generation, data.consumption, data.batteryLevel, data.voltage, data.current, powerOutput]
  );
}

async function getLatestEnergy(deviceId) {
  const { rows } = await q(
    'SELECT * FROM energy_readings WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1',
    [deviceId]
  );
  return rows[0] ?? null;
}

/** Most-recent N readings, newest first */
async function getEnergyHistory(deviceId, limit = 50) {
  const { rows } = await q(
    'SELECT * FROM energy_readings WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT $2',
    [deviceId, limit]
  );
  return rows;
}

/** Most-recent N readings returned in ascending (oldest → newest) order */
async function getEnergyHistoryAsc(deviceId, limit = 50) {
  const { rows } = await q(
    `SELECT * FROM (
       SELECT * FROM energy_readings WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT $2
     ) sub ORDER BY recorded_at ASC`,
    [deviceId, limit]
  );
  return rows;
}

/** All readings from the last 48 hours, oldest first — used to warm AI models on startup */
async function getEnergyHistory48h(deviceId) {
  const { rows } = await q(
    `SELECT * FROM energy_readings
     WHERE  device_id  = $1
     AND    recorded_at > NOW() - INTERVAL '48 hours'
     ORDER  BY recorded_at ASC`,
    [deviceId]
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   PAYMENT QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function createPayment({ userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId }) {
  const { rows } = await q(
    `INSERT INTO payments
       (user_id, device_id, amount, phone_number, status, merchant_request_id, checkout_request_id)
     VALUES ($1,$2,$3,$4,'pending',$5,$6)
     RETURNING id`,
    [userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId]
  );
  return rows[0];
}

async function completePayment(checkoutRequestId, receiptNumber, resultCode, resultDesc) {
  const { rows } = await q(
    'SELECT * FROM payments WHERE checkout_request_id = $1',
    [checkoutRequestId]
  );
  const payment = rows[0];
  if (!payment) return null;

  await q(
    `UPDATE payments
     SET status = 'completed', mpesa_receipt_number = $1, mpesa_ref = $1,
         result_code = $2, result_desc = $3, processed_at = NOW()
     WHERE checkout_request_id = $4`,
    [receiptNumber, resultCode, resultDesc, checkoutRequestId]
  );

  await updateWallet(payment.user_id, Number.parseFloat(payment.amount));

  const { rows: updated } = await q(
    'SELECT * FROM payments WHERE checkout_request_id = $1',
    [checkoutRequestId]
  );
  return updated[0] ?? null;
}

async function failPayment(checkoutRequestId, resultCode, resultDesc) {
  await q(
    `UPDATE payments SET status = 'failed', result_code = $1, result_desc = $2
     WHERE checkout_request_id = $3`,
    [resultCode, resultDesc, checkoutRequestId]
  );
}

async function getPaymentStats() {
  const { rows: [s] } = await q(`
    SELECT
      COUNT(*)                                              ::int   AS count,
      COUNT(*)                                              ::int   AS total_payments,
      COUNT(*) FILTER (WHERE status = 'completed')          ::int   AS cleared,
      COUNT(*) FILTER (WHERE status = 'completed')          ::int   AS completed,
      COUNT(*) FILTER (WHERE status = 'completed')          ::int   AS success,
      COUNT(*) FILTER (WHERE status = 'pending')            ::int   AS pending,
      COUNT(*) FILTER (WHERE status = 'failed')             ::int   AS failed,
      COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0)    AS total_revenue
    FROM payments
  `);
  return s;
}

async function getRecentPayments(limit = 20) {
  const { rows } = await q(
    `SELECT p.*, u.device_id AS user_device_id
     FROM   payments p
     LEFT JOIN users u ON p.user_id = u.id
     ORDER  BY p.created_at DESC
     LIMIT  $1`,
    [limit]
  );
  return rows;
}

async function getPaymentTrend() {
  const { rows } = await q(`
    SELECT created_at::date::text                                          AS day,
           COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0)     AS revenue,
           COUNT(*)::int                                                   AS total
    FROM   payments
    GROUP  BY created_at::date
    ORDER  BY day ASC
    LIMIT  14
  `);
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   ALERTS / MAINTENANCE
══════════════════════════════════════════════════════════════════════════ */

async function createAlert({ userId, deviceId, type, severity, message }) {
  await q(
    `INSERT INTO maintenance_alerts (user_id, device_id, type, alert_type, severity, message)
     VALUES ($1,$2,$3,$3,$4,$5)`,
    [userId, deviceId, type, severity, message]
  );
}

async function getAlerts(limit = 20) {
  const { rows } = await q(
    'SELECT * FROM maintenance_alerts ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

async function getAlertSeverityCounts() {
  const { rows } = await q(
    'SELECT severity, COUNT(*)::int AS count FROM maintenance_alerts GROUP BY severity'
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   AI PREDICTIONS
══════════════════════════════════════════════════════════════════════════ */

async function savePrediction(deviceId, predictionType, payload, confidence) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await q(
    `INSERT INTO ai_predictions (device_id, prediction_type, prediction_data, payload, confidence)
     VALUES ($1,$2,$3,$4,$5)`,
    [deviceId, predictionType, data, data, confidence ?? null]
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   AUDIT TIMELINE
══════════════════════════════════════════════════════════════════════════ */

async function getAuditTimeline(limit = 30) {
  const { rows } = await q(
    `SELECT 'payment'             AS category,
            id, created_at        AS ts,
            status                AS severity,
            amount::text          AS detail,
            device_id             AS ref_id
     FROM   payments
     UNION ALL
     SELECT 'alert',
            id, created_at,
            severity,
            message,
            device_id
     FROM   maintenance_alerts
     ORDER  BY ts DESC
     LIMIT  $1`,
    [limit]
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   PENDING COMMANDS (relay retry queue)
══════════════════════════════════════════════════════════════════════════ */

async function queuePendingCommand(deviceId, command, error) {
  await q(
    'INSERT INTO pending_commands (device_id, command, last_error) VALUES ($1,$2,$3)',
    [deviceId, command, error ?? null]
  );
}

async function getPendingCommands() {
  const { rows } = await q(
    `SELECT * FROM pending_commands
     WHERE  attempts < max_attempts
     AND    next_retry_at <= NOW()
     ORDER  BY created_at ASC`
  );
  return rows;
}

async function updatePendingCommand(id, attempts, error) {
  await q(
    `UPDATE pending_commands
     SET attempts = $1, last_error = $2, next_retry_at = NOW() + INTERVAL '5 minutes'
     WHERE id = $3`,
    [attempts, error, id]
  );
}

async function removePendingCommand(id) {
  await q('DELETE FROM pending_commands WHERE id = $1', [id]);
}

/* ══════════════════════════════════════════════════════════════════════════
   DASHBOARD / ADMIN AGGREGATES
══════════════════════════════════════════════════════════════════════════ */

async function getDashboardState() {
  const [device, user, latest, stats] = await Promise.all([
    getDevice('DEMO-001'),
    getUserByDeviceId('DEMO-001'),
    getLatestEnergy('DEMO-001'),
    getPaymentStats()
  ]);

  return {
    batteryLevel:  latest?.battery_level    ?? 75,
    generation:    latest?.generation_watts ?? 180,
    consumption:   latest?.consumption_watts ?? 135,
    powerEnabled:  device?.relay_state === 'on',
    walletBalance: user?.wallet_balance      ?? 0,
    dueAmount:     (user?.wallet_balance ?? 1) <= 0 ? 100 : 0,
    deviceId:      'DEMO-001',
    paymentStats:  stats
  };
}

async function getAdminSummary() {
  const [uRes, dRes, oRes, stats] = await Promise.all([
    q('SELECT COUNT(*)::int AS n FROM users'),
    q('SELECT COUNT(*)::int AS n FROM devices'),
    q("SELECT COUNT(*)::int AS n FROM devices WHERE is_active = FALSE"),
    getPaymentStats()
  ]);
  return {
    users:        uRes.rows[0].n,
    devices:      dRes.rows[0].n,
    offline:      oRes.rows[0].n,
    revenue:      stats.total_revenue,
    paymentStats: stats
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORTS  (same surface as the old SQLite db.js)
══════════════════════════════════════════════════════════════════════════ */
module.exports = {
  pool,
  runMigrations,
  seedDemoData,
  /* users */
  getUserByDeviceId,
  getUserById,
  updateWallet,
  setWalletBalance,
  getExpiredWalletUsers,
  /* devices */
  getDevice,
  getDeviceByUserId,
  setRelayState,
  /* energy */
  insertEnergyReading,
  getLatestEnergy,
  getEnergyHistory,
  getEnergyHistoryAsc,
  getEnergyHistory48h,
  /* payments */
  createPayment,
  completePayment,
  failPayment,
  getPaymentStats,
  getRecentPayments,
  getPaymentTrend,
  /* alerts */
  createAlert,
  getAlerts,
  getAlertSeverityCounts,
  /* ai */
  savePrediction,
  /* audit */
  getAuditTimeline,
  /* relay queue */
  queuePendingCommand,
  getPendingCommands,
  updatePendingCommand,
  removePendingCommand,
  /* aggregates */
  getDashboardState,
  getAdminSummary
};
