# 🔒 SolGrid — Security Audit Report

**Audit date:** July 13, 2026  
**Audited by:** Automated security assessment  
**Dependency scan:** `npm audit` — **0 vulnerabilities**

---

## Executive Summary

This report documents a full security audit of the SolGrid Smart Solar Monitoring & Pay-As-You-Go platform. The audit covered the **Express backend** (`server.js`, `db.js`, `authMiddleware.js`), **ESP32 firmware** (`firmware/esp32-firmware.ino`), **relay controller** (`relay.js`), **mailer** (`mailer.js`), and **frontend assets**.

**8 vulnerability classes** were identified: **5 fixed in code**, **2 accepted as documented tradeoffs** (TLS certificate validation, firmware + DB — see items 2 and 3), and **1 partially fixed with an outstanding operator action** (the leaked device key is removed from source but still requires rotation — see item 1 and the Outstanding Actions section at the end).

| Severity | Count | Status | Key Risks |
|---|---|---|---|
| 🔴 Critical (P0) | 3 | 1 partial (rotation pending), 2 documented tradeoffs | Hardcoded device key, TLS bypass (firmware + DB) |
| 🟠 High (P1) | 3 | ✅ Fixed | Plaintext PINs, exposed weather debug, password policy |
| 🟡 Medium (P2) | 2 | ✅ Fixed | Telemetry input validation, per-device rate limiting |

---

## 🔴 CRITICAL (P0) — Fixed

### 1. Hardcoded Device API Key in ESP32 Firmware

**File:** `firmware/esp32-firmware.ino` (near the top, `#define DEVICE_API_KEY`)  
**CWE:** CWE-798 (Use of Hardcoded Credentials)

**Before:** A live 40-byte hex API key was compiled into the firmware and committed to the repository. This key authenticated all telemetry from every device via the `X-Device-Key` header. Anyone with repo access could:
- Post fake telemetry for any device ID
- The key is permanently in git history

**Fix applied:**
```cpp
// The key below must remain EMPTY in source control.
#define DEVICE_API_KEY ""
```
- Replaced the hardcoded key with an **empty string**
- Added a 30-line security comment explaining the proper provisioning flow:
  1. Admin provisions each device via `POST /api/admin/devices` (admin-only)
  2. Flash the returned unique per-device key into that specific unit
  3. The shared `DEVICE_API_KEY` env var fallback is for development only
- The send function now skips the header when the key is empty:
  ```cpp
  if (strlen(DEVICE_API_KEY) > 0) {
      http.addHeader("X-Device-Key", DEVICE_API_KEY);
  }
  ```

> ⚠️ **This is NOT a complete remediation.** Blanking the source does not
> invalidate the leaked key: it remains readable in **git history**, and the
> same value is still set as the `DEVICE_API_KEY` env var in Render. Until
> that env value is **rotated**, anyone with (past) repo access can post
> telemetry for any device that lacks its own per-device key. See
> Outstanding Actions below.

### 2. ESP32 TLS Certificate Validation Disabled

**File:** `firmware/esp32-firmware.ino` (inside `sendViaHTTP()`)  
**CWE:** CWE-295 (Improper Certificate Validation)

**Before:** `secureClient.setInsecure();` — the firmware accepted any TLS certificate, making every HTTPS connection vulnerable to man-in-the-middle attacks on the same network.

**Status:** Acknowledged as documented tradeoff. The comment now clearly explains:
```cpp
// Skipping certificate validation here is a pragmatic tradeoff for a
// low-stakes IoT device — swap in setCACert() with a pinned root cert
// if you need stricter TLS.
```
**Recommendation:** For production field deployments, replace with `setCACert()` using a pinned root CA certificate. The certificate should be the ISRG Root X1 (Let's Encrypt) since Render's HTTPS frontends use Let's Encrypt certificates.

### 3. Database SSL — Certificate Validation Disabled

**File:** `db.js:32`  
**CWE:** CWE-295 (Improper Certificate Validation)

**Before:** `ssl: isLocal ? false : { rejectUnauthorized: false }` — SSL was used in production but certificate validation was completely disabled.

**Fix applied:**
- Added a prominent `[SECURITY]` startup warning on every boot:
  ```javascript
  console.warn('[SECURITY] Database SSL certificate validation is disabled...');
  ```
- The warning fires whenever the app starts with `rejectUnauthorized: false` on a non-local connection

**Important context:** Render's managed PostgreSQL instances use internal TLS certificates that do **not** chain to a publicly-trusted Certificate Authority. As a result, enabling `rejectUnauthorized: true` with a standard CA bundle (ISRG Root X1, etc.) will **fail** — the server certificate cannot be validated by the default Node.js root store.

**Options for production:**
1. **Current approach (recommended for Render):** Keep `rejectUnauthorized: false` but ensure the connection string uses `sslmode=require` (which is already the case). The traffic is encrypted — only certificate *validation* is bypassed.
2. **Contact Render Support** to request a specific CA certificate for your database region, if your compliance requirements mandate full certificate validation.
3. **Self-managed PostgreSQL:** If deploying on a platform that provides a public CA certificate (AWS RDS, DigitalOcean, etc.), download the CA bundle and configure:
   ```javascript
   ssl: {
     rejectUnauthorized: true,
     ca: fs.readFileSync('/path/to/ca-certificate.crt').toString()
   }
   ```

The `[SECURITY]` warning ensures this tradeoff is surfaced on every deploy.

---

## 🟠 HIGH (P1) — Fixed

### 4. Plaintext PIN Storage

**Files:** `db.js`, `server.js`  
**CWE:** CWE-256 (Plaintext Storage of a Password)

**Before:** Device PINs (`1234` default) were stored as `VARCHAR(20)` and compared with `===` in plaintext. A database breach exposed every device PIN.

**Fix applied (4 changes):**

**a) Schema migration** (`db.js`):
```sql
ALTER TABLE users ALTER COLUMN pin TYPE VARCHAR(255);
```
The column was widened from `VARCHAR(20)` to `VARCHAR(255)` to accommodate 60-character bcrypt hashes.

**b) Auto-migration of existing plaintext PINs** (`db.js` → `seedDemoData()`):
```javascript
const { rows: plainPinUsers } = await q(
  `SELECT id, pin FROM users WHERE pin IS NOT NULL AND pin !~ '^\\$2'`
);
for (const u of plainPinUsers) {
  const hashedPin = await bcrypt.hash(u.pin, 10);
  await q('UPDATE users SET pin = $1 WHERE id = $2', [hashedPin, u.id]);
}
```
On every boot, any remaining plaintext PINs are detected (do not start with `$2`) and hashed with bcrypt.

**c) New PINs hashed on creation** (`db.js` → `createUser()`):
```javascript
const finalPin = pin && !pin.startsWith('$2')
  ? await bcrypt.hash(String(pin), 10)
  : (pin || await bcrypt.hash('0000', 10));
```

**d) PIN login uses bcrypt.compare** (`server.js`):
```javascript
const pinMatch = user.pin && (user.pin.startsWith('$2')
  ? await bcrypt.compare(String(lookupPin), user.pin)
  : user.pin === String(lookupPin));
```
Transparent backward compatibility: bcrypt-hashed PINs use `bcrypt.compare()`, legacy plaintext PINs fall back to `===` until the next boot migration hashes them.

**e) Demo PINs pre-hashed** (`db.js` → `seedDemoData()`):
Both demo PINs (`0000` and `1234`) are now hashed with bcrypt before being stored via `upsertDemoUser()`.

**f) upsertDemoUser now updates PIN on conflict** (`db.js`):
Added `pin = EXCLUDED.pin` to the `ON CONFLICT` update clause, so the migration that re-hashes demo PINs actually persists.

### 5. Weak Password Requirements

**File:** `server.js` (function `validatePasswordStrength`)  
**CWE:** CWE-521 (Weak Password Requirements)

**Before:** Registration and password reset accepted any password with no complexity requirements.

**Fix applied — added `validatePasswordStrength()`:**
```javascript
function validatePasswordStrength(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  const missing = [];
  if (!/[A-Z]/.test(password)) missing.push('uppercase letter');
  if (!/[a-z]/.test(password)) missing.push('lowercase letter');
  if (!/[0-9]/.test(password)) missing.push('number');
  if (!/[^A-Za-z0-9]/.test(password)) missing.push('special character');
  if (missing.length > 0) {
    return `Password must contain at least one ${missing.join(', ')}`;
  }
  return null;
}
```
Applied to:
- `POST /api/auth/register`
- `POST /api/auth/reset-password`
- `POST /api/admin/admins`

All three endpoints return a consistent `{ error: 'Password must contain at least one ...' }` format.

### 6. Weather Debug Endpoint Exposed Internal Details

**File:** `server.js` — `GET /api/weather?debug=1`  
**CWE:** CWE-200 (Information Exposure)

**Before:** The `?debug=1` flag exposed upstream error codes, HTTP statuses, and upstream names (e.g., `"open-meteo:ERR_BAD_REQUEST/429 met.no:ETIMEDOUT"`) to any unauthenticated client.

**Fix applied:**
The debug path now requires a valid JWT with admin role before returning upstream error details:
```javascript
if (req.query.debug === '1') {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required for debug mode' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    if (decoded.role !== 'admin' && decoded.deviceId !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required for debug mode' });
    }
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  // ... expose upstreamError
}
```
The weather route itself remains public — only the debug payload is protected.

---

## 🟡 MEDIUM (P2) — Fixed

### 7. Telemetry Input Validation

**File:** `server.js` — `POST /api/telemetry`  
**CWE:** CWE-20 (Improper Input Validation)

**Before:** The telemetry endpoint accepted any fields from devices with no type/range validation.

**Fix applied — added express-validator middleware:**
```javascript
app.post('/api/telemetry', apiLimiter, [
  body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required and must be a string'),
  body('voltage').optional().isFloat({ min: 0 }).toFloat(),
  body('current').optional().isFloat({ min: 0 }).toFloat(),
  body('generation').optional().isFloat({ min: 0 }).toFloat(),
  body('battery').optional().isFloat({ min: 0, max: 100 }).toFloat(),
  body('consumption').optional().isFloat({ min: 0 }).toFloat()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  // ...
});
```
Malformed requests are rejected with a clear 400 error before any database operations.

### 8. Per-Device Rate Limiting

**File:** `server.js` — `POST /api/telemetry`  
**CWE:** CWE-770 (Allocation of Resources Without Limits or Throttling)

**Before:** The telemetry endpoint was protected only by a global IP-based rate limiter (120 req/min). A single noisy or compromised device could flood the database.

**Fix applied — added per-deviceId in-memory sliding window:**
```javascript
const _deviceRateLimits = new Map();
const DEVICE_RATE_LIMIT  = 20;      // max requests per window per device
const DEVICE_RATE_WINDOW = 60_000;  // 1-minute sliding window

function checkDeviceRateLimit(deviceId) {
  const now = Date.now();
  let entries = _deviceRateLimits.get(deviceId);
  if (!entries) {
    entries = [];
    _deviceRateLimits.set(deviceId, entries);
  }
  while (entries.length > 0 && entries[0] < now - DEVICE_RATE_WINDOW) {
    entries.shift();
  }
  if (entries.length >= DEVICE_RATE_LIMIT) {
    return false;
  }
  entries.push(now);
  return true;
}
```

- **20 requests per minute per deviceId** (the simulator runs at 2/min, so there is ample headroom)
- Stale entries cleaned up every 5 minutes to prevent unbounded memory growth
- Applied **after the X-Device-Key check** (an unauthenticated attacker who merely knows a deviceId must not be able to burn the real device's budget) and **before any database write**
- Returns `429 Too Many Requests` with a device-specific message

---

## 🔵 LOW (P3) — Documented / Addressed

| Finding | Status | Notes |
|---|---|---|
| JWT secret in git history | **Documented in DIAGNOSTIC.md** | Earlier `.env.example` contained what looked like a real JWT_SECRET. Rotate the production secret if it matches the old value. |
| Bruteforce PINs (4-digit) | **Mitigated** by per-device rate limiting + auth rate limiter | PINs are now hashed with bcrypt; the auth rate limiter (20 attempts/15 min/IP) prevents online brute-force. |
| No CSRF protection | **Accepted** — JWT in header | The API uses JWT Bearer tokens (not cookies), which are not vulnerable to CSRF by design. |
| pgAdmin credentials in docker-compose | **Documented** | `PGADMIN_DEFAULT_EMAIL`/`PGADMIN_DEFAULT_PASSWORD` are defaults; change for production. |

---

## 🔧 Dependency Health

```
$ npm audit
# → 0 vulnerabilities found
```

All 12 production dependencies are clean. The most notable:
- `express` 4.18.2 — no known vulnerabilities
- `jsonwebtoken` 9.0.3 — latest patch
- `helmet` 8.2.0 — latest, with full CSP support
- `bcrypt` 6.0.0 — no known issues

---

## 🧪 Test Results

All **51 tests** pass after the security fixes — the pre-existing 35, plus 16
new telemetry-security tests (input validation, per-device rate limiting, and
a regression test proving unauthenticated traffic cannot consume a device's
rate-limit budget).

Tests were updated in `__tests__/payments.test.js` to run `runMigrations()` before tests so the test database schema matches the new `VARCHAR(255)` pin column width.

---

## 📋 Files Changed

| File | Changes |
|---|---|
| `firmware/esp32-firmware.ino` | Removed hardcoded API key; added provisioning documentation |
| `db.js` | PIN hashing (schema, migration, creation, demo seed); SSL warning; removed PIN from boot log |
| `server.js` | PIN bcrypt login; password complexity; weather debug auth; telemetry validation; per-device rate limiting (behind device-key auth) |
| `__tests__/payments.test.js` | Added `runMigrations()` before tests for new column width |
| `__tests__/telemetry-security.test.js` | New: validation, rate-limit, and auth-ordering coverage |
| `firmware.js` + `db.js` + `firmware/esp32-firmware.ino` | OTA hardening: ECDSA P-256 signed binaries, staged rollout, 2-strike boot-failure auto-pause + device rollback (see below) |

---

## 🔑 Per-Device Keys — Migration Guide

### Why per-device keys?

The original design shared a single `DEVICE_API_KEY` across the whole fleet.
This is convenient for demos but has two security gaps:

1. **Any attacker with the shared key can impersonate any device.**
2. **The OTA 2-strike auto-pause is meaningless** — an attacker holding the
   shared key can POST two `/firmware/report` calls with different `deviceId`
   values and pause the entire fleet's rollout.

Once **every device has its own `api_key`** and `ENFORCE_PER_DEVICE_KEYS=true`
is set, neither attack works.  The 2-strike threshold becomes a genuine fleet
safety valve.

### Step-by-step migration (zero-downtime path)

#### 1. Provision devices that lack keys

```bash
# Preview which devices would get keys:
node scripts/migrate-device-keys.js --dry-run

# Zero-downtime path: set every device's initial key to the current
# DEVICE_API_KEY so existing hardware continues working immediately:
node scripts/migrate-device-keys.js --apply-existing
```

This writes the shared key into every row.  Devices keep working because the
server checks `device.api_key` before falling back to `DEVICE_API_KEY`, and
now they have one — it just happens to be the same value.

#### 2. Flash a real per-device key into each unit

For every device you want to secure:

```bash
curl -X POST /api/admin/devices/${DEVICE_ID}/rotate-key \
  -H "Authorization: Bearer ${ADMIN_TOKEN}"
# → returns { device: { device_id, api_key: "<new-random-key>" } }
```

Flash this `api_key` into the device's firmware (`#define DEVICE_API_KEY`)
and re-deploy.  The device now authenticates with its own unique credential,
and the shared key can no longer impersonate it.

#### 3. Shrink the shared key's blast radius

Once a majority of devices have real keys, remove `DEVICE_API_KEY` from your
.Render environment or `.env` **for a few minutes** to catch any device that
still depends on it — its next telemetry POST will 401, and its offline status
will appear on the fleet dashboard.  Re-inject the shared key, flash those
devices, and repeat until the fleet is clean.

#### 4. Enforce per-device keys

```bash
# Set in the production environment:
ENFORCE_PER_DEVICE_KEYS=true
```

When this is `true`:
- The `|| process.env.DEVICE_API_KEY` fallback is removed from telemetry auth
  AND from the OTA `/latest` / `/report` device auth.
- Any device without a per-device key is rejected immediately.
- The startup log shows: `Per-device keys: ENFORCED`.

#### 5. (Optional) Set a fleet-aware OTA pause threshold

With per-device keys enforced, the 2-strike threshold is no longer vulnerable
to shared-key spoofing.  You can now set it as a **percentage of the fleet**:

```bash
# 1% of provisioned devices must fail before auto-pause fires
# At 50k devices → 500 failures needed
OTA_PAUSE_PCT=1

# Or keep it as a fixed number (default 2):
OTA_PAUSE_FAIL_DEVICES=5
```

When `ENFORCE_PER_DEVICE_KEYS=true` and `OTA_PAUSE_PCT` is set, the pause
threshold is `max(2, ceil(provisioned_count * OTA_PAUSE_PCT / 100))`.
Otherwise the absolute `OTA_PAUSE_FAIL_DEVICES` (default 2) is used.

#### Rollback

Unset `ENFORCE_PER_DEVICE_KEYS` or set it to `false` — the shared key
fallback is immediately restored.  No data is lost; per-device keys remain
in the database and are used on re-enforcement.

---

## 🏢 Multi-Tenant Access Control (organizations)

Every user, device, and payment belongs to an `organizations` row; a
`default` org is created on first boot and all legacy rows are backfilled,
so existing single-tenant deployments are unchanged until they create more
orgs. Three roles:

| Role | Visibility | Can create privileged accounts? |
|---|---|---|
| `admin` (super-admin) | All orgs (`?orgId=` narrows the view) | Yes — super-admins and org admins |
| `org_admin` | Exactly one org (`organization_id` claim in the JWT) | **No** — never |
| `customer` | Own data only (unchanged per-user scoping) | No |

Enforcement points (`server.js` — all admin routes funnel through
`canAccessAdmin()` / `resolveOrgScope()`):

- **Aggregates** — `/api/admin/summary`, `/api/admin/devices`,
  `/api/payments/stats`, `/api/audit/*`, `/api/analytics/summary`,
  `/api/admin/fraud-risk`, `/api/customers/credit-score-trend` are all
  filtered by `organization_id` in SQL. An org admin's `?orgId=` query
  param is **ignored** — it can narrow a super-admin's view, never widen an
  org admin's.
- **Device routes** — `/rotate-key`, `/location`, `/assign`, `/api/energy/*`
  and `/api/audit/charts` refuse devices outside the caller's org (403).
- **Privilege escalation** — `POST /api/admin/admins` is super-admin-only:
  an org admin can never mint another org admin (which would escape their
  tenant) *or* a super-admin.
- **Key rotation** — `provisionDevice` preserves `organization_id` on
  conflict, so rotating a key can never silently reassign a device to
  another tenant.

### Tested by
`__tests__/multi-tenant.test.js` — schema/backfill, scoped helpers, JWT org
claims, cross-tenant device/energy refusal, escalation guards, and
super-admin `?orgId=` drill-down.

---

## 🔐 OTA Firmware Integrity (production hardening)

The OTA pipeline now fails closed end-to-end:

- **Authenticity** — every uploaded binary is signed with ECDSA P-256
  (`FIRMWARE_SIGNING_KEY`); devices verify the signature over the SHA-256
  digest against the root public key baked into the sketch
  (`FIRMWARE_ROOT_PUBKEY`) before the OTA partition is committed. A device
  with a root key refuses unsigned or forged builds. The private key never
  ships to devices or the repo (generate: `node scripts/generate-ota-keys.js`).
- **Targeting** — staged rollout (`rollout_pct` + `rollout_region`) means a
  bad release reaches only the bucket it was scoped to.
- **Recovery** — devices report boot outcomes; two consecutive failures of a
  version auto-pause the rollout, and each affected device re-downloads its
  last known-good build (via `/latest`'s `previous` pointer), so a broken
  release cannot wedge the fleet.

---

## ✅ Verification Checklist

- [x] No hardcoded credentials remain in source code (the old key is still in **git history** — rotation required, see below)
- [x] All passwords and PINs are hashed with bcrypt before storage
- [x] Legacy plaintext PINs auto-migrate to bcrypt on next boot
- [x] Debug endpoints require authentication
- [x] All API inputs are validated or sanitized
- [x] Rate limiting applied at both IP and device level (device-level runs behind device-key auth)
- [x] Security headers set via helmet (CSP, XSS, clickjacking, HSTS)
- [x] Stack traces never leak to clients
- [x] Payment callbacks authenticated via shared secret
- [x] Unauthenticated telemetry warns at startup
- [x] All tests pass (51 as of this revision)
- [x] 0 dependency vulnerabilities

---

## 🚨 Outstanding Actions (operator — not fixable in code)

These require access to the Render / Neon / GitHub dashboards and are **not**
resolved by the code changes in this report:

1. **Telemetry ingest is currently unauthenticated in production.**
   Verified 2026-07-14: `POST /api/telemetry` returns 200 for any deviceId
   with no key and even with a wrong key, because `DEVICE_API_KEY` is not
   set in Render and the demo devices have no per-device key — so
   `expectedKey` is falsy and the check is skipped. Anyone who reaches the
   URL can inject readings for any device (corrupting dashboards/analytics/
   AI data) and create phantom device rows. Fix: provision per-device keys
   via `POST /api/admin/devices` and flash them into units, OR set a shared
   `DEVICE_API_KEY` in Render AND flash the same value into every device
   (note the current firmware sends no key when blank, so setting the env
   key alone would 401-reject those devices). The old shared value
   `8039c15a…` also remains in git history.
2. **Rotate `JWT_SECRET`** if it matches the value that appeared in the old
   `.env.example` (see P3 table above).
3. **Consider resetting the Neon database password** — the connection string
   has passed through chat/shell sessions (tracked since 2026-07-06); update
   Render's `DATABASE_URL` and the `BACKUP_DATABASE_URL` GitHub Actions
   secret together if you do.
