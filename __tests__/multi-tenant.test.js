/**
 * Multi-tenant tests — organizations schema, org-scoped query helpers, and
 * API-level tenant isolation (org_admin vs super-admin vs customer).
 *
 * Two layers:
 *   1. Direct db.js tests against the real Postgres (schema + scoped helpers)
 *   2. API tests against a spawned server (isolation through the routes)
 *
 * Uses the same spawn pattern as api.test.js / ota.test.js: a real server on
 * a test port, with the rate-limit ceiling raised so localhost doesn't 429.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  pool,
  runMigrations,
  createUser,
  createPayment,
  createOrganization,
  getDefaultOrganizationId,
  getAllDevices,
  getOrganizations,
  provisionDevice,
  getPaymentStats,
  getAdminSummary
} = require('../db');

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;

let server;
let _adminToken;
let _orgAToken;
let _orgBToken;

function loginAdmin() {
  return (async () => {
    if (_adminToken) return _adminToken;
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:    process.env.ADMIN_EMAIL    || 'admin@solarpayg.com',
        password: process.env.ADMIN_PASSWORD || 'Admin@12345'
      })
    });
    const body = await r.json();
    assert.equal(r.status, 200, `admin login failed: ${JSON.stringify(body)}`);
    _adminToken = body.token;
    return _adminToken;
  })();
}

async function loginOrgAdmin(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const body = await r.json();
  assert.equal(r.status, 200, `org admin login failed: ${JSON.stringify(body)}`);
  return body;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/* Unique org names per run so repeated test runs never collide on slugs. */
const SUFFIX = Date.now().toString(36);
const ORG_A = `org-a-${SUFFIX}`;
const ORG_B = `org-b-${SUFFIX}`;
const ADMIN_A_EMAIL = `orgadmin-a-${SUFFIX}@example.com`;
const ADMIN_B_EMAIL = `orgadmin-b-${SUFFIX}@example.com`;

let orgAId;
let orgBId;
/* Orgs created inside individual tests (e.g. the empty-org /api/state
   check) register here so the after() hook cleans them up too. */
const extraOrgIds = [];

before(async () => {
  await runMigrations();

  /* Fresh orgs for this run. */
  orgAId = (await createOrganization({ name: 'Org A Test', slug: ORG_A })).id;
  orgBId = (await createOrganization({ name: 'Org B Test', slug: ORG_B })).id;

  /* Spawn the API server with a raised rate-limit ceiling. */
  server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), API_RATE_LIMIT_MAX: '20000', RESEND_API_KEY: '', AT_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
});

after(async () => {
  server?.kill('SIGKILL');
  /* Remove only this run's rows — never the shared demo fleet. */
  try {
    const orgIds = [orgAId, orgBId, ...extraOrgIds];
    await pool.query('DELETE FROM payments WHERE organization_id = ANY($1)', [orgIds]);
    await pool.query('DELETE FROM devices   WHERE organization_id = ANY($1)', [orgIds]);
    await pool.query('DELETE FROM users     WHERE organization_id = ANY($1)', [orgIds]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [orgIds]);
  } catch (err) {
    console.warn('multi-tenant test cleanup warning:', err.message);
  }
  await pool.end();
});

describe('organizations schema', () => {
  test('migrations create the organizations table and a default org', async () => {
    const { rows } = await pool.query("SELECT * FROM organizations WHERE slug = 'default'");
    assert.equal(rows.length, 1, 'default organization must exist after migration');
  });

  test('existing rows are backfilled into the default org', async () => {
    const defaultOrgId = await getDefaultOrganizationId();
    assert.ok(defaultOrgId, 'default org id must resolve');

    /* The demo users/devices seeded on boot must have landed in the default org. */
    const { rows: users } = await pool.query(
      'SELECT id FROM users WHERE organization_id IS NULL LIMIT 1'
    );
    const { rows: devices } = await pool.query(
      'SELECT id FROM devices WHERE organization_id IS NULL LIMIT 1'
    );
    assert.equal(users.length, 0, 'no user may remain unassigned after migration');
    assert.equal(devices.length, 0, 'no device may remain unassigned after migration');
  });

  test('createOrganization enforces unique slugs', async () => {
    await assert.rejects(
      () => createOrganization({ name: 'Dup Org', slug: ORG_A }),
      /unique|duplicate|23505/i,
      'duplicate slug must be rejected by the unique constraint'
    );
  });
});

describe('org-scoped query helpers', () => {
  test('createUser with organizationId lands the user in that org', async () => {
    const user = await createUser({
      deviceId: `MT-U-${crypto.randomBytes(6).toString('hex')}`,
      name: 'Org A Customer',
      role: 'customer',
      organizationId: orgAId
    });
    assert.equal(user.organization_id, orgAId);
  });

  test('createUser without organizationId falls back to the default org', async () => {
    const user = await createUser({
      deviceId: `MT-U-${crypto.randomBytes(6).toString('hex')}`,
      name: 'Default Org Customer',
      role: 'customer'
    });
    assert.equal(user.organization_id, await getDefaultOrganizationId());
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  test('provisionDevice assigns the caller org, and key rotation preserves it', async () => {
    const deviceId = `MT-D-${crypto.randomBytes(6).toString('hex')}`;
    const created = await provisionDevice(deviceId, 'Org A Unit', null, orgAId);
    assert.equal(created.organization_id, orgAId);

    /* Re-provision (rotation) must NOT move the device to another org. */
    const rotated = await provisionDevice(deviceId, 'Org A Unit', null, orgBId);
    assert.equal(rotated.organization_id, orgAId, 'rotation must never reassign the tenant');
  });

  test('payments inherit the paying user organization', async () => {
    const user = await createUser({
      deviceId: `MT-U-${crypto.randomBytes(6).toString('hex')}`,
      name: 'Paying Customer A',
      role: 'customer',
      organizationId: orgAId
    });
    const p = await createPayment({
      userId: user.id,
      deviceId: user.device_id,
      amount: 42,
      checkoutRequestId: `MT-P-${crypto.randomBytes(8).toString('hex')}`,
      paymentType: 'energy'
    });
    const { rows: [row] } = await pool.query(
      'SELECT organization_id FROM payments WHERE id = $1', [p.id]
    );
    assert.equal(row.organization_id, orgAId, 'payment must inherit the user org');
  });

  test('getPaymentStats scopes by org', async () => {
    const all = await getPaymentStats();
    const onlyA = await getPaymentStats(orgAId);
    assert.ok(Number(all.total_payments) >= Number(onlyA.total_payments),
      'org-scoped totals must never exceed the global totals');
  });

  test('getAllDevices scopes by org', async () => {
    await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'A unit', null, orgAId);
    await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'B unit', null, orgBId);

    const all  = await getAllDevices();
    const onlyA = await getAllDevices(orgAId);
    const onlyB = await getAllDevices(orgBId);

    assert.equal(onlyA.every(d => d.organization_id === orgAId), true,
      'all devices returned for org A must belong to org A');
    assert.equal(onlyB.every(d => d.organization_id === orgBId), true,
      'all devices returned for org B must belong to org B');
    assert.ok(all.length > onlyA.length, 'global device list must be a superset');
  });

  test('getAdminSummary scopes counts by org', async () => {
    const summaryA = await getAdminSummary(orgAId);
    const summaryAll = await getAdminSummary();
    assert.ok(summaryA.devices >= 1, 'org A must see its provisioned devices');
    assert.ok(summaryA.devices <= summaryAll.devices,
      'org-scoped device count must never exceed the global count');
  });

  test('getOrganizations reports device/user/admin counts per tenant', async () => {
    /* A fresh org (no devices, no admins) must show zeroed counts — and the
       orgs that received devices/users/admins earlier in this suite must
       report them. This is the data contract the org-directory UI renders. */
    const emptyOrg = await createOrganization({ name: 'Count Check Org', slug: `count-${SUFFIX}` });
    extraOrgIds.push(emptyOrg.id);

    const orgs = await getOrganizations();
    const empty = orgs.find(o => o.id === emptyOrg.id);
    assert.ok(empty, 'the freshly created org must appear in the directory');
    assert.equal(Number(empty.device_count), 0, 'no devices → device_count 0');
    assert.equal(Number(empty.user_count), 0, 'no users → user_count 0');
    assert.equal(Number(empty.admin_count), 0, 'no org admins → admin_count 0');

    const orgA = orgs.find(o => o.id === orgAId);
    assert.ok(Number(orgA.device_count) >= 1, 'org A has provisioned devices');
    assert.ok(Number(orgA.user_count) >= 1, 'org A has users');

    /* Create an org admin directly (ordering-independent) and confirm the
       directory's admin_count picks it up. */
    const adminUser = await createUser({
      deviceId: `MT-ADMIN-${crypto.randomBytes(6).toString('hex')}`,
      name: 'Count Org Admin', email: `count-admin-${SUFFIX}@example.com`,
      role: 'org_admin', organizationId: emptyOrg.id
    });
    const after = await getOrganizations();
    assert.equal(Number(after.find(o => o.id === emptyOrg.id).admin_count), 1,
      'admin_count must count org_admin users');
    await pool.query('DELETE FROM users WHERE id = $1', [adminUser.id]);
  });
});

describe('API tenant isolation', () => {
  test('super-admin creates org admins for each org; they log in with organizationId', async () => {
    const adminToken = await loginAdmin();

    const createA = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
      body: JSON.stringify({
        name: 'Org A Admin',
        email: ADMIN_A_EMAIL,
        password: 'OrgAdmin@123',
        role: 'org_admin',
        organizationId: orgAId
      })
    });
    assert.equal(createA.status, 201, `org admin A creation failed: ${JSON.stringify(await createA.json())}`);

    const createB = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
      body: JSON.stringify({
        name: 'Org B Admin',
        email: ADMIN_B_EMAIL,
        password: 'OrgAdmin@123',
        role: 'org_admin',
        organizationId: orgBId
      })
    });
    assert.equal(createB.status, 201, `org admin B creation failed: ${JSON.stringify(await createB.json())}`);

    const loginA = await loginOrgAdmin(ADMIN_A_EMAIL, 'OrgAdmin@123');
    assert.equal(loginA.user.role, 'org_admin');
    assert.equal(loginA.user.organizationId, orgAId, 'JWT must carry the org claim');
    _orgAToken = loginA.token;

    const loginB = await loginOrgAdmin(ADMIN_B_EMAIL, 'OrgAdmin@123');
    assert.equal(loginB.user.organizationId, orgBId);
    _orgBToken = loginB.token;
  });

  test('an org admin cannot create any privileged account (super-admin OR org_admin)', async () => {
    /* Attempt to create another org admin… */
    const orgAdminAttempt = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(_orgAToken) },
      body: JSON.stringify({
        name: 'Escalation Attempt',
        email: `escalate-${SUFFIX}@example.com`,
        password: 'OrgAdmin@123',
        role: 'org_admin',
        organizationId: orgAId
      })
    });
    assert.equal(orgAdminAttempt.status, 403, 'org admins must not create org admins');

    /* …and — the sharper test — a platform super-admin (role defaults to
       'admin' when omitted). If this ever succeeds, an org admin has
       escaped their tenant. */
    const superAdminAttempt = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(_orgAToken) },
      body: JSON.stringify({
        name: 'Super Admin Escalation',
        email: `escalate-super-${SUFFIX}@example.com`,
        password: 'OrgAdmin@123'
      })
    });
    assert.equal(superAdminAttempt.status, 403,
      'org admins must not create platform super-admins (privilege escalation)');
  });

  test('org admins see only their own org devices', async () => {
    await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'A device', null, orgAId);
    await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'B device', null, orgBId);

    const listA = await fetch(`${BASE}/api/admin/devices`, { headers: auth(_orgAToken) });
    const listB = await fetch(`${BASE}/api/admin/devices`, { headers: auth(_orgBToken) });
    assert.equal(listA.status, 200);
    assert.equal(listB.status, 200);

    const { devices: devicesA } = await listA.json();
    const { devices: devicesB } = await listB.json();
    assert.equal(devicesA.every(d => d.organization_id === orgAId), true,
      'org A admin must only see org A devices');
    assert.equal(devicesB.every(d => d.organization_id === orgBId), true,
      'org B admin must only see org B devices');
    assert.ok(devicesA.length >= 1 && devicesB.length >= 1);
  });

  test('org admins get org-scoped payment stats and summaries', async () => {
    /* Seed one completed payment for org A and one for org B, then confirm
       each org admin sees only their own. */
    const mkUser = async (orgId) => {
      const u = await createUser({
        deviceId: `MT-U-${crypto.randomBytes(6).toString('hex')}`,
        name: 'Tenant Customer', role: 'customer', organizationId: orgId
      });
      await createPayment({
        userId: u.id, deviceId: u.device_id, amount: 99,
        checkoutRequestId: `MT-P-${crypto.randomBytes(8).toString('hex')}`,
        paymentType: 'energy'
      });
      return u;
    };
    const [uA, uB] = await Promise.all([mkUser(orgAId), mkUser(orgBId)]);

    const statsA = await (await fetch(`${BASE}/api/payments/stats`, { headers: auth(_orgAToken) })).json();
    const statsB = await (await fetch(`${BASE}/api/payments/stats`, { headers: auth(_orgBToken) })).json();
    assert.ok(statsA.total_payments >= 1 && statsB.total_payments >= 1);

    const summaryA = await (await fetch(`${BASE}/api/admin/summary`, { headers: auth(_orgAToken) })).json();
    const summaryB = await (await fetch(`${BASE}/api/admin/summary`, { headers: auth(_orgBToken) })).json();
    assert.ok(summaryA.users >= 1 && summaryB.users >= 1, 'each org must see its own users');

    /* Cleanup: payments reference users, so delete payments first. */
    await pool.query('DELETE FROM payments WHERE user_id = ANY($1)', [[uA.id, uB.id]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[uA.id, uB.id]]);
  });

  test('org admins cannot rotate/locate/assign devices outside their org', async () => {
    const bDevice = await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'B device', null, orgBId);

    const rotate = await fetch(`${BASE}/api/admin/devices/${bDevice.device_id}/rotate-key`, {
      method: 'POST',
      headers: auth(_orgAToken)
    });
    assert.equal(rotate.status, 403, 'org A admin must not rotate an org B device key');

    const locate = await fetch(`${BASE}/api/admin/devices/${bDevice.device_id}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(_orgAToken) },
      body: JSON.stringify({ location: 'Hacked' })
    });
    assert.equal(locate.status, 403, 'org A admin must not relocate an org B device');

    /* And the positive case: their own device works. */
    const aDevice = await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'A device', null, orgAId);
    const ownRotate = await fetch(`${BASE}/api/admin/devices/${aDevice.device_id}/rotate-key`, {
      method: 'POST',
      headers: auth(_orgAToken)
    });
    assert.equal(ownRotate.status, 200, 'org admin must be able to rotate their own device key');
  });

  test('org admins cannot read another org device energy data', async () => {
    const bDevice = await provisionDevice(`MT-D-${crypto.randomBytes(6).toString('hex')}`, 'B device', null, orgBId);
    const r = await fetch(`${BASE}/api/energy/history?deviceId=${encodeURIComponent(bDevice.device_id)}`, {
      headers: auth(_orgAToken)
    });
    assert.equal(r.status, 403, 'org A admin must not read org B device telemetry');
  });

  test('customers are blocked from admin endpoints; super-admin sees all orgs', async () => {
    /* Customer token — the shared DEMO-001 account. */
    const cLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'DEMO-001', pin: '1234' })
    });
    const cBody = await cLogin.json();
    assert.equal(cLogin.status, 200);
    const customerToken = cBody.token;

    const denied = await fetch(`${BASE}/api/admin/summary`, { headers: auth(customerToken) });
    assert.equal(denied.status, 403, 'customers must be blocked from admin summary');

    /* Super-admin list: contains every org we created. */
    const adminToken = await loginAdmin();
    const orgsRes = await fetch(`${BASE}/api/admin/organizations`, { headers: auth(adminToken) });
    assert.equal(orgsRes.status, 200);
    const { organizations } = await orgsRes.json();
    const slugs = organizations.map(o => o.slug);
    assert.ok(slugs.includes(ORG_A) && slugs.includes(ORG_B),
      'super-admin org directory must list both test orgs');

    /* Org admin cannot list the directory at all. */
    const deniedDir = await fetch(`${BASE}/api/admin/organizations`, { headers: auth(_orgAToken) });
    assert.equal(deniedDir.status, 403, 'org admins must not see the org directory');
  });

  test('a super-admin can drill into a single org with ?orgId=', async () => {
    const adminToken = await loginAdmin();
    const r = await fetch(`${BASE}/api/admin/summary?orgId=${orgAId}`, { headers: auth(adminToken) });
    assert.equal(r.status, 200);
    const summary = await r.json();
    const globalSummary = await (await fetch(`${BASE}/api/admin/summary`, { headers: auth(adminToken) })).json();
    assert.ok(summary.devices >= 1);
    assert.ok(summary.devices <= globalSummary.devices, 'orgId= must narrow, never widen');
  });

  test('/api/state is tenant-aware: org identity, no cross-org device fallback, no OTA flag', async () => {
    const adminToken = await loginAdmin();

    /* Super-admin: demo device, no org identity, OTA flag reflects backend. */
    const superState = await (await fetch(`${BASE}/api/state`, { headers: auth(adminToken) })).json();
    assert.equal(superState.organization, null, 'super-admin has no single-org identity');
    assert.equal(superState.deviceId, 'DEMO-001');
    assert.equal(typeof superState.otaEnabled, 'boolean');

    /* Org admin with provisioned units: their org identity + their own first
       device — never the default org's DEMO-001. */
    const stateA = await (await fetch(`${BASE}/api/state`, { headers: auth(_orgAToken) })).json();
    assert.equal(stateA.organization?.id, orgAId, 'org admin state must carry their org identity');
    assert.notEqual(stateA.deviceId, 'DEMO-001',
      'org admin state must resolve a device inside their org, not the demo unit');
    assert.equal(stateA.otaEnabled, false, 'OTA must stay hidden from org admins (routes are super-admin-only)');

    /* Fresh org with no devices: empty-state dashboard, never DEMO-001. */
    const emptyOrg = await createOrganization({ name: 'Empty Org', slug: `empty-${SUFFIX}` });
    extraOrgIds.push(emptyOrg.id);
    const emptyAdminEmail = `empty-admin-${SUFFIX}@example.com`;
    const createEmpty = await fetch(`${BASE}/api/admin/admins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(adminToken) },
      body: JSON.stringify({
        name: 'Empty Org Admin', email: emptyAdminEmail, password: 'OrgAdmin@123',
        role: 'org_admin', organizationId: emptyOrg.id
      })
    });
    assert.equal(createEmpty.status, 201);
    const emptyLogin = await loginOrgAdmin(emptyAdminEmail, 'OrgAdmin@123');
    const emptyState = await (await fetch(`${BASE}/api/state`, { headers: auth(emptyLogin.token) })).json();
    assert.equal(emptyState.noDevices, true, 'an empty org must get the noDevices flag');
    assert.equal(emptyState.deviceId, null, 'an empty org must not fall back to DEMO-001');
    assert.equal(emptyState.walletBalance, 0, 'an empty org must not inherit the demo wallet');
    assert.equal(emptyState.otaEnabled, false);
  });
});

describe('customer scoping stays per-user', () => {
  test('a customer only ever sees their own payments', async () => {
    const customerToken = await (async () => {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'DEMO-001', pin: '1234' })
      });
      return (await r.json()).token;
    })();

    const me = await fetch(`${BASE}/api/auth/me`, { headers: auth(customerToken) });
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.organizationId, await getDefaultOrganizationId(),
      'customer /me must expose their organizationId');
  });
});
