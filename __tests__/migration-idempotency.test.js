/**
 * Migration idempotency tests — runMigrations() twice in sequence on the
 * real PostgreSQL database (same DATABASE_URL pattern as payments.test.js).
 *
 * Every CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS,
 * ALTER COLUMN, CREATE INDEX IF NOT EXISTS, and the schema_migrations-guarded
 * data fix must survive a second invocation without errors.
 *
 * Run with:  npm test  (uses node --test; matches the CI test job)
 *
 * CI environment (see .github/workflows/ci-cd.yml) spins up a Postgres 15
 * container at DATABASE_URL=postgresql://postgres:postgres@localhost:5432/solarpayg_test
 * before this file runs.
 *
 * When DATABASE_URL points to a reachable database (CI or local Postgres) all
 * 12 tests execute. When unreachable (e.g. remote Neon not accessible from this
 * network), the before hook detects the failure and all tests skip via t.skip()
 * — the important CI signal is that nothing "fails" due to an environment mismatch.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  pool,
  runMigrations,
  seedDemoData,
  seedProducts
} = require('../db');

/* ── Database connectivity probe ─────────────────────────────────────────
   Runs in the before hook so it's async-safe. When the probe fails, all
   tests skip via t.skip() so the suite doesn't falsely "fail" just because
   a local Postgres isn't running. */
let firstRunError  = null;
let secondRunError = null;
let dbConnected    = false;

before(async () => {
  /* ── Probe connectivity first ────────────────────────────────────────── */
  try { await pool.query('SELECT 1 AS ok'); dbConnected = true; }
  catch { dbConnected = false; }
  if (!dbConnected) return; /* skip setup — each test will call t.skip() below */

  /* ── First run ───────────────────────────────────────────────────────── */
  try { await runMigrations(); }
  catch (e) { firstRunError = e; }

  /* ── Seed demo data + products so the product_categories table has rows.
       These helpers are already idempotent (seedDemoData guards on
       energy_readings; seedProducts guards on product_categories). ──────── */
  try { await seedDemoData(); } catch {
    // seedDemoData needs bcrypt hashes — ok if it fails (test may not need demo rows)
  }
  try { await seedProducts(); } catch {
    // product_categories may already have data from a previous test — this is fine
  }

  /* ── Second run ──────────────────────────────────────────────────────── */
  try { await runMigrations(); }
  catch (e) { secondRunError = e; }
});

after(async () => {
  await pool.end();
});

/* ══════════════════════════════════════════════════════════════════════
   SUITE
═══════════════════════════════════════════════════════════════════════ */
describe('runMigrations idempotency', () => {

  test('database is reachable', (t) => {
    if (!dbConnected) t.skip('Set DATABASE_URL to a local Postgres to run these tests');
  });

  test('first run completes without error', (t) => {
    if (!dbConnected) return t.skip('Database unreachable — run with a local PostgreSQL instance');
    assert.equal(firstRunError, null,
      `First runMigrations() threw: ${firstRunError?.message ?? 'unknown error'}`);
  });

  test('second run completes without error', (t) => {
    if (!dbConnected) return t.skip('Database unreachable — run with a local PostgreSQL instance');
    assert.equal(secondRunError, null,
      `Second runMigrations() threw: ${secondRunError?.message ?? 'unknown error'}`);
  });

  /* ── All tables survive the second run ───────────────────────────────── */
  test('all expected tables exist after second migration', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(`
      SELECT table_name
      FROM   information_schema.tables
      WHERE  table_schema = 'public'
        AND  table_type   = 'BASE TABLE'
    `);
    const names = rows.map(r => r.table_name);

    const expectedTables = [
      'users', 'devices', 'energy_readings', 'payments',
      'ai_predictions', 'maintenance_alerts', 'pending_commands',
      'schema_migrations', 'product_categories', 'products'
    ];
    for (const tbl of expectedTables) {
      assert.ok(names.includes(tbl), `Table "${tbl}" is missing after the second migration run`);
    }
  });

  /* ── All columns survive (double ADD COLUMN IF NOT EXISTS is safe) ────── */
  test('users table has all optional columns after second migration', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(`
      SELECT column_name
      FROM   information_schema.columns
      WHERE  table_name = 'users'
    `);
    const cols = rows.map(r => r.column_name);

    const expected = [
      'id', 'device_id', 'name', 'pin', 'phone',
      'email', 'password_hash', 'role',
      'wallet_balance', 'relay_unlocked', 'created_at',
      'reset_token_hash', 'reset_token_expires'
    ];
    for (const c of expected) {
      assert.ok(cols.includes(c), `Column "users.${c}" is missing after the second migration`);
    }
  });

  test('devices table has api_key and last_seen after second migration', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(`
      SELECT column_name
      FROM   information_schema.columns
      WHERE  table_name = 'devices'
    `);
    const cols = rows.map(r => r.column_name);
    assert.ok(cols.includes('api_key'),  'devices.api_key missing after second migration');
    assert.ok(cols.includes('last_seen'), 'devices.last_seen missing after second migration');
  });

  test('payments table has payment_type, product_id, product_name after second migration', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(`
      SELECT column_name
      FROM   information_schema.columns
      WHERE  table_name = 'payments'
    `);
    const cols = rows.map(r => r.column_name);
    assert.ok(cols.includes('payment_type'), 'payments.payment_type missing');
    assert.ok(cols.includes('product_id'),   'payments.product_id missing');
    assert.ok(cols.includes('product_name'), 'payments.product_name missing');
  });

  /* ── pin column is VARCHAR(255), not the original VARCHAR(20) ──────────── */
  test('pin column was widened to VARCHAR(255) and survives re-run', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(`
      SELECT character_maximum_length
      FROM   information_schema.columns
      WHERE  table_name = 'users' AND column_name = 'pin'
    `);
    assert.equal(rows[0]?.character_maximum_length, 255,
      'users.pin should be VARCHAR(255) after migration');
  });

  /* ── schema_migrations guard: exactly 1 row after TWO runs ────────────── */
  test('schema_migrations table has exactly 1 row (not duplicated by re-run)', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(
      'SELECT name, applied_at FROM schema_migrations ORDER BY name'
    );
    assert.equal(rows.length, 1,
      `Expected exactly 1 migration record, got ${rows.length}: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].name, 'clear_category_icons',
      `Expected migration name 'clear_category_icons', got '${rows[0].name}'`);
    assert.ok(rows[0].applied_at,
      'applied_at timestamp should be set');
  });

  /* ── product_categories is queryable (the guarded UPDATE is safe) ─────── */
  test('product_categories is queryable after two migrations (icon fix is safe)', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM product_categories');
    assert.ok(typeof rows[0]?.n === 'number');
  });

  /* ── Indexes exist after second run ───────────────────────────────────── */
  test('all expected indexes exist after two migration runs', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(`
      SELECT indexname
      FROM   pg_indexes
      WHERE  tablename IN (
               'energy_readings', 'payments', 'maintenance_alerts',
               'ai_predictions', 'users', 'devices'
             )
    `);
    const idxNames = rows.map(r => r.indexname);

    const expected = [
      'idx_energy_device_ts',   'idx_energy_recorded',
      'idx_payments_user',      'idx_payments_status',   'idx_payments_checkout',
      'idx_alerts_device',      'idx_alerts_user',
      'idx_pred_device',
      'idx_users_email',        'idx_users_device',      'idx_users_role',
      'idx_devices_user',
    ];
    for (const idx of expected) {
      assert.ok(idxNames.includes(idx), `Index "${idx}" is missing after second migration`);
    }
  });

  /* ── Critical SQL patterns (make_interval) still parse after two migrations ──
       Regression check: the make_interval(hours => $N) and
       make_interval(secs => $N / 1000.0) changes in db.js must not break.
       Queried directly against the existing pool so these work even on the
       local dev machine (if the DB is reachable). ───────────────────────── */
  test('make_interval(hours => $1) pattern is valid SQL after two migrations', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM devices
       WHERE last_seen IS NULL
          OR last_seen < NOW() - make_interval(hours => $1)`,
      [1]
    );
    assert.ok(typeof rows[0]?.n === 'number');
  });

  test('make_interval(secs => $1 / 1000.0) pattern is valid SQL after two migrations', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM devices
       WHERE last_seen IS NULL
          OR last_seen < NOW() - make_interval(secs => $1 / 1000.0)`,
      [60000]
    );
    assert.ok(typeof rows[0]?.n === 'number');
  });

  test('make_interval(days => $1) pattern is valid SQL after two migrations', async (t) => {
    if (!dbConnected) return t.skip('Database unreachable');
    const { rows } = await pool.query(
      `SELECT date_trunc('day', NOW()) AS day,
              AVG(1)::numeric(10,2) AS val
       FROM   devices
       WHERE  created_at > NOW() - make_interval(days => $1)`,
      [7]
    );
    assert.ok(Array.isArray(rows), 'make_interval(days => $1) query must return an array');
  });
});
