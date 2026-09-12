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

/* The .env file (local Postgres) must win over any system-level DATABASE_URL
   (e.g. a Neon remote set in the shell profile) — but ONLY DATABASE_URL.
   A blanket { override: true } would also clobber env vars callers set
   deliberately: the test suites blank RESEND_API_KEY/AT_API_KEY in the
   servers they spawn so login tests can't fire real emails/SMS, and they
   pass custom PORTs the same way. In production (Render / Docker) there is
   no .env file, so this is a no-op — only the system env var is used. */
const { parsed: dotenvParsed } = require('dotenv').config();
if (dotenvParsed?.DATABASE_URL) process.env.DATABASE_URL = dotenvParsed.DATABASE_URL;
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
  /* Neon free tier autosuspends the compute after ~5 min idle; waking it
     can take 3-30 s (cold start). 5 s here meant pg abandoned the very
     connection that would have woken the DB — boot-time migrations and the
     first simulator ticks failed with "Connection terminated due to
     connection timeout". 30 s matches Neon's documented recommendation. */
  connectionTimeoutMillis: 30_000,
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
      email_verified BOOLEAN       DEFAULT FALSE,
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
    -- Email verification: new self-signed-up accounts confirm their address
    -- before their password works. email_verified is added with DEFAULT TRUE
    -- so every PRE-EXISTING row is backfilled as verified (nobody gets locked
    -- out of an account they already use), then the default is flipped to
    -- FALSE so accounts created from here on start unverified. On a fresh
    -- database CREATE TABLE already made the column DEFAULT FALSE, so the ADD
    -- COLUMN IF NOT EXISTS is a no-op and only the SET DEFAULT runs.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE;
    -- Verification tokens follow the reset-token pattern: only the SHA-256
    -- hash of the emailed token is stored.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_hash    VARCHAR(64);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires TIMESTAMPTZ;
    -- Widen pin column to accommodate bcrypt hashes (was VARCHAR(20), too small for 60-char hashes)
    ALTER TABLE users ALTER COLUMN pin TYPE VARCHAR(255);
    -- Daily weather + energy-tip alert opt-in (default ON — customers can
    -- turn it off from the Account tab of their portal).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_weather_alerts BOOLEAN DEFAULT TRUE;

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
    -- Firmware version reported by the device's own telemetry (e.g. "1.0.0").
    -- Lets the admin fleet panel show what each unit actually runs, not just
    -- the OTA target the backend offered. NULL until the device reports in.
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(32);
    -- Optional exact site coordinates for per-site weather. NULL = fall back
    -- to geocoding devices.location, then to WEATHER_LAT/WEATHER_LON. Kept
    -- separate from the free-text location column so a display label
    -- ("Nairobi, Kenya") and a precise position can coexist.
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6);
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS lon NUMERIC(9,6);
    -- Solar panel model reported by the device's own telemetry (e.g.
    -- "MONO-330W"). Drives the Engineer panel's panel-health readout.
    -- NULL until the device reports in with a panelType.
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS panel_type VARCHAR(64);

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

    -- ── Appliances (owner-registered, for the appliance monitor upgrade) ───
    -- Software-only: there is no per-appliance sub-metering hardware. An
    -- owner logs the appliances on their circuit with an optional
    -- rated_wattage (the nameplate draw); when absent, the server falls back
    -- to a typical wattage for the category (see appliances.js) so heavy-
    -- usage flagging still works without requiring the owner to know exact
    -- numbers.
    CREATE TABLE IF NOT EXISTS appliances (
      id             SERIAL       PRIMARY KEY,
      device_id      VARCHAR(64)  NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      name           VARCHAR(128) NOT NULL,
      category       VARCHAR(32)  NOT NULL DEFAULT 'other',
      rated_wattage  NUMERIC(10,2),
      created_at     TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_appliances_device ON appliances(device_id);

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

    -- ── Migration tracking ────────────────────────────────────────────────
    -- Records which one-time data migrations have been applied so
    -- destructive or expensive data fixes run exactly once, not every boot.
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ   DEFAULT NOW()
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

    -- ── Organizations (multi-tenant) ───────────────────────────────────────
    -- Every user, device, and payment belongs to exactly one organization.
    -- The 'default' org is created on first boot and pre-existing rows are
    -- backfilled into it, so single-tenant installs keep working unchanged;
    -- org-scoped admins (role='org_admin') only ever see their own org.
    CREATE TABLE IF NOT EXISTS organizations (
      id         SERIAL       PRIMARY KEY,
      name       VARCHAR(128) NOT NULL,
      slug       VARCHAR(64)  NOT NULL UNIQUE,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );
    -- Tenant profile fields — editable by the org's own admins from the
    -- Org Settings page. slug stays the stable, read-only tenant identifier;
    -- everything else is presentation/contact metadata.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS description   TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone         VARCHAR(32);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS location      VARCHAR(256);

    INSERT INTO organizations (name, slug)
    SELECT 'Default Organization', 'default'
    WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'default');

    ALTER TABLE users    ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
    ALTER TABLE devices  ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);

    -- Backfill every pre-existing row into the default org (idempotent —
    -- rows already assigned keep their org). Payments are backfilled from
    -- their owning user's org when the user has one (which at migration
    -- time is the default org anyway).
    UPDATE users    SET organization_id = (SELECT id FROM organizations WHERE slug = 'default') WHERE organization_id IS NULL;
    UPDATE devices  SET organization_id = (SELECT id FROM organizations WHERE slug = 'default') WHERE organization_id IS NULL;
    UPDATE payments SET organization_id = COALESCE(
      (SELECT u.organization_id FROM users u WHERE u.id = payments.user_id),
      (SELECT id FROM organizations WHERE slug = 'default')
    ) WHERE organization_id IS NULL;

    -- ── Firmware versions (OTA updates) ────────────────────────────────────
    -- One row per published binary; exactly one row per org may be active at
    -- a time (enforced by activateFirmwareVersion's transaction). Checksum
    -- is the SHA-256 hex of the binary — devices refuse to apply on mismatch.
    -- Multi-tenant: every version belongs to an organization, so org admins
    -- can publish OTA updates only to their own fleet. Version strings are
    -- unique per org (the global UNIQUE below is migrated to a composite
    -- (organization_id, version) constraint further down), so two tenants can
    -- independently publish a "1.2.0".
    CREATE TABLE IF NOT EXISTS firmware_versions (
      id         BIGSERIAL    PRIMARY KEY,
      version    VARCHAR(32)  NOT NULL,
      filename   VARCHAR(128) NOT NULL,          -- server-generated UUID .bin name on disk
      checksum   CHAR(64)     NOT NULL,          -- SHA-256 hex
      changelog  TEXT,
      size_bytes BIGINT       DEFAULT 0,
      is_active  BOOLEAN      DEFAULT FALSE,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );
    -- OTA hardening: ECDSA P-256 signature over the binary's SHA-256 (base64
    -- DER), produced at upload time from FIRMWARE_SIGNING_KEY. NULL when no
    -- signing key was configured — devices with a baked-in root key reject
    -- unsigned binaries (fail-closed), so NULL only ever ships to dev fleets.
    ALTER TABLE firmware_versions ADD COLUMN IF NOT EXISTS signature TEXT;
    -- Staged rollout: what % of the fleet to target (0-100, deterministic
    -- hash bucket per device) and an optional region filter (case-insensitive
    -- substring of devices.location). Devices outside the rollout get no
    -- update — 1% → 10% → 50% → 100% is just re-activating with a higher %.
    ALTER TABLE firmware_versions ADD COLUMN IF NOT EXISTS rollout_pct INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE firmware_versions ADD COLUMN IF NOT EXISTS rollout_region VARCHAR(128);
    -- Auto-paused after 2 consecutive boot failures of this version (see
    -- recordBootReport / pauseActiveFirmwareByVersion). Paused firmware is
    -- never offered to devices again until an admin re-activates it.
    ALTER TABLE firmware_versions ADD COLUMN IF NOT EXISTS rollout_paused BOOLEAN NOT NULL DEFAULT FALSE;
    -- Multi-tenant ownership. Backfilled into the default org so
    -- pre-tenant installs keep working unchanged, exactly like users/devices.
    ALTER TABLE firmware_versions ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
    UPDATE firmware_versions SET organization_id = (SELECT id FROM organizations WHERE slug = 'default')
    WHERE organization_id IS NULL;

    -- Version uniqueness is per-org, not global: the inline UNIQUE from the
    -- original CREATE TABLE (constraint firmware_versions_version_key) is
    -- dropped and replaced with a composite (organization_id, version). Both
    -- steps are guarded so a second migration run is a no-op.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'firmware_versions_version_key') THEN
        ALTER TABLE firmware_versions DROP CONSTRAINT firmware_versions_version_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_firmware_org_version') THEN
        ALTER TABLE firmware_versions
          ADD CONSTRAINT uq_firmware_org_version UNIQUE (organization_id, version);
      END IF;
    END $$;

    -- ── Firmware boot reports (OTA rollback) ──────────────────────────────
    -- Devices POST here after booting into a freshly-flashed version,
    -- declaring it OK (status='ok', after a stable-uptime window) or failing
    -- (status='fail'). Two consecutive 'fail' rows for the same
    -- (device, version) trigger the automatic rollout pause — the server
    -- half of the rollback story (the device half keeps its last-good
    -- version in NVS and re-downloads it when quarantined).
    CREATE TABLE IF NOT EXISTS firmware_boot_reports (
      id               BIGSERIAL    PRIMARY KEY,
      device_id        VARCHAR(64)  NOT NULL,
      firmware_version VARCHAR(32)  NOT NULL,
      status           VARCHAR(16)  NOT NULL,
      created_at       TIMESTAMPTZ  DEFAULT NOW()
    );
    -- Org scoping for the 2-strike auto-pause: a boot-failure in org A must
    -- not pause org B's rollout. Populated from the reporting device's org
    -- (backfilled below for rows recorded before this migration).
    ALTER TABLE firmware_boot_reports ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
    UPDATE firmware_boot_reports r
       SET organization_id = d.organization_id
      FROM devices d
     WHERE r.device_id = d.device_id
       AND r.organization_id IS NULL;

    -- Data fix: category icons were originally seeded as emojis; the UI no
    -- longer renders them and the product style is text-only. seedProducts()
    -- only runs on an empty catalogue, so existing databases keep the old
    -- emoji values. Guarded by schema_migrations to run exactly once — the
    -- UPDATE only fires when the migration row was JUST inserted (applied_at
    -- matches the current transaction timestamp), not on subsequent restarts,
    -- so admin-set custom icons are never silently destroyed.
    INSERT INTO schema_migrations (name)
    SELECT 'clear_category_icons'
    WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'clear_category_icons');

    UPDATE product_categories SET icon = NULL
    WHERE icon IS NOT NULL
      AND EXISTS (SELECT 1 FROM schema_migrations
                  WHERE name = 'clear_category_icons' AND applied_at = NOW());

    -- ── Indexes ────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_energy_device_ts  ON energy_readings(device_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_user     ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
    -- Idempotency anchor for M-Pesa callbacks: a checkoutRequestId is unique
    -- per STK push, so a replayed or duplicated callback can never double-
    -- create a payment row (completePayment already guards against double-
    -- crediting; this guards against double-creating). Postgres treats NULLs
    -- as distinct in unique indexes, so this also allows the (never-used)
    -- NULL checkout id case without a partial predicate — and, importantly,
    -- the bare-column form makes ON CONFLICT (checkout_request_id) work.
    --
    -- This must NOT be a plain CREATE UNIQUE INDEX on every boot: a table
    -- that predates the index may hold duplicate checkout ids (the column
    -- was never constrained, and createPayment wasn't idempotent), which
    -- would fail the migration and brick startup. So: create once, and if
    -- duplicates exist, keep the earliest row per checkout id and clear the
    -- id on the rest (they were duplicate creations of the same payment).
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_payments_checkout') THEN
        BEGIN
          CREATE UNIQUE INDEX uq_payments_checkout ON payments(checkout_request_id);
        EXCEPTION WHEN unique_violation THEN
          UPDATE payments p
             SET checkout_request_id = NULL
           WHERE checkout_request_id IS NOT NULL
             AND p.id NOT IN (
                   SELECT MIN(id) FROM payments
                    WHERE checkout_request_id IS NOT NULL
                    GROUP BY checkout_request_id
                 );
          CREATE UNIQUE INDEX uq_payments_checkout ON payments(checkout_request_id);
        END;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_payments_checkout ON payments(checkout_request_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_device     ON maintenance_alerts(device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pred_device       ON ai_predictions(device_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_device      ON users(device_id);
    CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
    -- Index for getDeviceByUserId() — runs on every customer portal visit
    CREATE INDEX IF NOT EXISTS idx_devices_user      ON devices(user_id);
    -- Index for fleet-wide time-range queries (e.g. getEnergyHistory48hAllDevices)
    CREATE INDEX IF NOT EXISTS idx_energy_recorded   ON energy_readings(recorded_at);
    -- Index for getAlertsByUserId() — customer alert lookups
    CREATE INDEX IF NOT EXISTS idx_alerts_user       ON maintenance_alerts(user_id);
    -- Active-firmware lookup (GET /api/firmware/latest) — one active row per org
    CREATE INDEX IF NOT EXISTS idx_firmware_active   ON firmware_versions (is_active) WHERE is_active;
    -- Org-scoped active lookup (org admins' /latest + activate deactivation)
    CREATE INDEX IF NOT EXISTS idx_firmware_org_active ON firmware_versions (organization_id, is_active) WHERE is_active;
    -- Boot-report trail for the 2-strike rollback check (per device+version)
    CREATE INDEX IF NOT EXISTS idx_boot_reports_device ON firmware_boot_reports (device_id, firmware_version, created_at DESC);
    -- Org-scoped boot-fail counts (getDistinctFailingDevices / getRolloutStats)
    CREATE INDEX IF NOT EXISTS idx_boot_reports_org ON firmware_boot_reports (organization_id, firmware_version, created_at DESC);
    -- Multi-tenant lookup indexes — every org-scoped aggregate scans these
    CREATE INDEX IF NOT EXISTS idx_users_org     ON users(organization_id);
    CREATE INDEX IF NOT EXISTS idx_devices_org   ON devices(organization_id);
    CREATE INDEX IF NOT EXISTS idx_payments_org  ON payments(organization_id);
  `);

  console.log('[DB] PostgreSQL migrations complete');
}

/* ══════════════════════════════════════════════════════════════════════════
   ORGANIZATION QUERIES (multi-tenant)
══════════════════════════════════════════════════════════════════════════ */

/* Create a new organization. slug is the stable tenant identifier used in
   URLs; name is human-facing. Returns the new row. */
async function createOrganization({ name, slug }) {
  const { rows } = await q(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
    [name, slug]
  );
  return rows[0];
}

async function getOrganizationById(id) {
  const { rows } = await q('SELECT * FROM organizations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function getOrganizationBySlug(slug) {
  const { rows } = await q('SELECT * FROM organizations WHERE slug = $1', [slug]);
  return rows[0] ?? null;
}

/* Update a tenant's profile fields (Org Settings page). slug is deliberately
   NOT updatable here — it's the stable tenant identifier. Returns the
   updated row, or null when the org doesn't exist. */
async function updateOrganization(id, { name, description = null, contactEmail = null, phone = null, location = null } = {}) {
  const { rows } = await q(
    `UPDATE organizations
     SET name         = COALESCE($2, name),
         description   = COALESCE($3, description),
         contact_email = COALESCE($4, contact_email),
         phone         = COALESCE($5, phone),
         location      = COALESCE($6, location)
     WHERE id = $1
     RETURNING *`,
    [id, name || null, description, contactEmail, phone, location]
  );
  return rows[0] ?? null;
}

/* Every user in an org, oldest first — the membership roster shown on the
   Org Settings page. Scoped by organization_id in SQL, so an org admin can
   never enumerate another tenant's users. */
async function getOrgMembers(orgId) {
  const { rows } = await q(
    `SELECT id, device_id, name, email, role, phone, wallet_balance, created_at
     FROM   users
     WHERE  organization_id = $1
     ORDER  BY created_at ASC, id ASC`,
    [orgId]
  );
  return rows;
}

/* All organizations with their fleet/user/admin counts, oldest first —
   feeds the super-admin org directory. */
async function getOrganizations() {
  const { rows } = await q(`
    SELECT o.*,
           COUNT(DISTINCT d.id)::int AS device_count,
           COUNT(DISTINCT u.id)::int AS user_count,
           COUNT(DISTINCT CASE WHEN u.role = 'org_admin' THEN u.id END)::int AS admin_count
    FROM   organizations o
    LEFT JOIN devices d ON d.organization_id = o.id
    LEFT JOIN users   u ON u.organization_id = o.id
    GROUP  BY o.id
    ORDER  BY o.created_at ASC, o.id ASC
  `);
  return rows;
}

/* Assign an organization to a user (used when provisioning org admins or
   moving a customer between tenants). Returns the updated user row. */
async function setUserOrganization(userId, organizationId) {
  const { rows } = await q(
    'UPDATE users SET organization_id = $1 WHERE id = $2 RETURNING *',
    [organizationId, userId]
  );
  return rows[0] ?? null;
}

/* Default-org lookup helper. Organizations table is created by
   runMigrations(), and the 'default' row is inserted there — so callers
   only hit this after migrations have run (same guarantee as every other
   query below). */
async function getDefaultOrganizationId() {
  const { rows } = await q("SELECT id FROM organizations WHERE slug = 'default'");
  return rows[0]?.id ?? null;
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

  /* Demo accounts live in the default org — on a fresh database the
     organizations table + default row were just created by runMigrations(),
     so the subselect always resolves. On an existing database the org
     columns were backfilled, so the ON CONFLICT branch leaves org alone. */
  /* Demo accounts are seeded with email_verified = TRUE: they carry
     well-known public credentials (shown right on the login page), so
     gating them behind an inbox check would lock everyone out of the demo.
     Re-verifying on every boot also self-heals any local flip. */
  await q(
    `INSERT INTO users (device_id, pin, email, password_hash, role, name, phone, wallet_balance, relay_unlocked, organization_id, email_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, (SELECT id FROM organizations WHERE slug = 'default'), TRUE)
     ON CONFLICT (device_id) DO UPDATE
       SET email         = EXCLUDED.email,
           pin           = EXCLUDED.pin,
           password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role,
           email_verified = TRUE`,
    [deviceId, pin, email, passwordHash, role, name, phone, walletBalance, relayUnlocked]
  );
}

/* ── Demo data seed ─────────────────────────────────────────────────────── */
async function seedDemoData() {
  /* ── Migrate any existing plaintext PINs to bcrypt hashes ── */
  /* Uses NOT LIKE instead of regex to avoid PostgreSQL backslash-escape
     ambiguity across different standard_conforming_strings settings.
     bcrypt hashes always start with $2a$, $2b$, or $2y$, so PINs that
     do NOT begin with '$2' are plaintext and need migration. */
  const { rows: plainPinUsers } = await q(
    `SELECT id, pin FROM users WHERE pin IS NOT NULL AND pin NOT LIKE '$2%'`
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
  const engineerHash = await bcrypt.hash(process.env.ENGINEER_PASSWORD || 'Engineer@12345', 10);
  const adminPinHash   = await bcrypt.hash('0000', 10);
  const customerPinHash = await bcrypt.hash('1234', 10);

  await upsertDemoUser({
    deviceId: 'ADMIN-001', pin: adminPinHash,
    email: process.env.ADMIN_EMAIL || 'admin@solarpayg.com',
    passwordHash: adminHash, role: 'admin', name: 'System Admin',
    phone: '+254700000000', walletBalance: 0, relayUnlocked: false
  });

  // Field/technical staff — read-only diagnostics (Engineer panel). Same
  // email+password login as the admin; the role drives the /engineer.html
  // redirect after login and the /api/engineer/* role gates. The PIN is
  // seeded only because the column is NOT NULL — engineers sign in by email.
  await upsertDemoUser({
    deviceId: 'ENGINEER-001', pin: adminPinHash,
    email: process.env.ENGINEER_EMAIL || 'engineer@solarpayg.com',
    passwordHash: engineerHash, role: 'engineer', name: 'Field Engineer',
    phone: '+254733333333', walletBalance: 0, relayUnlocked: false
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
      `INSERT INTO devices (device_id, name, location, status, is_active, relay_state, organization_id)
       VALUES ($1,$2,$3,'active',$4,'on', (SELECT id FROM organizations WHERE slug = 'default'))
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

async function createUser({ deviceId, name, email, passwordHash, phone, pin, role = 'customer', organizationId = null, emailVerified = false }) {
  /* Always bcrypt-hash the PIN — callers pass plaintext only. There is
     deliberately no pass-through for values that already "look like a hash"
     ($2...): if a caller-controlled string reached storage verbatim, the
     caller would get to choose the stored digest. (Pre-hashed demo PINs go
     through upsertDemoUser, which does not call this.) */
  const finalPin = await bcrypt.hash(String(pin ?? '0000'), 10);

  /* New users land in the default org unless the caller says otherwise —
     an org admin provisioning a customer for their own tenant passes
     organizationId explicitly. */
  const orgId = organizationId ?? (await getDefaultOrganizationId());

  const { rows } = await q(
    `INSERT INTO users (device_id, name, email, password_hash, phone, pin, role, organization_id, email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [deviceId, name || null, email?.toLowerCase() || null, passwordHash || null, phone || null, finalPin, role, orgId, !!emailVerified]
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

/* ── Daily weather alert recipients ───────────────────────────────────────
   Everyone who opted in AND has at least one reachable channel (phone or
   email). The daily cron builds one message per customer and sends it to
   whichever channels exist — sms.js/mailer.js no-op for the missing ones.
   Also carries the user's linked device position (exact coords + free-text
   location) so the digest can resolve per-site weather instead of sending
   everyone the Nairobi forecast. A LATERAL join keeps it to one device per
   user even if a user somehow owns several units. */
async function getDailyWeatherRecipients() {
  const { rows } = await q(`
    SELECT u.id, u.name, u.device_id, u.phone, u.email,
           d.location, d.lat, d.lon
    FROM   users u
    LEFT JOIN LATERAL (
      SELECT location, lat, lon
      FROM   devices
      WHERE  user_id = u.id
      ORDER  BY created_at ASC, id ASC
      LIMIT  1
    ) d ON TRUE
    WHERE  u.role = 'customer'
      AND  u.daily_weather_alerts = TRUE
      AND  (u.phone IS NOT NULL AND u.phone <> '' OR u.email IS NOT NULL AND u.email <> '')
  `);
  return rows;
}

async function setDailyWeatherAlerts(userId, enabled) {
  await q('UPDATE users SET daily_weather_alerts = $2 WHERE id = $1', [userId, !!enabled]);
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

/* ── Password change (signed-in user rotating their own password) ────────
   Same UPDATE as completePasswordReset — clearing the reset token means a
   stolen reset link can't race a deliberate password change. */
async function updatePassword(userId, passwordHash) {
  await q(
    `UPDATE users
     SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL
     WHERE id = $2`,
    [passwordHash, userId]
  );
}

/* ── Email verification ──────────────────────────────────────────────────
   Mirrors the password-reset token pattern: the raw token goes to the user
   by email, only its SHA-256 hash is stored, and a new request overwrites
   the previous token. Storing the token also flips the account back to
   unverified, so a re-issued link always requires (re)verification. */
async function setEmailVerificationToken(userId, tokenHash, expiresAt) {
  await q(
    `UPDATE users
     SET verification_token_hash = $1, verification_token_expires = $2, email_verified = FALSE
     WHERE id = $3`,
    [tokenHash, expiresAt, userId]
  );
}

async function getUserByValidVerificationToken(tokenHash) {
  const { rows } = await q(
    'SELECT * FROM users WHERE verification_token_hash = $1 AND verification_token_expires > NOW()',
    [tokenHash]
  );
  return rows[0] ?? null;
}

async function markEmailVerified(userId) {
  await q(
    `UPDATE users
     SET email_verified = TRUE, verification_token_hash = NULL, verification_token_expires = NULL
     WHERE id = $1`,
    [userId]
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

/* Customers approaching a power cut: positive balance at or under the warning
   threshold, power still on. The NOT EXISTS clause is the warning dedup — the
   cron writes a low_balance alert for every user it warns, so nobody is
   re-warned (or re-SMSed) until 24 hours have passed. */
async function getLowBalanceUsers(threshold) {
  const { rows } = await q(`
    SELECT u.*, d.device_id AS linked_device_id
    FROM   users   u
    LEFT JOIN devices d ON d.user_id = u.id
    WHERE  u.role = 'customer'
    AND    u.wallet_balance > 0
    AND    u.wallet_balance <= $1
    AND    u.relay_unlocked = TRUE
    AND    NOT EXISTS (
             SELECT 1 FROM maintenance_alerts a
             WHERE  a.user_id = u.id
             AND    a.type = 'low_balance'
             AND    a.created_at > NOW() - INTERVAL '24 hours'
           )
  `, [threshold]);
  return rows;
}

/* True if this user already has an alert of `type` newer than `hours` ago.
   The wallet-expiry cron re-sees the same user every run until the relay lock
   is acked by the device (relay_unlocked only flips FALSE on ack), so its
   alert + SMS must dedup on the alert trail, not on relay state. */
async function hasRecentAlert(userId, type, hours) {
  const { rows } = await q(
    `SELECT 1 FROM maintenance_alerts
     WHERE user_id = $1 AND type = $2
     AND   created_at > NOW() - make_interval(hours => $3::int)
     LIMIT 1`,
    [userId, type, hours]
  );
  return rows.length > 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   DEVICE QUERIES
══════════════════════════════════════════════════════════════════════════ */

const realtime = require('./realtime');

/* Cached device→org resolution for live broadcasts. Every broadcast needs
   the device's org to scope delivery to the right tenant, but re-querying
   on the hot telemetry path would double every insert. Org assignment
   rarely changes, so a 10-minute TTL is plenty — worst case a re-assigned
   unit's events are scoped to the old org for up to 10 minutes. */
const _orgCache = new Map(); // deviceId -> { orgId, at }
const ORG_CACHE_TTL_MS = 10 * 60 * 1000;

async function deviceOrgCached(deviceId) {
  const hit = _orgCache.get(deviceId);
  if (hit && Date.now() - hit.at < ORG_CACHE_TTL_MS) return hit.orgId;
  try {
    const { rows } = await q('SELECT organization_id FROM devices WHERE device_id = $1', [deviceId]);
    const orgId = rows[0]?.organization_id ?? null;
    _orgCache.set(deviceId, { orgId, at: Date.now() });
    return orgId;
  } catch (err) {
    console.warn('[Live] org lookup failed for', deviceId, ':', err.message);
    return null;
  }
}

async function getDevice(deviceId) {
  const { rows } = await q('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
  return rows[0] ?? null;
}

/**
 * Auto-register a device the first time it reports telemetry, or refresh
 * its last-known IP/status on every subsequent report. This is what lets
 * a real ESP32 show up without a separate manual provisioning step.
 *
 * firmwareVersion is the version string the device reported in its own
 * telemetry (see buildTelemetryJSON in the firmware). It's stored only when
 * non-empty — a device that stops sending it (or an older build without the
 * field) must not wipe out the last known version. Same rule for panelType.
 */
async function upsertDeviceHeartbeat({ deviceId, ip, name, firmwareVersion, panelType, organizationId = null }) {
  /* Auto-registered devices (first-ever telemetry) land in the caller's org
     when one is supplied, otherwise the default org — the org column is
     deliberately NOT updated on conflict, so an org cannot be silently
     changed by a stray heartbeat from a device already assigned elsewhere. */
  await q(
    `INSERT INTO devices (device_id, device_ip, name, status, is_active, relay_state, last_seen, organization_id)
     VALUES ($1,$2,$3,'active',TRUE,'on',NOW(), COALESCE($4, (SELECT id FROM organizations WHERE slug = 'default')))
     ON CONFLICT (device_id) DO UPDATE
       SET device_ip = COALESCE(EXCLUDED.device_ip, devices.device_ip),
           status    = 'active',
           is_active = TRUE,
           last_seen = NOW(),
           /* NULLIF('', …) -> NULL, so an empty/missing value never
              overwrites the last known good one. Explicit ::VARCHAR cast
              so Postgres can pin the parameter type. */
           firmware_version = COALESCE(NULLIF($5::VARCHAR, ''), devices.firmware_version),
           panel_type       = COALESCE(NULLIF($6::VARCHAR, ''), devices.panel_type)`,
    [deviceId, ip || null, name || deviceId, organizationId ?? null, firmwareVersion || null, panelType || null]
  );
  /* Live: a device just reported in — flip it online on every connected
     board the moment the heartbeat lands. */
  const orgId = await deviceOrgCached(deviceId);
  realtime.broadcast('heartbeat', {
    deviceId, orgId, ip: ip || null,
    firmware_version: firmwareVersion || null,
    panel_type: panelType || null,
    online: true
  });
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
  /* Live: relay toggles are operator-relevant — surface them on the boards. */
  if (device) {
    realtime.broadcast('event', { kind: 'relay', deviceId, orgId: device.organization_id ?? null, state: relayStr });
  }
}

async function getAllDevices(orgId = null) {
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
     WHERE  ($1::int IS NULL OR d.organization_id = $1)
     ORDER BY d.created_at DESC`,
    [orgId]
  );
  return rows.map(d => ({ ...d, online: isDeviceOnline(d.last_seen) }));
}

/* Engineer panel — fleet view. Richer than the admin fleet: alongside the
   device row it carries the org name, the LATEST energy reading (panel
   health), a measured telemetry cadence (average seconds between the most
   recent ~50 energy readings + how many gaps exceeded 15 s — a unit that
   should report every 5 s but only pings every 60 s is visible at a
   glance), and the org's active OTA target so an engineer can spot units
   stuck on an old build. `online` is derived from last_seen like the
   admin fleet. */
async function getEngineerFleet() {
  const { rows } = await q(`
    SELECT d.*, o.name AS org_name,
           e.voltage, e.current_amps, e.generation_watts, e.battery_level,
           e.consumption_watts, e.recorded_at AS last_reading_at,
           cad.avg_interval_s, cad.gap_count,
           fw.version       AS ota_target,
           fw.rollout_pct   AS ota_rollout_pct,
           fw.rollout_paused AS ota_rollout_paused
    FROM   devices d
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN LATERAL (
      SELECT voltage, current_amps, generation_watts, battery_level, consumption_watts, recorded_at
      FROM   energy_readings er
      WHERE  er.device_id = d.device_id
      ORDER  BY er.recorded_at DESC
      LIMIT  1
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND(AVG(sec)::numeric, 1) AS avg_interval_s,
             COUNT(*) FILTER (WHERE sec > 15)::int AS gap_count
      FROM (
        SELECT EXTRACT(EPOCH FROM (recorded_at - LAG(recorded_at) OVER (ORDER BY recorded_at))) AS sec
        FROM (
          SELECT recorded_at FROM energy_readings er2
          WHERE  er2.device_id = d.device_id
          ORDER  BY er2.recorded_at DESC
          LIMIT  50
        ) recent
      ) t
    ) cad ON TRUE
    LEFT JOIN LATERAL (
      SELECT version, rollout_pct, rollout_paused
      FROM   firmware_versions fv
      WHERE  fv.organization_id = d.organization_id
        AND  fv.is_active = TRUE
      ORDER  BY fv.created_at DESC
      LIMIT  1
    ) fw ON TRUE
    ORDER  BY d.created_at DESC`
  );
  return rows.map(d => ({ ...d, online: isDeviceOnline(d.last_seen) }));
}

/* Recent firmware boot reports for one device (newest first) — the engineer
   panel's per-device OTA history: which version each report declared ok/fail
   and when. */
async function getDeviceBootReports(deviceId, limit = 10) {
  const { rows } = await q(
    `SELECT device_id, firmware_version, status, created_at
     FROM   firmware_boot_reports
     WHERE  device_id = $1
     ORDER  BY created_at DESC
     LIMIT  $2`,
    [deviceId, limit]
  );
  return rows;
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
async function provisionDevice(deviceId, name, location, organizationId = null) {
  const apiKey = crypto.randomBytes(24).toString('hex');
  /* Newly provisioned units belong to the caller's org (org admin) or the
     default org (super-admin / no org context). On conflict (key rotation)
     the org is deliberately untouched — rotating a key must not reassign
     the device to another tenant. */
  const { rows } = await q(
    `INSERT INTO devices (device_id, name, api_key, status, is_active, relay_state, location, organization_id)
     VALUES ($1, $2, $3, 'active', TRUE, 'on', $4, COALESCE($5, (SELECT id FROM organizations WHERE slug = 'default')))
     ON CONFLICT (device_id) DO UPDATE
       SET api_key  = EXCLUDED.api_key,
           name     = COALESCE(EXCLUDED.name, devices.name),
           location = COALESCE(EXCLUDED.location, devices.location)
     RETURNING *`,
    [deviceId, name || deviceId, apiKey, location || null, organizationId ?? null]
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

/* Set (or clear, with null) the device's exact site coordinates. These take
   precedence over geocoding devices.location when resolving per-site
   weather. Returns the updated device row, or null when the device doesn't
   exist. */
async function setDeviceCoordinates(deviceId, lat, lon) {
  const { rows } = await q(
    `UPDATE devices SET lat = $2, lon = $3 WHERE device_id = $1 RETURNING *`,
    [deviceId, lat ?? null, lon ?? null]
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
  /* Live: every stored reading is pushed to connected boards. The org is
     resolved once per device per 10 min (cached), keeping the hot path cheap. */
  const orgId = await deviceOrgCached(data.deviceId);
  realtime.broadcast('reading', {
    deviceId: data.deviceId, orgId,
    generation_watts:  data.generation,
    consumption_watts: data.consumption,
    battery_level:     data.batteryLevel,
    voltage:           data.voltage,
    current_amps:      data.current
  });
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
     AND    recorded_at > NOW() - make_interval(hours => $2)
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
     AND    recorded_at > NOW() - make_interval(days => $2)
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
   APPLIANCE QUERIES (owner appliance monitor upgrade)
══════════════════════════════════════════════════════════════════════════ */

/** Average total consumption over the trailing N days — the baseline that
 *  appliance rated wattages are compared against to flag heavy usage. Falls
 *  back to the single latest reading when there isn't a week of history yet
 *  (new device), and to null when there is no reading at all. */
async function getAverageConsumption(deviceId, days = 7) {
  const { rows } = await q(
    `SELECT AVG(consumption_watts)::numeric(10,2) AS avg_consumption
     FROM   energy_readings
     WHERE  device_id  = $1
     AND    recorded_at > NOW() - make_interval(days => $2)`,
    [deviceId, days]
  );
  if (rows[0]?.avg_consumption != null) return rows[0].avg_consumption;
  const latest = await getLatestEnergy(deviceId);
  return latest?.consumption_watts ?? null;
}

async function createAppliance({ deviceId, name, category, ratedWattage = null }) {
  const { rows } = await q(
    `INSERT INTO appliances (device_id, name, category, rated_wattage)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [deviceId, name, category, ratedWattage]
  );
  return rows[0];
}

async function getAppliancesByDevice(deviceId) {
  const { rows } = await q(
    'SELECT * FROM appliances WHERE device_id = $1 ORDER BY created_at ASC, id ASC',
    [deviceId]
  );
  return rows;
}

async function getApplianceById(id) {
  const { rows } = await q('SELECT * FROM appliances WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Full replace of the editable fields — callers read-modify-write (fetch
 *  the existing row, merge in whatever the owner changed, pass the result
 *  here), same pattern as setDeviceCoordinates. ratedWattage may be null
 *  (owner clearing their override back to the category default). */
async function updateAppliance(id, { name, category, ratedWattage = null }) {
  const { rows } = await q(
    `UPDATE appliances SET name = $2, category = $3, rated_wattage = $4
     WHERE id = $1 RETURNING *`,
    [id, name, category, ratedWattage]
  );
  return rows[0] ?? null;
}

async function deleteAppliance(id) {
  await q('DELETE FROM appliances WHERE id = $1', [id]);
}

/* ══════════════════════════════════════════════════════════════════════════
   PAYMENT QUERIES
══════════════════════════════════════════════════════════════════════════ */

async function createPayment({ userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId, paymentType = 'energy', productId = null, productName = null, organizationId = null }) {
  /* Idempotent by design: checkoutRequestId is the M-Pesa idempotency key.
     If the same STK push is re-sent (client retry, Safaricom replay), we
     return the ORIGINAL payment row instead of creating a duplicate — the
     uq_payments_checkout index enforces this at the DB level too, so even
     a racing double-request collapses to one row. */
  /* Multi-tenant: payments inherit their org from the paying user, falling
     back to the default org for legacy/unknown callers. Storing it on the
     payment row (not deriving via JOIN at read time) keeps every org-scoped
     aggregate a single-table scan on idx_payments_org. */
  const { rows } = await q(
    `INSERT INTO payments
       (user_id, device_id, amount, phone_number, status, merchant_request_id, checkout_request_id, payment_type, product_id, product_name, organization_id)
     SELECT $1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,
            COALESCE($10, (SELECT u.organization_id FROM users u WHERE u.id = $1),
                          (SELECT id FROM organizations WHERE slug = 'default'))
     ON CONFLICT (checkout_request_id) DO NOTHING
     RETURNING id`,
    [userId, deviceId, amount, phoneNumber, merchantRequestId, checkoutRequestId, paymentType, productId, productName, organizationId ?? null]
  );
  if (rows[0]) return rows[0];
  /* Duplicate checkoutRequestId — fetch and return the original row's id. */
  const existing = await q(
    'SELECT id FROM payments WHERE checkout_request_id = $1',
    [checkoutRequestId]
  );
  return existing.rows[0] ?? null;
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

/** Persists the FraudDetector's confidence for a completed payment onto its
 *  own row — fraud_score defaults to 0 (not flagged), so unflagged payments
 *  never need a write. Durable alternative to reading in-memory detector
 *  state, which is per-process and wiped on every restart. */
async function setPaymentFraudScore(paymentId, score) {
  await q('UPDATE payments SET fraud_score = $1 WHERE id = $2', [score, paymentId]);
}

/** Recent completed payments with their fraud score, for the admin Fraud
 *  Risk chart — real amount/score pairs instead of the old mock data. */
async function getFraudRiskPayments(limit = 60, orgId = null) {
  const { rows } = await q(
    `SELECT amount, fraud_score, created_at
     FROM   payments
     WHERE  status = 'completed'
     AND    ($1::int IS NULL OR organization_id = $1)
     ORDER  BY created_at DESC
     LIMIT  $2`,
    [orgId, limit]
  );
  return rows;
}

/* orgId null → all orgs (super-admin). The single-table filter keeps every
   org-scoped stats call on idx_payments_org. */
async function getPaymentStats(orgId = null) {
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
    WHERE ($1::int IS NULL OR organization_id = $1)
  `, [orgId]);
  return s;
}

async function getRecentPayments(limit = 20, orgId = null) {
  const { rows } = await q(
    `SELECT p.*, u.device_id AS user_device_id
     FROM   payments p
     LEFT JOIN users u ON p.user_id = u.id
     WHERE  ($2::int IS NULL OR p.organization_id = $2)
     ORDER  BY p.created_at DESC
     LIMIT  $1`,
    [limit, orgId]
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

async function getPaymentTrend(orgId = null) {
  const { rows } = await q(`
    SELECT created_at::date::text                                          AS day,
           COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0)     AS revenue,
           COUNT(*)::int                                                   AS total
    FROM   payments
    WHERE  ($1::int IS NULL OR organization_id = $1)
    GROUP  BY created_at::date
    ORDER  BY day ASC
    LIMIT  14
  `, [orgId]);
  return rows;
}

/** Monthly payment-reliability score per top customer, for the Analysis
 *  Board's "Credit Score Trend" chart — there's no real credit bureau score
 *  in this system, so this derives a heuristic from actual payment behavior:
 *  starts at 60, +5 per completed payment that month, -12 per failed one,
 *  -1 for a month with no activity at all, clamped to [0, 100]. Bucketing is
 *  done in JS (not SQL date_trunc) to avoid Postgres session-timezone
 *  shifting a payment into the wrong month. */
async function getCustomerCreditScoreTrend(months = 12, customerLimit = 3, orgId = null) {
  const { rows: customers } = await q(
    `SELECT u.id, u.name,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'completed'), 0) AS total_paid
     FROM   users u
     JOIN   payments p ON p.user_id = u.id
     WHERE  u.role = 'customer'
     AND    ($2::int IS NULL OR u.organization_id = $2)
     GROUP  BY u.id, u.name
     ORDER  BY total_paid DESC
     LIMIT  $1`,
    [customerLimit, orgId]
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
  /* Live: alerts drive the boards' attention — push them out as they fire. */
  const orgId = deviceId ? await deviceOrgCached(deviceId) : null;
  realtime.broadcast('event', { kind: 'alert', deviceId: deviceId ?? null, orgId, severity, message });
}

/* Alerts are scoped through their owning user (and, for device-level
   alerts with no user, through the device's org). The LEFT JOINs keep rows
   whose user/device rows have since been deleted visible to org-scoped
   callers when they can't be attributed to any org — safer to show an
   orphaned alert than to hide a real incident. */
async function getAlerts(limit = 20, orgId = null) {
  const { rows } = await q(
    `SELECT a.*
     FROM   maintenance_alerts a
     LEFT JOIN users   u ON u.id = a.user_id
     LEFT JOIN devices d ON d.device_id = a.device_id
     WHERE  ($1::int IS NULL
             OR u.organization_id = $1
             OR d.organization_id = $1
             OR (u.id IS NULL AND d.id IS NULL))
     ORDER  BY a.created_at DESC
     LIMIT  $2`,
    [orgId, limit]
  );
  return rows;
}

async function getAlertSeverityCounts(orgId = null) {
  const { rows } = await q(
    `SELECT a.severity, COUNT(*)::int AS count
     FROM   maintenance_alerts a
     LEFT JOIN users   u ON u.id = a.user_id
     LEFT JOIN devices d ON d.device_id = a.device_id
     WHERE  ($1::int IS NULL
             OR u.organization_id = $1
             OR d.organization_id = $1
             OR (u.id IS NULL AND d.id IS NULL))
     GROUP  BY a.severity`,
    [orgId]
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

/**
 * Retention: energy_readings and ai_predictions are append-only time series
 * with no other pruning path (the simulator inserts 4 rows / 30 s, and every
 * dashboard forecast poll adds a prediction row) — without a cutoff they grow
 * until the Neon storage limit. Returns deleted counts for the caller's log.
 */
async function pruneOldRows(energyDays, predictionDays) {
  const energy = await q(
    'DELETE FROM energy_readings WHERE recorded_at < NOW() - make_interval(days => $1)',
    [energyDays]
  );
  const predictions = await q(
    'DELETE FROM ai_predictions WHERE created_at < NOW() - make_interval(days => $1)',
    [predictionDays]
  );
  return { energyDeleted: energy.rowCount, predictionsDeleted: predictions.rowCount };
}

/* ══════════════════════════════════════════════════════════════════════════
   AUDIT TIMELINE
══════════════════════════════════════════════════════════════════════════ */

async function getAuditTimeline(limit = 30, orgId = null) {
  const { rows } = await q(
    `SELECT 'payment'             AS category,
            id, created_at        AS ts,
            status                AS severity,
            amount::text          AS detail,
            device_id             AS ref_id
     FROM   payments
     WHERE  ($1::int IS NULL OR organization_id = $1)
     UNION ALL
     SELECT 'alert',
            a.id, a.created_at,
            a.severity,
            a.message,
            a.device_id
     FROM   maintenance_alerts a
     LEFT JOIN users   u ON u.id = a.user_id
     LEFT JOIN devices d ON d.device_id = a.device_id
     WHERE  ($1::int IS NULL
             OR u.organization_id = $1
             OR d.organization_id = $1
             OR (u.id IS NULL AND d.id IS NULL))
     ORDER  BY ts DESC
     LIMIT  $2`,
    [orgId, limit]
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

async function getDashboardState(deviceId = 'DEMO-001', orgId = null) {
  const [device, user, latest, stats] = await Promise.all([
    getDevice(deviceId),
    getUserByDeviceId(deviceId),
    getLatestEnergy(deviceId),
    getPaymentStats(orgId)
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

async function getAdminSummary(orgId = null) {
  const [uRes, dRes, oRes, stats] = await Promise.all([
    q('SELECT COUNT(*)::int AS n FROM users WHERE ($1::int IS NULL OR organization_id = $1)', [orgId]),
    q('SELECT COUNT(*)::int AS n FROM devices WHERE ($1::int IS NULL OR organization_id = $1)', [orgId]),
    // Offline = never reported in, or hasn't reported within the configured
    // timeout — derived from last_seen, not the admin-set is_active flag
    // (is_active only reflects manual enable/disable, not liveness).
    q(
      `SELECT COUNT(*)::int AS n FROM devices
       WHERE (last_seen IS NULL OR last_seen < NOW() - make_interval(secs => $1 / 1000.0))
       AND   ($2::int IS NULL OR organization_id = $2)`,
      [deviceOfflineTimeoutMs(), orgId]
    ),
    getPaymentStats(orgId)
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
   FIRMWARE (OTA) QUERIES
══════════════════════════════════════════════════════════════════════════ */

/** Stage a new firmware version WITHOUT activating it. Uploads land with
 *  is_active = FALSE and only reach devices after an admin explicitly
 *  activates the row (activateFirmwareVersion) — a broken binary can be
 *  uploaded and discarded without ever targeting the fleet. Duplicate
 *  `version` violates the UNIQUE constraint (pg error 23505) and is surfaced
 *  by the caller as a 409. */
/* How many devices have a per-device api_key (non-NULL). Used by the OTA
   pause threshold (OTA_PAUSE_PCT) to make the 2-strike value scale with
   the fleet — at 50k devices with keys, OTA_PAUSE_PCT=1 ≅ 500 devices
   must fail before the rollout pauses.  Returns 0 when no devices match,
   which causes the percentage path to fall back to the absolute minimum. */
async function getCountOfProvisionedDevices(orgId = null) {
  const { rows: [r] } = await q(
    'SELECT COUNT(*)::int AS n FROM devices WHERE api_key IS NOT NULL AND ($1::int IS NULL OR organization_id = $1)',
    [orgId]
  );
  return r?.n ?? 0;
}

async function insertFirmwareVersion({ version, filename, checksum, changelog = null, sizeBytes = 0, signature = null, organizationId = null }) {
  /* New versions land in the caller's org (org admin) or the default org
     (super-admin without ?orgId=) — COALESCE keeps legacy uploads working. */
  const { rows } = await q(
    `INSERT INTO firmware_versions (version, filename, checksum, changelog, size_bytes, signature, is_active, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,FALSE, COALESCE($7, (SELECT id FROM organizations WHERE slug = 'default')))
     RETURNING *`,
    [version, filename, checksum, changelog, sizeBytes, signature, organizationId]
  );
  return rows[0];
}

/* Activate a staged firmware version — the only way a version becomes the
 *  OTA target. Atomic: deactivates whatever is currently active within the
 *  version's organization, then marks this row active. Returns null when the
 *  id doesn't exist.
 *
 *  Multi-tenant: `organizationId` pins the org. When it's null (super-admin
 *  activating without ?orgId=) the scope is resolved from the target row's
 *  own organization_id, so one org's activation can never deactivate another
 *  tenant's rollout.
 *
 *  rolloutPct / rolloutRegion set the staged-rollout envelope for the
 *  activation; defaults (100 / null) reproduce the pre-rollout behavior of
 *  targeting the whole fleet. Re-activating also clears any auto/manual
 *  rollout_paused flag, which is how a paused rollout is resumed.
 *
 *  The advisory lock is per-org (hashtext on org + key), so concurrent
 *  activations within one tenant serialize while different tenants publish
 *  independently. */
async function activateFirmwareVersion(id, { rolloutPct = 100, rolloutRegion = null } = {}, organizationId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: target } = await client.query(
      'SELECT id, organization_id FROM firmware_versions WHERE id = $1', [id]
    );
    if (target.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    /* Scope of this activation: the caller's org, else the version's own. */
    const scope = organizationId ?? target[0].organization_id;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('firmware_publish_' || $1))", [String(scope ?? 'global')]);
    /* The target must belong to the scope — an org admin activating another
       org's version is a cross-tenant op and must resolve to "not found". */
    if (scope !== null && target[0].organization_id !== scope) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      'UPDATE firmware_versions SET is_active = FALSE WHERE is_active = TRUE AND organization_id = $1',
      [scope]
    );
    const { rows } = await client.query(
      `UPDATE firmware_versions
       SET is_active = TRUE, rollout_pct = $2, rollout_region = $3, rollout_paused = FALSE
       WHERE id = $1 RETURNING *`,
      [id, rolloutPct, rolloutRegion || null]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* The current OTA target for an org, excluding auto/manually paused versions
 * — a paused rollout must stop being offered immediately. orgId null (only
 * reachable from the super-admin global view) matches any org's latest. */
async function getActiveFirmware(orgId = null) {
  const { rows } = await q(
    `SELECT * FROM firmware_versions
     WHERE is_active = TRUE AND rollout_paused = FALSE
       AND ($1::int IS NULL OR organization_id = $1)
     ORDER BY created_at DESC LIMIT 1`,
    [orgId]
  );
  return rows[0] ?? null;
}

/* The latest active target for an org (including paused) — feeds the admin
   rollout-status endpoint so a paused rollout still shows who the target is.
   The LEFT JOIN to organizations supplies org_name for the super-admin
   cross-org view (mirrors listFirmwareVersions). */
async function getLatestFirmware(orgId = null) {
  const { rows } = await q(
    `SELECT fv.*, o.name AS org_name
     FROM firmware_versions fv
     LEFT JOIN organizations o ON o.id = fv.organization_id
     WHERE fv.is_active = TRUE
       AND ($1::int IS NULL OR fv.organization_id = $1)
     ORDER BY fv.created_at DESC LIMIT 1`,
    [orgId]
  );
  return rows[0] ?? null;
}

/* Re-sign (or sign for the first time) an existing binary — used when the
 * signing key was generated after upload, or rotated since. */
async function setFirmwareSignature(id, signature) {
  const { rows } = await q(
    'UPDATE firmware_versions SET signature = $1 WHERE id = $2 RETURNING *',
    [signature, id]
  );
  return rows[0] ?? null;
}

/* ── Boot reports (2-strike rollback) ──────────────────────────────────── */

async function recordBootReport({ deviceId, version, status, organizationId = null }) {
  /* The reporting device's org (resolved by the route from the device row) —
     the 2-strike auto-pause counts failures within one org only. Falls back
     to the device's org via subselect for legacy callers. */
  /* $1 is used both as the INSERT value and inside the scalar subquery —
     the explicit ::VARCHAR pins its type so Postgres doesn't reject the
     statement with "inconsistent types deduced for parameter $1". */
  await q(
    `INSERT INTO firmware_boot_reports (device_id, firmware_version, status, organization_id)
     VALUES ($1,$2,$3, COALESCE($4, (SELECT d.organization_id FROM devices d WHERE d.device_id = $1::VARCHAR),
                                    (SELECT id FROM organizations WHERE slug = 'default')))`,
    [deviceId, version, status, organizationId]
  );
  /* Live: OTA outcomes are exactly what a fleet engineer watches for. */
  realtime.broadcast('event', {
    kind: 'ota', deviceId, version, status, orgId: organizationId ?? null
  });
}

/* How many DISTINCT devices within an org reported a boot-failure for this
 * version within the window (hours). The fleet-wide auto-pause requires
 * evidence from 2+ devices of the SAME org — a single buggy or compromised
 * device, or a different tenant's failures, must not pause a rollout for
 * everyone (each affected device still rolls itself back locally via
 * quarantine + the /latest `previous` pointer). */
async function getDistinctFailingDevices(version, orgId = null, hours = 24) {
  const { rows: [r] } = await q(
    `SELECT COUNT(DISTINCT device_id)::int AS n
     FROM firmware_boot_reports
     WHERE firmware_version = $1 AND status = 'fail'
       AND ($2::int IS NULL OR organization_id = $2)
       AND created_at > NOW() - make_interval(hours => $3)`,
    [version, orgId, hours]
  );
  return r?.n ?? 0;
}

/* Boot-fail stats for the admin rollout-status endpoint: how many fail
 * reports and how many distinct devices in the last `hours`, within one org,
 * alongside the pause threshold, so an operator can see how close a rollout
 * is to being auto-paused. */
async function getRolloutStats(version, orgId = null, hours = 24) {
  const { rows: [r] } = await q(
    `SELECT COUNT(*)::int                 AS fail_reports,
            COUNT(DISTINCT device_id)::int AS failing_devices
     FROM firmware_boot_reports
     WHERE firmware_version = $1 AND status = 'fail'
       AND ($2::int IS NULL OR organization_id = $2)
       AND created_at > NOW() - make_interval(hours => $3)`,
    [version, orgId, hours]
  );
  return r ?? { fail_reports: 0, failing_devices: 0 };
}

/* Pause the ACTIVE firmware matching a version string — used by the 2-strike
 * auto-rollback path (the device reports its own target version, not a row
 * id). Only touches the active row of the reporting device's org so a
 * different tenant's same-named version can't be paused by a stray report. */
async function pauseActiveFirmwareByVersion(version, orgId = null) {
  const { rows } = await q(
    `UPDATE firmware_versions SET rollout_paused = TRUE
     WHERE version = $1 AND is_active = TRUE
       AND ($2::int IS NULL OR organization_id = $2) RETURNING *`,
    [version, orgId]
  );
  return rows[0] ?? null;
}

/* Manual pause by row id (POST /api/firmware/pause/:id), org-scoped. */
async function pauseFirmware(id, orgId = null) {
  const { rows } = await q(
    `UPDATE firmware_versions SET rollout_paused = TRUE
     WHERE id = $1 AND ($2::int IS NULL OR organization_id = $2) RETURNING *`,
    [id, orgId]
  );
  return rows[0] ?? null;
}

/* The last version this device booted into and confirmed OK — the server's
 * record of "known good", offered to the device as `previous` so a
 * quarantined unit can re-download it (the downgrade half of rollback).
 * The join is org-scoped: with per-org versions, the same version string can
 * exist in two tenants, and a device must only ever be pointed back at a
 * build from its own org. */
async function getLastGoodFirmwareForDevice(deviceId) {
  const { rows } = await q(
    `SELECT fv.* FROM firmware_boot_reports r
     JOIN firmware_versions fv
       ON fv.version = r.firmware_version
      AND fv.organization_id = COALESCE(r.organization_id,
            (SELECT d.organization_id FROM devices d WHERE d.device_id = r.device_id))
     WHERE r.device_id = $1 AND r.status = 'ok'
     ORDER BY r.created_at DESC LIMIT 1`,
    [deviceId]
  );
  return rows[0] ?? null;
}

/* Org-scoped lookup — orgId null (super-admin) matches any org's version. */
async function getFirmwareById(id, orgId = null) {
  const { rows } = await q(
    'SELECT * FROM firmware_versions WHERE id = $1 AND ($2::int IS NULL OR organization_id = $2)',
    [id, orgId]
  );
  return rows[0] ?? null;
}

/* Org-scoped version list, newest first. orgId null (super-admin global
 * view) returns every org's versions; the LEFT JOIN adds the org name so the
 * dashboard can label which tenant each build belongs to. */
async function listFirmwareVersions(orgId = null, limit = 20) {
  const { rows } = await q(
    `SELECT fv.*, o.name AS org_name
     FROM firmware_versions fv
     LEFT JOIN organizations o ON o.id = fv.organization_id
     WHERE ($1::int IS NULL OR fv.organization_id = $1)
     ORDER BY fv.created_at DESC LIMIT $2`,
    [orgId, limit]
  );
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORTS  (same surface as the old SQLite db.js)
══════════════════════════════════════════════════════════════════════════ */
module.exports = {
  pool,
  runMigrations,
  seedDemoData,
  /* organizations (multi-tenant) */
  createOrganization,
  getOrganizationById,
  getOrganizationBySlug,
  getOrganizations,
  updateOrganization,
  getOrgMembers,
  setUserOrganization,
  getDefaultOrganizationId,
  /* users */
  getUserByDeviceId,
  getUserByEmail,
  createUser,
  getUserById,
  updateWallet,
  setWalletBalance,
  getExpiredWalletUsers,
  getLowBalanceUsers,
  hasRecentAlert,
  setPasswordResetToken,
  getUserByValidResetToken,
  completePasswordReset,
  updatePassword,
  setEmailVerificationToken,
  getUserByValidVerificationToken,
  markEmailVerified,
  /* devices */
  getDevice,
  getDeviceByUserId,
  getAllDevices,
  getEngineerFleet,
  getDeviceBootReports,
  setRelayState,
  upsertDeviceHeartbeat,
  provisionDevice,
  assignDeviceToUser,
  setDeviceLocation,
  setDeviceCoordinates,
  /* energy */
  insertEnergyReading,
  getLatestEnergy,
  getEnergyHistory,
  getEnergyHistoryAsc,
  getEnergyHourly,
  getEnergyDaily,
  getEnergyHistory48h,
  getEnergyHistory48hAllDevices,
  /* appliances (owner appliance monitor upgrade) */
  getAverageConsumption,
  createAppliance,
  getAppliancesByDevice,
  getApplianceById,
  updateAppliance,
  deleteAppliance,
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
  setPaymentFraudScore,
  getFraudRiskPayments,
  /* alerts */
  createAlert,
  getAlerts,
  getAlertSeverityCounts,
  getAlertsByUserId,
  /* daily weather alerts */
  getDailyWeatherRecipients,
  setDailyWeatherAlerts,
  /* ai */
  savePrediction,
  pruneOldRows,
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
  getProductById,
  /* firmware (OTA) */
  insertFirmwareVersion,
  activateFirmwareVersion,
  getCountOfProvisionedDevices,
  getActiveFirmware,
  getLatestFirmware,
  setFirmwareSignature,
  getFirmwareById,
  listFirmwareVersions,
  /* firmware boot reports (2-strike rollback) */
  recordBootReport,
  getDistinctFailingDevices,
  getRolloutStats,
  pauseActiveFirmwareByVersion,
  pauseFirmware,
  getLastGoodFirmwareForDevice
};
