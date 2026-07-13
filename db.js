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
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');

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

if (!isLocal) {
  console.warn('[SECURITY] Database SSL certificate validation is disabled (rejectUnauthorized: false). '
    + 'In production, configure proper CA certificates and set rejectUnauthorized: true. '
    + 'Without this, a MITM attacker on the network path could read or modify all database traffic.');
}

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
    -- Password reset: only the SHA-256 hash of the emailed token is stored,
    -- so a database leak doesn't hand out working reset links.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash    VARCHAR(64);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
    -- Widen pin column to accommodate bcrypt hashes (was VARCHAR(20), too small for 60-char hashes)
    ALTER TABLE users ALTER COLUMN pin TYPE VARCHAR(255);

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
    -- Per-device telemetry auth key — issued by an admin when a device is
    -- provisioned. NULL means "not yet provisioned"; /api/telemetry falls
    -- back to the shared DEVICE_API_KEY env var for those.
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key VARCHAR(64);
    -- Last time this device successfully posted telemetry — drives the
    -- online/offline status shown on the admin dashboard (see isDeviceOnline
    -- below). NULL means it has never reported in.
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

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

    -- Data fix: category icons were originally seeded as emojis; the UI no
    -- longer renders them and the product style is text-only. seedProducts()
    -- only runs on an empty catalogue, so existing databases keep the old
    -- emoji values unless cleared here (idempotent).
    UPDATE product_categories SET icon = NULL WHERE icon IS NOT NULL;

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
 * different device_id (which would otherwise violate users_email_key).
 *
 * IMPORTANT: `pin` must be a bcrypt hash, not a plaintext value.
 * See seedDemoData() for the hashing call sites. */
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
           pin           = EXCLUDED.pin,
           password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role`,
    [deviceId, pin, email, passwordHash, role, name, phone, walletBalance, relayUnlocked]
  );
}

/* ── Demo data seed ─────────────────────────────────────────────────────── */
async function seedDemoData() {
  /* ── Migrate any existing plaintext PINs to bcrypt hashes ── */
  const { rows: plainPinUsers } = await q(
    `SELECT id, pin FROM users WHERE pin IS NOT NULL AND pin !~ '^\\$2'`
  );
  for (const u of plainPinUsers) {
    const hashedPin = await bcrypt.hash(u.pin, 10);
    await q('UPDATE users SET pin = $1 WHERE id = $2', [hashedPin, u.id]);
  }
  if (plainPinUsers.length > 0) {
    console.log(`[DB] Migrated ${plainPinUsers.length} plaintext PIN(s) to bcrypt hashes`);
  }

  /* ── Always ensure named demo accounts exist (safe to re-run) ── */
  const adminHash    = await bcrypt.hash(process.env.ADMIN_PASSWORD    || 'Admin@12345',    10);
  const customerHash = await bcrypt.hash(process.env.CUSTOMER_PASSWORD || 'Customer@12345', 10);
  const adminPinHash   = await bcrypt.hash('0000', 10);
  const customerPinHash = await bcrypt.hash('1234', 10);

  await upsertDemoUser({
    deviceId: 'ADMIN-001', pin: adminPinHash,
    email: process.env.ADMIN_EMAIL || 'admin@solarpayg.com',
    passwordHash: adminHash, role: 'admin', name: 'System Admin',
    phone: '+254700000000', walletBalance: 0, relayUnlocked: false
  });

  // DEMO-001 is the demo customer's device, so the email/password login
  // and the device-ID/PIN login share the same account.
  await upsertDemoUser({
    deviceId: 'DEMO-001', pin: customerPinHash,
    email: process.env.CUSTOMER_EMAIL || 'customer@example.com',
    passwordHash: customerHash, role: 'customer', name: 'Demo Customer',
    phone: '+254722222222', walletBalance: 75, relayUnlocked: true
  });

  /* ── Demo fleet across regions (idempotent — never clobbers real rows).
     Gives the fleet panel a realistic multi-region mix: Nairobi, Kisumu
     and Mombasa, with DEMO-004 running a failing battery (exercises the
     low-battery flag) and DEMO-005 deliberately inactive/offline. The
     ON CONFLICT branch only fills location where it's still NULL, so an
     admin-set region always wins. */
  const demoFleet = [
    ['DEMO-001', 'Demo Solar Kit',   'Nairobi, Kenya', true],
    ['DEMO-002', 'Kibera Homes Kit', 'Nairobi, Kenya', true],
    ['DEMO-003', 'Lakeside Kit A',   'Kisumu, Kenya',  true],
    ['DEMO-004', 'Lakeside Kit B',   'Kisumu, Kenya',  true],
    ['DEMO-005', 'Coast Depot Unit', 'Mombasa, Kenya', false]
  ];
  for (const [id, name, location, active] of demoFleet) {
    await q(
      `INSERT INTO devices (device_id, name, location, status, is_active, relay_state)
       VALUES ($1,$2,$3,'active',$4,'on')
       ON CONFLICT (device_id) DO UPDATE
         SET location = COALESCE(devices.location, EXCLUDED.location)`,
      [id, name, location, active]
    );
  }
  // Link the demo device to the demo customer so the Owner column isn't empty
  await q(
    `UPDATE devices d SET user_id = u.id
     FROM users u
     WHERE d.device_id = 'DEMO-001' AND u.device_id = 'DEMO-001' AND d.user_id IS NULL`
  );

  /* ── Seed readings only on a fresh database ── */
  const { rows } = await q('SELECT id FROM energy_readings LIMIT 1');
  if (rows.length > 0) return;

  // Users and devices are already upserted above — a fresh database only
  // needs an hour of starter readings per simulated device so the fleet
  // panel and charts have data before the live simulator's first tick.
  const starterBattery = { 'DEMO-001': 70, 'DEMO-002': 80, 'DEMO-003': 58, 'DEMO-004': 14 };
  const now = Date.now();
  for (const [deviceId, batt] of Object.entries(starterBattery)) {
    for (let i = 12; i >= 0; i--) {
      const ts = new Date(now - i * 5 * 60_000);
      const hour = ts.getHours();
      const seasonal = Math.sin(((hour - 6) * Math.PI) / 12) * 80 + 150;
      const gen = Math.max(0, seasonal + Math.random() * 30);
      await q(
        `INSERT INTO energy_readings
           (device_id, generation_watts, consumption_watts, battery_level, voltage, current_amps, power_output, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [deviceId, gen, 120 + Math.random() * 20, batt + Math.random() * 6 - 3, 48, 10, gen * 0.95, ts]
      );
    }
  }

  console.log('[DB] Demo data seeded  (deviceId: DEMO-001)');
}

/* ── Product catalogue seed ─────────────────────────────────────────────── */
async function seedProducts() {
  const { rows } = await q('SELECT id FROM product_categories LIMIT 1');
  if (rows.length > 0) return; // already seeded

  const catalogue = [
    {
      name: 'Solar Panels', description: 'High-efficiency photovoltaic panels', icon: null, sort_order: 1,
      products: [
        { name: '100W Monocrystalline Panel', description: 'Compact panel ideal for small systems and charging', price: 8500, specs: { wattage: '100W', type: 'Monocrystalline', efficiency: '21%', warranty: '10 years' } },
        { name: '200W Monocrystalline Panel', description: 'Mid-range panel for home lighting and appliances', price: 15000, specs: { wattage: '200W', type: 'Monocrystalline', efficiency: '21%', warranty: '10 years' } },
        { name: '300W Polycrystalline Panel', description: 'Budget-friendly panel for larger installations', price: 18000, specs: { wattage: '300W', type: 'Polycrystalline', efficiency: '18%', warranty: '5 years' } }
      ]
    },
    {
      name: 'Batteries', description: 'Deep-cycle storage batteries for solar systems', icon: null, sort_order: 2,
      products: [
        { name: '100Ah Lithium Battery', description: 'Lightweight, long-life lithium-ion deep cycle battery', price: 22000, specs: { capacity: '100Ah', type: 'Lithium LiFePO4', cycles: '2000+', warranty: '3 years' } },
        { name: '200Ah AGM Deep Cycle', description: 'Maintenance-free AGM battery for reliable storage', price: 28000, specs: { capacity: '200Ah', type: 'AGM', cycles: '500+', warranty: '2 years' } }
      ]
    },
    {
      name: 'Inverters', description: 'Convert DC solar power to AC for home appliances', icon: null, sort_order: 3,
      products: [
        { name: '1000W Pure Sine Wave Inverter', description: 'Powers TVs, lights, fans and small appliances', price: 12000, specs: { power: '1000W', waveform: 'Pure Sine Wave', input: '12V/24V DC', warranty: '1 year' } },
        { name: '2000W Pure Sine Wave Inverter', description: 'Handles fridges, washing machines and power tools', price: 19500, specs: { power: '2000W', waveform: 'Pure Sine Wave', input: '24V/48V DC', warranty: '1 year' } }
      ]
    },
    {
      name: 'Complete Kits', description: 'All-in-one solar kits ready for installation', icon: null, sort_order: 4,
      products: [
        { name: 'Starter Kit 200W', description: 'Panel + 100Ah battery + 1000W inverter + controller. Powers basic home needs.', price: 35000, specs: { panel: '200W', battery: '100Ah', inverter: '1000W', warranty: '1 year bundle' } },
        { name: 'Home Kit 400W', description: 'Dual 200W panels + 200Ah battery + 2000W inverter. Full home power solution.', price: 65000, specs: { panel: '2×200W', battery: '200Ah', inverter: '2000W', warranty: '2 year bundle' } }
      ]
    },
    {
      name: 'Accessories', description: 'Cables, controllers, and mounting hardware', icon: null, sort_order: 5,
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
  /* Always bcrypt-hash the PIN — callers pass plaintext only. There is
     deliberately no pass-through for values that already "look like a hash"
     ($2...): if a caller-controlled string reached storage verbatim, the
     caller would get to choose the stored digest. (Pre-hashed demo PINs go
     through upsertDemoUser, which does not call this.) */
  const finalPin = await bcrypt.hash(String(pin ?? '0000'), 10);

  const { rows } = await q(
    `INSERT INTO users (device_id, name, email, password_hash, phone, pin, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [deviceId, name || null, email?.toLowerCase() || null, passwordHash || null, phone || null, finalPin, role]
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

/* ── Password reset ──────────────────────────────────────────────────────
   The raw token goes to the user by email; only its SHA-256 hash is stored.
   A new request overwrites any previous token (old links stop working). */
async function setPasswordResetToken(userId, tokenHash, expiresAt) {
  await q(
    'UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
    [tokenHash, expiresAt, userId]
  );
}

async function getUserByValidResetToken(tokenHash) {
  const { rows } = await q(
    'SELECT * FROM users WHERE reset_token_hash = $1 AND reset_token_expires > NOW()',
    [tokenHash]
  );
  return rows[0] ?? null;
}

async function completePasswordReset(userId, passwordHash) {
  await q(
    `UPDATE users
     SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL
     WHERE id = $2`,
    [passwordHash, userId]
  );
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
    `INSERT INTO devices (device_id, device_ip, name, status, is_active, relay_state, last_seen)
     VALUES ($1,$2,$3,'active',TRUE,'on',NOW())
     ON CONFLICT (device_id) DO UPDATE
       SET device_ip = COALESCE(EXCLUDED.device_ip, devices.device_ip),
           status    = 'active',
           is_active = TRUE,
           last_seen = NOW()`,
    [deviceId, ip || null, name || deviceId]
  );
}

/* How long (ms) a device can go without reporting telemetry before the
   admin dashboard marks it offline. Configurable since firmware report
   intervals vary; defaults to 60s (the ESP32 firmware reports every 5s,
   so this tolerates several missed sends before flapping to offline). */
function deviceOfflineTimeoutMs() {
  return parseInt(process.env.DEVICE_OFFLINE_TIMEOUT_MS || '60000', 10);
}

function isDeviceOnline(lastSeen) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < deviceOfflineTimeoutMs();
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

async function getAllDevices() {
  // Owner columns feed the admin fleet panel's Owner column; the LATERAL
  // join pulls each device's most recent battery reading so the fleet view
  // can flag low-battery units without N+1 queries.
  const { rows } = await q(
    `SELECT d.*, u.email AS owner_email, u.name AS owner_name,
            e.battery_level, e.recorded_at AS battery_at
     FROM devices d
     LEFT JOIN users u ON u.id = d.user_id
     LEFT JOIN LATERAL (
       SELECT battery_level, recorded_at
       FROM energy_readings er
       WHERE er.device_id = d.device_id
       ORDER BY er.recorded_at DESC
       LIMIT 1
     ) e ON TRUE
     ORDER BY d.created_at DESC`
  );
  return rows.map(d => ({ ...d, online: isDeviceOnline(d.last_seen) }));
}

/** Link a device to a customer account (or unlink with userId = null). */
async function assignDeviceToUser(deviceId, userId) {
  const { rows } = await q(
    'UPDATE devices SET user_id = $1 WHERE device_id = $2 RETURNING *',
    [userId, deviceId]
  );
  return rows[0] ?? null;
}

/**
 * Issue (or re-issue) a unique telemetry API key for a device. Creates the
 * device row if it doesn't exist yet (admin pre-provisioning a unit before
 * it's ever powered on), or rotates the key if it's already provisioned.
 */
async function provisionDevice(deviceId, name, location) {
  const apiKey = crypto.randomBytes(24).toString('hex');
  const { rows } = await q(
    `INSERT INTO devices (device_id, name, api_key, status, is_active, relay_state, location)
     VALUES ($1, $2, $3, 'active', TRUE, 'on', $4)
     ON CONFLICT (device_id) DO UPDATE
       SET api_key  = EXCLUDED.api_key,
           name     = COALESCE(EXCLUDED.name, devices.name),
           location = COALESCE(EXCLUDED.location, devices.location)
     RETURNING *`,
    [deviceId, name || deviceId, apiKey, location || null]
  );
  return rows[0];
}

/** Set/replace the region (location) shown for a device on the fleet panel. */
async function setDeviceLocation(deviceId, location) {
  const { rows } = await q(
    'UPDATE devices SET location = $1 WHERE device_id = $2 RETURNING *',
    [location || null, deviceId]
  );
  return rows[0] ?? null;
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

/** Hourly-averaged readings for the last N hours, oldest first — feeds the
 *  Analysis Board's Energy tab (solar generation curve, battery state,
 *  voltage/current), which otherwise has nothing to plot against real time. */
async function getEnergyHourly(deviceId, hours = 24) {
  const { rows } = await q(
    `SELECT date_trunc('hour', recorded_at)        AS hour,
            AVG(generation_watts)::numeric(10,2)   AS generation_watts,
            AVG(consumption_watts)::numeric(10,2)  AS consumption_watts,
            AVG(battery_level)::numeric(5,2)       AS battery_level,
            AVG(voltage)::numeric(6,2)             AS voltage,
            AVG(current_amps)::numeric(6,2)        AS current_amps
     FROM   energy_readings
     WHERE  device_id  = $1
     AND    recorded_at > NOW() - ($2 || ' hours')::interval
     GROUP  BY hour
     ORDER  BY hour ASC`,
    [deviceId, hours]
  );
  return rows;
}

/** Daily-averaged generation/consumption for the last N days, oldest first —
 *  feeds the Energy tab's "Generation vs Consumption" bar chart. Readings
 *  are average power (W); converting to kWh assumes that average held for
 *  the full day (avg_watts * 24 / 1000) — an approximation, same kind the
 *  rest of this app already uses for "energy today" estimates. */
async function getEnergyDaily(deviceId, days = 7) {
  const { rows } = await q(
    `SELECT recorded_at::date::text               AS day,
            AVG(generation_watts)::numeric(10,2)  AS generation_watts,
            AVG(consumption_watts)::numeric(10,2) AS consumption_watts
     FROM   energy_readings
     WHERE  device_id  = $1
     AND    recorded_at > NOW() - ($2 || ' days')::interval
     GROUP  BY recorded_at::date
     ORDER  BY day ASC`,
    [deviceId, days]
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
  /* Only a 'pending' payment may be completed. Without this guard, a duplicate
     or replayed callback for an already-completed payment would credit the
     wallet a second time for the same M-Pesa transaction. */
  const { rows } = await q(
    `UPDATE payments
     SET status = 'completed', mpesa_receipt_number = $1, mpesa_ref = $1,
         result_code = $2, result_desc = $3, processed_at = NOW()
     WHERE checkout_request_id = $4 AND status = 'pending'
     RETURNING *`,
    [receiptNumber, resultCode, resultDesc, checkoutRequestId]
  );
  const payment = rows[0];
  if (!payment) return null;

  // Product purchases are fulfilled physically — only energy top-ups credit the wallet/unlock power
  if (payment.payment_type !== 'product') {
    await updateWallet(payment.user_id, Number.parseFloat(payment.amount));
  }

  return payment;
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
     WHERE checkout_request_id = $3 AND status = 'pending'`,
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

/** Monthly payment-reliability score per top customer, for the Analysis
 *  Board's "Credit Score Trend" chart — there's no real credit bureau score
 *  in this system, so this derives a heuristic from actual payment behavior:
 *  starts at 60, +5 per completed payment that month, -12 per failed one,
 *  -1 for a month with no activity at all, clamped to [0, 100]. Bucketing is
 *  done in JS (not SQL date_trunc) to avoid Postgres session-timezone
 *  shifting a payment into the wrong month. */
async function getCustomerCreditScoreTrend(months = 12, customerLimit = 3) {
  const { rows: customers } = await q(
    `SELECT u.id, u.name,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'completed'), 0) AS total_paid
     FROM   users u
     JOIN   payments p ON p.user_id = u.id
     WHERE  u.role = 'customer'
     GROUP  BY u.id, u.name
     ORDER  BY total_paid DESC
     LIMIT  $1`,
    [customerLimit]
  );

  const monthStarts = Array.from({ length: months }, (_, i) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (months - 1) + i);
    return d;
  });
  const labels = monthStarts.map((d) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }));
  const keyOf = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;

  /* Demo/seed data often has several accounts named e.g. "Test User" —
     append the id only when a name actually collides within this result
     set, so real, distinctly-named customers don't get a noisy suffix. */
  const nameCounts = new Map();
  for (const c of customers) nameCounts.set(c.name, (nameCounts.get(c.name) || 0) + 1);
  const displayName = (c) => {
    const base = c.name || `Customer ${c.id}`;
    return nameCounts.get(c.name) > 1 ? `${base} (#${c.id})` : base;
  };

  const customerTrends = [];
  for (const customer of customers) {
    const { rows: payments } = await q(
      `SELECT created_at, status FROM payments WHERE user_id = $1 AND created_at >= $2`,
      [customer.id, monthStarts[0]]
    );

    const buckets = new Map();
    for (const p of payments) {
      const key = keyOf(new Date(p.created_at));
      const bucket = buckets.get(key) || { completed: 0, failed: 0 };
      if (p.status === 'completed') bucket.completed++;
      else if (p.status === 'failed') bucket.failed++;
      buckets.set(key, bucket);
    }

    let score = 60;
    const scores = monthStarts.map((d) => {
      const bucket = buckets.get(keyOf(d)) || { completed: 0, failed: 0 };
      score = Math.max(0, Math.min(100,
        score + bucket.completed * 5 - bucket.failed * 12 - (bucket.completed + bucket.failed === 0 ? 1 : 0)));
      return Math.round(score);
    });

    customerTrends.push({ id: customer.id, name: displayName(customer), scores });
  }

  return { labels, customers: customerTrends };
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
    // Offline = never reported in, or hasn't reported within the configured
    // timeout — derived from last_seen, not the admin-set is_active flag
    // (is_active only reflects manual enable/disable, not liveness).
    q(
      `SELECT COUNT(*)::int AS n FROM devices
       WHERE last_seen IS NULL OR last_seen < NOW() - ($1 || ' milliseconds')::interval`,
      [deviceOfflineTimeoutMs()]
    ),
    getPaymentStats()
  ]);
  return {
    users:        uRes.rows[0].n,
    devices:      dRes.rows[0].n,
    offline:      oRes.rows[0].n,
    online:       dRes.rows[0].n - oRes.rows[0].n,
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
  setPasswordResetToken,
  getUserByValidResetToken,
  completePasswordReset,
  /* devices */
  getDevice,
  getDeviceByUserId,
  getAllDevices,
  setRelayState,
  upsertDeviceHeartbeat,
  provisionDevice,
  assignDeviceToUser,
  setDeviceLocation,
  /* energy */
  insertEnergyReading,
  getLatestEnergy,
  getEnergyHistory,
  getEnergyHistoryAsc,
  getEnergyHourly,
  getEnergyDaily,
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
  getCustomerCreditScoreTrend,
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
