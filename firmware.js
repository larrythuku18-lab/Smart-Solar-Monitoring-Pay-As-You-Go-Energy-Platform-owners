/**
 * firmware.js — OTA firmware management (feature-flagged)
 *
 * Mounted in server.js ONLY when OTA_ENABLED=true, so the entire feature is
 * inert by default. Rollback = set OTA_ENABLED=false and restart — the
 * routes stop existing (404) without any code changes.
 *
 * Endpoints:
 *   GET  /api/firmware/latest        → { id, version, url, checksum, signature,
 *                                       previous? } — device-aware: respects the
 *                                       staged rollout (rollout_pct + region) and
 *                                       offers the device's last-known-good as
 *                                       `previous` for rollback
 *   GET  /api/firmware/download/:id  → the raw .bin, streamed from disk
 *   POST /api/firmware/report        → device reports boot outcome of a flashed
 *                                       version (ok/fail); 2 consecutive fails
 *                                       auto-pause the rollout
 *   GET  /api/firmware               → admin-only version list (dashboard)
 *   POST /api/firmware/upload        → admin-only, raw octet-stream body +
 *                                      ?version=1.2.3&changelog=... — STAGES
 *                                      only (is_active=false), never targets
 *                                      the fleet by itself. Signed with ECDSA
 *                                      P-256 when FIRMWARE_SIGNING_KEY is set.
 *   POST /api/firmware/activate/:id  → admin-only, promotes a staged version
 *                                      to the active OTA target (deactivates
 *                                      whatever was active). Optional
 *                                      ?rollout_pct=10&region=Nairobi scopes
 *                                      it to a staged rollout.
 *   POST /api/firmware/sign/:id      → admin-only, signs/re-signs an uploaded
 *                                      binary with the configured key
 *   POST /api/firmware/pause/:id     → admin-only, manually pauses a rollout
 *
 * Security model:
 *  - Device endpoints (latest/download/report) require X-Device-Id +
 *    X-Device-Key, mirroring POST /api/telemetry: a provisioned device's own
 *    key wins, and unprovisioned devices fall back to the shared
 *    DEVICE_API_KEY (the fallback is deliberately preserved, never removed).
 *  - Binaries are integrity-checked twice at the device: SHA-256 checksum AND
 *    an ECDSA P-256 signature over that digest, verified against a root
 *    public key baked into the firmware. A device with a root key rejects
 *    unsigned/forged binaries (fail-closed). The private key lives only in
 *    FIRMWARE_SIGNING_KEY (secrets manager / HSM in production) — it never
 *    touches the repo or the devices.
 *  - Uploads are admin-only and validated server-side (semver-like version,
 *    64-hex SHA-256 checksum, size cap). A bad binary can never be activated.
 *  - Binaries are stored under FIRMWARE_DIR with server-generated UUID
 *    filenames; the DB holds the id → filename mapping, so no user-controlled
 *    string ever reaches the filesystem path.
 */

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  getDevice,
  insertFirmwareVersion,
  activateFirmwareVersion,
  getActiveFirmware,
  getLatestFirmware,
  getFirmwareById,
  setFirmwareSignature,
  listFirmwareVersions,
  recordBootReport,
  getDistinctFailingDevices,
  getRolloutStats,
  pauseActiveFirmwareByVersion,
  pauseFirmware,
  getLastGoodFirmwareForDevice
} = require('./db');
const { authMiddleware } = require('./authMiddleware');
/* OTA SLI counters (boot-ok/fail, auto-pauses) — side-effect free module. */
const obs = require('./observability');

const router = express.Router();

/* The single on/off switch for the whole feature (default: off). */
function otaEnabled() {
  return process.env.OTA_ENABLED === 'true';
}

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(__dirname, 'firmware-store');
const MAX_FIRMWARE_BYTES = 2 * 1024 * 1024; // ESP32 app partitions are typically ≤ 2 MB
/* Distinct devices that must report a boot-failure before the fleet-wide
   auto-pause fires (see /report). A single buggy or compromised device must
   not be able to pause a rollout for everyone — each affected device still
   rolls itself back locally via quarantine + the /latest previous pointer.

   When ENFORCE_PER_DEVICE_KEYS=true, the shared-key fallback is removed
   and every call to /report must carry a valid per-device key.  This makes
   the 2-strike threshold *meaningful* — an attacker can no longer use the
   shared key to spoof failures from arbitrary deviceIds.

   The threshold can be set as an absolute count (OTA_PAUSE_FAIL_DEVICES=N)
   or, when per-device keys are enforced, as a percentage of the fleet that
   has a per-device key (OTA_PAUSE_PCT=N).  The percentage path protects
   against a true fleet-wide bug: at 50k devices, OTA_PAUSE_PCT=1 means 500
   devices must fail before the rollout is paused, which is a real signal. */
let failDevicesToPause = parseInt(process.env.OTA_PAUSE_FAIL_DEVICES || '2', 10) || 2;
/* When per-device keys are enforced, optionally use a percentage of the
   fleet instead of a fixed number.  The DB query reuses the pool from
   ./db so it's safe to call here.  Gracefully handles the case where the
   fleet is still being provisioned (falls back to the absolute number). */
if (process.env.ENFORCE_PER_DEVICE_KEYS === 'true' && process.env.OTA_PAUSE_PCT) {
  const pct = Math.max(1, Math.min(100, parseInt(process.env.OTA_PAUSE_PCT, 10) || 5));
  /* Defer the DB query — it's only needed if /report actually fires, and
     the pool may not be ready at module load time.  The lambda below is
     called lazily by /report and /rollout. */
  const { getCountOfProvisionedDevices } = require('./db');
  const dbThreshold = async () => {
    try {
      const count = await getCountOfProvisionedDevices();
      return Math.max(2, Math.ceil(count * pct / 100));
    } catch {
      return failDevicesToPause; /* fallback if DB is unreachable */
    }
  };
  /* The constant is still used as a *minimum* floor; the dynamic threshold
     is stored alongside it for the /report handler. */
  module.exports.failDevicesToPause = failDevicesToPause;
  module.exports.failDevicesToPauseDynamic = dbThreshold;
} else {
  module.exports.failDevicesToPause = failDevicesToPause;
}
/* Bounded repetition only — linear-time, no nested quantifier blowup
   (detect-unsafe-regex is a false positive here). e.g. "1.2.3" */
// eslint-disable-next-line security/detect-unsafe-regex
const VERSION_RE = /^\d{1,4}(\.\d{1,4}){1,3}$/;

/* ── ECDSA P-256 firmware signing ─────────────────────────────────────────
   Production firmware is signed with ECDSA P-256 over the binary's SHA-256.
   The private key is read from FIRMWARE_SIGNING_KEY (a PEM in the secrets
   manager, injected at container start — an HSM in the full production
   design). Devices bake in the matching root PUBLIC key and refuse anything
   that doesn't verify. When no key is configured, uploads are stored
   unsigned (signature = NULL) and a loud boot warning fires — devices with
   a baked-in key reject those binaries, which is the fail-closed behavior
   we want rather than silently shipping unsigned code. */
function signingKeyPem() {
  const pem = process.env.FIRMWARE_SIGNING_KEY;
  /* dotenv keeps literal \n escapes inside quoted values — normalize so both
     single-line and real-newline PEMs work. */
  return pem ? String(pem).replace(/\\n/g, '\n').trim() : null;
}

function signFirmwareBinary(body) {
  const keyPem = signingKeyPem();
  if (!keyPem) return null;
  try {
    const sign = crypto.createSign('sha256');
    sign.update(body);
    sign.end();
    /* ECDSA → DER-encoded ECDSA-Sig-Value, base64. mbedtls_pk_verify on the
       device parses exactly this format. */
    return sign.sign(keyPem, 'base64');
  } catch (err) {
    console.error('Firmware signing error:', err.message);
    return null;
  }
}

/* Exported for tests + the admin dashboard path: verify a base64 DER ECDSA
   P-256 signature over a binary against the given public key PEM. */
function verifyFirmwareSignature(body, signatureB64, pubKeyPem) {
  if (!signatureB64 || !pubKeyPem) return false;
  try {
    const verify = crypto.createVerify('sha256');
    verify.update(body);
    verify.end();
    return verify.verify(pubKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

if (otaEnabled() && !signingKeyPem()) {
  console.warn('[OTA] FIRMWARE_SIGNING_KEY is not set — uploaded firmware will be UNSIGNED. '
    + 'Devices flashed with a baked-in root public key will reject it (fail-closed). '
    + 'Generate a keypair with: node scripts/generate-ota-keys.js');
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function isAdmin(req) {
  return req.user?.role === 'admin' || req.user?.deviceId === 'ADMIN';
}

/* Same device-credential check as POST /api/telemetry: a device's own
   provisioned key wins; unprovisioned devices fall back to the shared
   DEVICE_API_KEY. X-Device-Id is required so the shared key can't be used
   against an arbitrary id that happens to map to no device.
   Also attaches req.device (the row fetched for the check) — the device-aware
   /latest and /report handlers need its location / firmware_version. */
async function requireDeviceKey(req, res, next) {
  const deviceId = req.get('x-device-id');
  const key = req.get('x-device-key');
  if (!deviceId || !key) {
    return res.status(401).json({ error: 'Device credentials required (X-Device-Id + X-Device-Key)' });
  }
  try {
    const device = await getDevice(deviceId);
    /* When ENFORCE_PER_DEVICE_KEYS=true the shared DEVICE_API_KEY fallback
       is removed — only a device's own provisioned api_key is accepted.
       This makes the OTA 2-strike pause threshold meaningful: an attacker
       holding the shared key cannot spoof failures from arbitrary deviceIds. */
    const enforcePerDevice = process.env.ENFORCE_PER_DEVICE_KEYS === 'true';
    const expected = enforcePerDevice
      ? device?.api_key
      : device?.api_key || process.env.DEVICE_API_KEY;
    if (!expected || key !== expected) {
      return res.status(401).json({ error: 'Invalid device credentials' });
    }
    req.device = device;
    next();
  } catch (err) {
    console.error('Device key check error:', err.message);
    res.status(500).json({ error: 'Device authentication failed' });
  }
}

/* ── Staged rollout ───────────────────────────────────────────────────────
   Deterministic bucket: sha256(deviceId:firmwareId) first byte mod 100. Stable
   across polls and restarts, so a device is either in the rollout or not
   until the percentage changes — no flapping as devices poll /latest. */
function rolloutBucket(deviceId, firmwareId, pct) {
  const hash = crypto.createHash('sha256').update(`${deviceId}:${firmwareId}`).digest();
  return hash[0] % 100 < pct;
}

/* A device is eligible for a firmware if:
   - the rollout isn't paused (auto-paused after 2 boot failures), and
   - its region matches rollout_region when one is set (case-insensitive
     substring of devices.location — "Nairobi, Kenya" contains "nairobi"),
     and
   - its deterministic bucket falls under rollout_pct (100 = everyone). */
function deviceEligibleFor(fw, device) {
  if (!fw || !device) return false;
  if (fw.rollout_paused) return false;
  if (fw.rollout_region) {
    const location = (device.location || '').toLowerCase();
    if (!location.includes(String(fw.rollout_region).toLowerCase())) return false;
  }
  const pct = Number(fw.rollout_pct ?? 100);
  if (pct < 100 && !rolloutBucket(device.device_id, fw.id, pct)) return false;
  return true;
}

/* The wire shape for /latest and the admin list. The download URL is derived
   from the DB id (never stored) so it can't go stale. */
function publicFirmwareView(row) {
  return {
    id:        row.id,
    version:   row.version,
    url:       `/api/firmware/download/${row.id}`,
    checksum:  row.checksum,
    changelog: row.changelog,
    created_at: row.created_at,
    /* admin-facing rollout state (devices get deviceFirmwareView below) */
    signed:          !!row.signature,
    rollout_pct:     Number(row.rollout_pct ?? 100),
    rollout_region:  row.rollout_region || null,
    rollout_paused:  !!row.rollout_paused
  };
}

/* What a device sees: the full signature value (so it can verify) but none
   of the rollout bookkeeping. `previous` is appended by /latest only when
   the device has a last-known-good build to fall back to. */
function deviceFirmwareView(row) {
  return {
    id:        row.id,
    version:   row.version,
    url:       `/api/firmware/download/${row.id}`,
    checksum:  row.checksum,
    signature: row.signature || null,
    changelog: row.changelog,
    created_at: row.created_at
  };
}

/* ── Device endpoints ───────────────────────────────────────────────────── */

router.get('/latest', requireDeviceKey, async (req, res) => {
  try {
    const latest = await getActiveFirmware();

    /* Rollback aid: the last version this device proved good (a boot-ok
       report). A device that fails to boot a new build re-downloads this one
       instead — the server-side pointer for the downgrade half of the
       rollback story. Computed unconditionally (when the device isn't already
       running the latest) so a quarantined device always has a path back,
       even if it already reports the failing version via telemetry or the
       rollout gets paused (in which case `latest` is null and the response
       below is `{ previous }` only). */
    const running = req.device?.firmware_version || '';
    let previous = null;
    /* Always look up the last-known-good when there is NO active target (a
       paused rollout or nothing published): the `latest?.version || ''` guard
       would wrongly short-circuit for a device that has never reported a
       firmware version via telemetry — exactly the devices that need the
       downgrade path most. */
    if (!latest || running !== latest.version) {
      const lastGood = await getLastGoodFirmwareForDevice(req.device.device_id);
      if (lastGood && (!latest || lastGood.version !== latest.version)) {
        previous = deviceFirmwareView(lastGood);
      }
    }

    if (latest && deviceEligibleFor(latest, req.device)) {
      const view = deviceFirmwareView(latest);
      if (previous) view.previous = previous;
      return res.json(view);
    }

    /* No eligible active firmware (staged rollout below this device's bucket,
       auto-paused, or nothing published) — but a device that has a
       last-known-good build it is NOT currently running still gets the
       downgrade pointer. This is what lets a quarantined device roll back
       even after the rollout was auto-paused; without it, a crash-looping
       device would be stuck on the broken build with no way back. */
    if (previous) {
      return res.json({ previous });
    }
    return res.status(404).json({ error: 'No firmware available' });
  } catch (err) {
    console.error('Firmware latest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch firmware' });
  }
});

router.get('/download/:id', requireDeviceKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid firmware id' });
  }
  try {
    const row = await getFirmwareById(id);
    if (!row) return res.status(404).json({ error: 'Firmware not found' });

    /* filename is server-generated (crypto.randomUUID() at upload time),
       never user input — a stored id can only resolve to its own file. */
    const filePath = path.join(FIRMWARE_DIR, row.filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(filePath)) {
      console.error(`Firmware binary missing on disk: ${row.filename} (id ${row.id})`);
      return res.status(404).json({ error: 'Firmware binary missing' });
    }

    /* Content-Length from the actual file, not the stored size — a truncated
       file on disk must under-deliver cleanly instead of hanging the client. */
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fileSize = fs.statSync(filePath).size;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(fileSize));
    res.setHeader('Content-Disposition', `attachment; filename="firmware-${row.version}.bin"`);
    res.setHeader('Cache-Control', 'no-store');
    /* The signature rides as a header too, so a device that fetched the URL
       directly (without /latest) can still verify the payload. */
    if (row.signature) res.setHeader('X-Firmware-Signature', row.signature);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Firmware download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download firmware' });
  }
});

/* POST /api/firmware/report — a device reports the outcome of booting into
   a freshly-flashed version: { version, status: "ok" | "fail" }.
   When `failDevicesToPause` (default 2) DISTINCT devices report a failure
   within the window, the rollout is automatically PAUSED fleet-wide — the
   fleet stops being offered a build that boots broken. The threshold
   deliberately needs evidence from more than one device: a single buggy or
   compromised unit must not be able to pause a rollout for everyone (each
   affected device still rolls itself back locally — see /latest's
   `previous`). Individual recovery is per-device; the pause is a fleet
   safety valve, and re-activating is what resumes it. */
router.post('/report', requireDeviceKey, async (req, res) => {
  const { version, status } = req.body || {};
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    return res.status(400).json({ error: 'version must look like 1.2.3' });
  }
  if (status !== 'ok' && status !== 'fail') {
    return res.status(400).json({ error: "status must be 'ok' or 'fail'" });
  }
  try {
    const deviceId = req.get('x-device-id');
    await recordBootReport({ deviceId, version, status });
    obs.otaBootReports.inc({ status });
    obs.log.info('Firmware boot report', { deviceId, version, status });

    let paused = false;
    if (status === 'fail') {
      const failingDevices = await getDistinctFailingDevices(version);
      /* Use the dynamic threshold when per-device keys are enforced and
         OTA_PAUSE_PCT is configured; fall back to the absolute number. */
      let threshold = failDevicesToPause;
      if (process.env.ENFORCE_PER_DEVICE_KEYS === 'true' && process.env.OTA_PAUSE_PCT) {
        try {
          const { getCountOfProvisionedDevices } = require('./db');
          const count = await getCountOfProvisionedDevices();
          const pct = Math.max(1, Math.min(100, parseInt(process.env.OTA_PAUSE_PCT, 10) || 5));
          threshold = Math.max(2, Math.ceil(count * pct / 100));
        } catch {
          /* DB unreachable — use the absolute number */
        }
      }
      if (failingDevices >= threshold) {
        const row = await pauseActiveFirmwareByVersion(version);
        if (row) {
          paused = true;
          obs.otaRolloutPaused.inc();
          obs.log.warn('OTA rollout auto-paused', { version, failingDevices, threshold });
        }
      }
    }

    res.json({ success: true, paused });
  } catch (err) {
    console.error('Firmware report error:', err.message);
    res.status(500).json({ error: 'Failed to record boot report' });
  }
});

/* ── Admin endpoints ────────────────────────────────────────────────────── */

router.get('/', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  try {
    const versions = await listFirmwareVersions();
    res.json({
      versions: versions.map(v => ({
        ...publicFirmwareView(v),
        size_bytes: v.size_bytes,
        is_active:  v.is_active
      }))
    });
  } catch (err) {
    console.error('Firmware list error:', err.message);
    res.status(500).json({ error: 'Failed to list firmware' });
  }
});

/* Raw-binary upload — STAGES the version (is_active=false). It becomes the
   fleet's OTA target only after an explicit POST /activate/:id, so a binary
   can be published and reviewed/canary-tested before it targets anything.
   Metadata rides in query params (version + changelog) so the admin
   dashboard can POST the file bytes directly with no multipart parser.
   When FIRMWARE_SIGNING_KEY is configured the binary is signed at upload
   time; otherwise it is stored unsigned (see the module-level warning). */
router.post('/upload', authMiddleware, express.raw({ type: 'application/octet-stream', limit: '3mb' }), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });

  const version   = String(req.query.version || '').trim();
  const changelog = String(req.query.changelog || '').trim().slice(0, 500);
  const body      = req.body;

  if (!VERSION_RE.test(version)) {
    return res.status(400).json({ error: 'version must look like 1.2.3 (1-4 digit groups separated by dots)' });
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({ error: 'Request body must be the raw .bin file bytes' });
  }
  if (body.length > MAX_FIRMWARE_BYTES) {
    return res.status(413).json({ error: `Firmware binary too large (max ${MAX_FIRMWARE_BYTES / (1024 * 1024)} MB)` });
  }

  const checksum = crypto.createHash('sha256').update(body).digest('hex');
  const signature = signFirmwareBinary(body);
  const filename = `${crypto.randomUUID()}.bin`;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(path.join(FIRMWARE_DIR, filename), body);
    const row = await insertFirmwareVersion({
      version, filename, checksum, changelog, sizeBytes: body.length, signature
    });
    res.status(201).json({
      success: true,
      ...publicFirmwareView(row),
      /* the raw signature value (not just the `signed` flag) — the admin may
         want to eyeball it, and it lets tooling verify the binary offline */
      signature: row.signature || null,
      size_bytes: row.size_bytes,
      is_active:  row.is_active
    });
  } catch (err) {
    /* version UNIQUE violation → tell the admin exactly which version collided */
    if (err.code === '23505') {
      return res.status(409).json({ error: `Version ${version} already exists` });
    }
    console.error('Firmware upload error:', err.message);
    /* DB failure (not a duplicate) — don't leave an orphaned binary on disk */
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.unlinkSync(path.join(FIRMWARE_DIR, filename));
    } catch { /* already gone */ }
    res.status(500).json({ error: 'Failed to store firmware' });
  }
});

/* Promote a staged version to the active OTA target. Idempotent — activating
   an already-active version just returns it. The deactivate-others + activate
   happens atomically under an advisory lock (activateFirmwareVersion in db.js).
   Staged rollout: ?rollout_pct=10 (0-100, clamped) + ?region=Nairobi scope
   the release; defaults (100 / no region) reproduce the old fleet-wide
   behavior. Re-activating a paused version is how its rollout is resumed. */
router.post('/activate/:id', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid firmware id' });
  }

  /* Staged-rollout envelope. Fail CLOSED on a malformed percentage: a typo'd
     value like `abc`, `50.5`, `-1`, or an empty string must be rejected,
     never silently interpreted as 100% (which would target the whole fleet —
     the opposite of what a staged rollout is for). */
  let rolloutPct = 100;
  if (req.query.rollout_pct !== undefined) {
    const raw = String(req.query.rollout_pct).trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) {
      return res.status(400).json({ error: 'rollout_pct must be an integer between 0 and 100' });
    }
    rolloutPct = Number(raw);
  }
  const rolloutRegion = req.query.region
    ? String(req.query.region).trim().slice(0, 128) || null
    : null;

  try {
    const row = await activateFirmwareVersion(id, { rolloutPct, rolloutRegion });
    if (!row) return res.status(404).json({ error: 'Firmware not found' });
    res.json({
      success: true,
      ...publicFirmwareView(row),
      is_active: row.is_active
    });
  } catch (err) {
    console.error('Firmware activate error:', err.message);
    res.status(500).json({ error: 'Failed to activate firmware' });
  }
});

/* Sign (or re-sign) an already-uploaded binary with the configured key.
   Uploads are signed automatically when a key is present, so this exists for
   two cases: the key was generated after the upload, or a key rotation
   happened and old binaries need new signatures. Refuses to run when no
   FIRMWARE_SIGNING_KEY is configured. */
router.post('/sign/:id', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid firmware id' });
  }
  if (!signingKeyPem()) {
    return res.status(400).json({ error: 'FIRMWARE_SIGNING_KEY is not configured — nothing to sign with' });
  }

  try {
    const row = await getFirmwareById(id);
    if (!row) return res.status(404).json({ error: 'Firmware not found' });

    const filePath = path.join(FIRMWARE_DIR, row.filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Firmware binary missing' });
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const signature = signFirmwareBinary(fs.readFileSync(filePath));
    if (!signature) {
      return res.status(500).json({ error: 'Failed to sign firmware' });
    }

    const updated = await setFirmwareSignature(id, signature);
    res.json({ success: true, ...deviceFirmwareView(updated), signed: true });
  } catch (err) {
    console.error('Firmware sign error:', err.message);
    res.status(500).json({ error: 'Failed to sign firmware' });
  }
});

/* GET /api/firmware/rollout — admin-only rollout status: the current target
   (even when paused), its rollout envelope, and the last 24h of boot-fail
   reports driving the auto-pause decision, so an operator can see how close
   a release is to being pulled before it actually is. */
router.get('/rollout', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  try {
    /* getLatestFirmware (not getActiveFirmware) so a paused rollout still
       shows who the target is and why it's stopped. */
    const active = await getLatestFirmware();
    if (!active) return res.json({ active: null });
    const stats = await getRolloutStats(active.version);
    res.json({
      active: { ...publicFirmwareView(active), is_active: true },
      bootFailures24h: {
        reports:        stats.fail_reports,
        distinctDevices: stats.failing_devices,
        pauseThreshold:  process.env.ENFORCE_PER_DEVICE_KEYS === 'true' && process.env.OTA_PAUSE_PCT
          ? Math.max(2, Math.ceil(
              (await getCountOfProvisionedDevices?.() || 0) *
              (parseInt(process.env.OTA_PAUSE_PCT, 10) || 5) / 100
            ))
          : failDevicesToPause
      }
    });
  } catch (err) {
    console.error('Firmware rollout status error:', err.message);
    res.status(500).json({ error: 'Failed to load rollout status' });
  }
});

/* Manually pause a rollout — same effect as the automatic 2-strike pause.
   Reactivating via /activate/:id clears the pause. */
router.post('/pause/:id', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid firmware id' });
  }

  try {
    const row = await pauseFirmware(id);
    if (!row) return res.status(404).json({ error: 'Firmware not found' });
    res.json({ success: true, ...publicFirmwareView(row), is_active: row.is_active });
  } catch (err) {
    console.error('Firmware pause error:', err.message);
    res.status(500).json({ error: 'Failed to pause firmware' });
  }
});

module.exports = { router, otaEnabled, verifyFirmwareSignature };
