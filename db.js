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
const bcrypt = require('bcryptjs');

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
  max: parseInt(process.env.DB_POOL_MAX  || '20', 10),
  min: parseInt(process.env.DB_POOL_MIN  ||  '2', 10),
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true
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
      email          VARCHAR(255)  UNIQUE,
      password_hash  VARCHAR(255),
      role           VARCHAR(20)   NOT NULL DEFAULT 'customer',
      wallet_balance NUMERIC(12,2) DEFAULT 0,
      relay_unlocked BOOLEAN       DEFAULT FALSE,
      created_at     TIMESTAMPTZ   DEFAULT NOW()
    );
    -- Add columns to existing tables without destroying data
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email         VARCHAR(255) UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role          VARCHAR(20) NOT NULL DEFAULT 'customer';

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

    -- ── Product catalogue ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS product_categories (
      id          SERIAL       PRIMARY KEY,
      name        VARCHAR(128) NOT NULL,
      description TEXT,
      icon        VARCHAR(8),
      sort_order  INTEGER      DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL        PRIMARY KEY,
      category_id INTEGER       REFERENCES product_categories(id) ON DELETE CASCADE,
      name        VARCHAR(255)  NOT NULL,
      description TEXT,
      price       NUMERIC(12,2) NOT NULL,
      specs       JSONB         DEFAULT '{}',
      in_stock    BOOLEAN       DEFAULT TRUE,
      created_at  TIMESTAMPTZ   DEFAULT NOW()
    );

    -- Distinguish energy top-ups from physical product purchases on a payment
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'energy';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS product_name VARCHAR(255);

    -- ── Indexes ────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_energy_device_ts  ON energy_readings(device_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_user     ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_checkout ON payments(checkout_request_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_device     ON maintenance_alerts(device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pred_device       ON ai_predictions(device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_device      ON users(device_id);
    CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
  `);

  console.log('[DB] PostgreSQL migrations complete');
}

/* Upsert a named demo user by device_id, tolerating leftover rows from
 * earlier seed runs that may already hold the target email under a
 * different device_id (which would otherwise violate users_email_key). */
async function upsertDemoUser({ deviceId, pin, email, passwordHash, role, name, phone, walletBalance, relayUnlocked }) {
  const { rows: byEmail } = await q('SELECT id FROM users WHERE email = $1', [email]);
  const { rows: byDevice } = await q('SELECT id FROM users WHERE device_id = $1', [deviceId]);

  if (byEmail.length > 0 && (byDevice.length === 0 || byEmail[0].id !== byDevice[0].id)) {
    await q('UPDATE users SET email = NULL WHERE id = $1', [byEmail[0].id]);
  }

  await q(
    `INSERT INTO users (device_id, pin, email, password_hash, role, name, phone, wallet_balance, relay_unlocked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (device_id) DO UPDATE
       SET email         = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role`,
    [deviceId, pin, email, passwordHash, role, name, phone, walletBalance, relayUnlocked]
  );
}

/* ── Demo data seed ─────────────────────────────────────────────────────── */
async function seedDemoData() {
  /* ── Always ensure named demo accounts exist (safe to re-run) ── */
  const adminHash    = await bcrypt.hash(process.env.ADMIN_PASSWORD    || 'Admin@12345',    10);
  const customerHash = await bcrypt.hash(process.env.CUSTOMER_PASSWORD || 'Customer@12345', 10);

  await upsertDemoUser({
    deviceId: 'ADMIN-001', pin: '0000',
    email: process.env.ADMIN_EMAIL || 'admin@solarpayg.com',
    passwordHash: adminHash, role: 'admin', name: 'System Admin',
    phone: '+254700000000', walletBalance: 0, relayUnlocked: false
  });

  // DEMO-001 is the demo customer's device, so the email/password login
  // and the device-ID/PIN login share the same account.
  await upsertDemoUser({
    deviceId: 'DEMO-001', pin: '1234',
    email: 'customer@example.com',
    passwordHash: customerHash, role: 'customer', name: 'Demo Customer',
    phone: '+254722222222', walletBalance: 75, relayUnlocked: true
  });

  /* ── Seed device + readings only if DEMO-001 doesn't exist yet ── */
  const { rows } = await q("SELECT id FROM users WHERE device_id = 'DEMO-001'");
  if (rows.length > 0) return;

  const { rows: [user] } = await q(
    `INSERT INTO users (device_id, pin, phone, wallet_balance, relay_unlocked)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['DEMO-001', '1234', '254712345678', 50, true]
  );

  await q(
    `INSERT INTO devices (device_id, user_id, name, device_ip, relay_state, status, location)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['DEMO-001', user.id, 'Demo Solar Kit', '192.168.1.100', 'on', 'active', 'Nairobi, Kenya']
  );

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

  console.log('[DB] Demo data seeded  (deviceId: DEMO-001  pin: 1234)');
}

/* ── Product catalogue seed ─────────────────────────────────────────────── */
async function seedProducts() {
  const { rows } = await q('SELECT id FROM product_categories LIMIT 1');
  if (rows.length > 0) return; // already seeded

  const catalogue = [
    {
      name: 'Solar Panels', description: 'High-efficiency photovoltaic panels', icon: '☀️', sort_order: 1,
      products: [
        { name: '100W Monocrystalline Panel', description: 'Compact panel ideal for small systems and charging', price: 8500, specs: { wattage: '100W', type: 'Monocrystalline', efficiency: '21%', warranty: '10 years' } },
        { name: '200W Monocrystalline Panel', description: 'Mid-range panel for home lighting and appliances', price: 15000, specs: { wattage: '200W', type: 'Monocrystalline', efficiency: '21%', warranty: '10 years' } },
        { name: '300W Polycrystalline Panel', description: 'Budget-friendly panel for larger installations', price: 18000, specs: { wattage: '300W', type: 'Polycrystalline', efficiency: '18%', warranty: '5 years' } }
      ]
    },
    {
      name: 'Batteries', description: 'Deep-cycle storage batteries for solar systems', icon: '🔋', sort_order: 2,
      products: [
        { name: '100Ah Lithium Battery', description: 'Lightweight, long-life lithium-ion deep cycle battery', price: 22000, specs: { capacity: '100Ah', type: 'Lithium LiFePO4', cycles: '2000+', warranty: '3 years' } },
        { name: '200Ah AGM Deep Cycle', description: 'Maintenance-free AGM battery for reliable storage', price: 28000, specs: { capacity: '200Ah', type: 'AGM', cycles: '500+', warranty: '2 years' } }
      ]
    },
    {
      name: 'Inverters', description: 'Convert DC solar power to AC for home appliances', icon: '⚡', sort_order: 3,
      products: [
        { name: '1000W Pure Sine Wave Inverter', description: 'Powers TVs, lights, fans and small appliances', price: 12000, specs: { power: '1000W', waveform: 'Pure Sine Wave', input: '12V/24V DC', warranty: '1 year' } },
        { name: '2000W Pure Sine Wave Inverter', description: 'Handles fridges, washing machines and power tools', price: 19500, specs: { power: '2000W', waveform: 'Pure Sine Wave', input: '24V/48V DC', warranty: '1 year' } }
      ]
    },
    {
      name: 'Complete Kits', description: 'All-in-one solar kits ready for installation', icon: '🔌', sort_order: 4,
      products: [
        { name: 'Starter Kit 200W', description: 'Panel + 100Ah battery + 1000W inverter + controller. Powers basic home needs.', price: 35000, specs: { panel: '200W', battery: '100Ah', inverter: '1000W', warranty: '1 year bundle' } },
        { name: 'Home Kit 400W', description: 'Dual 200W panels + 200Ah battery + 2000W inverter. Full home power solution.', price: 65000, specs: { panel: '2×200W', battery: '200Ah', inverter: '2000W', warranty: '2 year bundle' } }
      ]
    },
    {
      name: 'Accessories', description: 'Cables, controllers, and mounting hardware', icon: '🔧', sort_order: 5,
      products: [
        { name: 'MPPT Charge Controller 40A', description: '40A MPPT controller for efficient battery charging', price: 3200, specs: { current: '40A', type: 'MPPT', voltage: '12V/24V', warranty: '1 year' } },
        { name: 'MC4 Connector Set (10 pairs)', description: 'Weatherproof solar cable connectors', price: 800, specs: { quantity: '10 pairs', rating: '30A / 1000V', material: 'UV-resistant' } },
        { name: 'Adjustable Mounting Brackets', description: 'Galvanized steel brackets for roof or ground mounting', price: 1500, specs: { material: 'Galvanized steel', fits: 'Most panel sizes', tilt: '0–45°' } }
      ]
    }
  ];

  let productCount = 0;
  for (const cat of catalogue) {
    const { rows: [{ id: catId }] } = await q(
      'INSERT INTO product_categories (name, description, icon, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [cat.name, cat.description, cat.icon, cat.sort_order]
    );
    for (const p of cat.products) {
      await q(
        'INSERT INTO products (category_id, name, description, price, specs) VALUES ($1,$2,$3,$4,$5)',
        [catId, p.name, p.description, p.price, JSON.stringify(p.specs)]
      );
      productCount++;
    }
  }
  console.log(`[DB] Product catalogue seeded (${catalogue.length} categories, ${productCount} products)`);
}

/* ══════════════════════════════════════════════════════════════════════════
   USER QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function getUserByDeviceId(deviceId) {
  const { rows } = await q('SELECT * FROM users WHERE device_id = $1', [deviceId]);
  return rows[0] ?? null;
}

async function getUserByEmail(email) {
  const { rows } = await q('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] ?? null;
}

async function createUser({ deviceId, name, email, passwordHash, phone, pin, role = 'customer' }) {
  const { rows } = await q(
    `INSERT INTO users (device_id, name, email, password_hash, phone, pin, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [deviceId, name || null, email?.toLowerCase() || null, passwordHash || null, phone || null, pin || '0000', role]
  );
  return rows[0];
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

/**
 * Auto-register a device the first time it reports telemetry, or refresh
 * its last-known IP/status on every subsequent report. This is what lets
 * a real ESP32 show up without a separate manual provisioning step.
 */
async function upsertDeviceHeartbeat({ deviceId, ip, name }) {
  await q(
    `INSERT INTO devices (device_id, device_ip, name, status, is_active, relay_state)
     VALUES ($1,$2,$3,'active',TRUE,'on')
     ON CONFLICT (device_id) DO UPDATE
       SET device_ip = EXCLUDED.device_ip,
           status    = 'active',
           is_active = TRUE`,
    [deviceId, ip || null, name || deviceId]
  );
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

/* Used to warm the AI models for every device at startup, not just one —
 * each row still carries its own device_id so callers can route it correctly. */
async function getEnergyHistory48hAllDevices() {
  const { rows } = await q(
    `SELECT * FROM energy_readings
     WHERE  recorded_at > NOW() - INTERVAL '48 hours'
     ORDER  BY recorded_at ASC`
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   PAYMENT QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function createPayment({ userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId, paymentType = 'energy', productId = null, productName = null }) {
  const { rows } = await q(
    `INSERT INTO payments
       (user_id, device_id, amount, phone_number, status, merchant_request_id, checkout_request_id, payment_type, product_id, product_name)
     VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9)
     RETURNING id`,
    [userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId, paymentType, productId, productName]
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

  // Product purchases are fulfilled physically — only energy top-ups credit the wallet/unlock power
  if (payment.payment_type !== 'product') {
    await updateWallet(payment.user_id, Number.parseFloat(payment.amount));
  }

  const { rows: updated } = await q(
    'SELECT * FROM payments WHERE checkout_request_id = $1',
    [checkoutRequestId]
  );
  return updated[0] ?? null;
}

async function getPaymentByCheckoutId(checkoutRequestId) {
  const { rows } = await q(
    'SELECT * FROM payments WHERE checkout_request_id = $1',
    [checkoutRequestId]
  );
  return rows[0] ?? null;
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

async function getPaymentsByUserId(userId, limit = 30) {
  const { rows } = await q(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getAlertsByUserId(userId, limit = 10) {
  const { rows } = await q(
    `SELECT * FROM maintenance_alerts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
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

async function getDashboardState(deviceId = 'DEMO-001') {
  const [device, user, latest, stats] = await Promise.all([
    getDevice(deviceId),
    getUserByDeviceId(deviceId),
    getLatestEnergy(deviceId),
    getPaymentStats()
  ]);

  return {
    batteryLevel:  latest?.battery_level     ?? 75,
    generation:    latest?.generation_watts  ?? 180,
    consumption:   latest?.consumption_watts ?? 135,
    voltage:       latest?.voltage           ?? 48,   // real sensor value for maintenance AI
    current:       latest?.current_amps      ?? 10,   // real sensor value for maintenance AI
    powerEnabled:  device?.relay_state === 'on',
    walletBalance: user?.wallet_balance       ?? 0,
    dueAmount:     (user?.wallet_balance ?? 0) <= 0 ? 100 : 0, // fix: was ?? 1 which hid null balances
    deviceId,
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
   PRODUCT CATALOGUE QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function getProductCatalogueWithCategories() {
  const { rows: cats } = await q(
    'SELECT * FROM product_categories ORDER BY sort_order'
  );
  const { rows: prods } = await q(
    'SELECT * FROM products WHERE in_stock = TRUE ORDER BY category_id, price'
  );
  return cats.map(c => ({
    ...c,
    products: prods.filter(p => p.category_id === c.id)
  }));
}

async function getProductById(id) {
  const { rows } = await q(
    `SELECT p.*, c.name AS category_name, c.icon AS category_icon
     FROM products p
     JOIN product_categories c ON c.id = p.category_id
     WHERE p.id = $1`,
    [id]
  );
  return rows[0] ?? null;
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
  getUserByEmail,
  createUser,
  getUserById,
  updateWallet,
  setWalletBalance,
  getExpiredWalletUsers,
  /* devices */
  getDevice,
  getDeviceByUserId,
  setRelayState,
  upsertDeviceHeartbeat,
  /* energy */
  insertEnergyReading,
  getLatestEnergy,
  getEnergyHistory,
  getEnergyHistoryAsc,
  getEnergyHistory48h,
  getEnergyHistory48hAllDevices,
  /* payments */
  createPayment,
  completePayment,
  getPaymentByCheckoutId,
  failPayment,
  getPaymentStats,
  getRecentPayments,
  getPaymentsByUserId,
  getPaymentTrend,
  /* alerts */
  createAlert,
  getAlerts,
  getAlertSeverityCounts,
  getAlertsByUserId,
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
  getAdminSummary,
  /* products */
  seedProducts,
  getProductCatalogueWithCategories,
  getProductById
};
