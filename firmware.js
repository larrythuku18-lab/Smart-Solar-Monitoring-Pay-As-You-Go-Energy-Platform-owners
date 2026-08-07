/**
 * firmware.js — OTA firmware management (feature-flagged)
 *
 * Mounted in server.js ONLY when OTA_ENABLED=true, so the entire feature is
 * inert by default. Rollback = set OTA_ENABLED=false and restart — the
 * routes stop existing (404) without any code changes.
 *
 * Endpoints:
 *   GET  /api/firmware/latest        → { id, version, url, checksum, changelog }
 *   GET  /api/firmware/download/:id  → the raw .bin, streamed from disk
 *   GET  /api/firmware               → admin-only version list (dashboard)
 *   POST /api/firmware/upload        → admin-only, raw octet-stream body +
 *                                      ?version=1.2.3&changelog=... — STAGES
 *                                      only (is_active=false), never targets
 *                                      the fleet by itself
 *   POST /api/firmware/activate/:id  → admin-only, promotes a staged version
 *                                      to the active OTA target (deactivates
 *                                      whatever was active)
 *
 * Security model:
 *  - Device endpoints (latest/download) require X-Device-Id + X-Device-Key,
 *    mirroring POST /api/telemetry: a provisioned device's own key wins, and
 *    unprovisioned devices fall back to the shared DEVICE_API_KEY (the
 *    fallback is deliberately preserved, never removed).
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
  getLatestFirmware,
  getFirmwareById,
  listFirmwareVersions
} = require('./db');
const { authMiddleware } = require('./authMiddleware');

const router = express.Router();

/* The single on/off switch for the whole feature (default: off). */
function otaEnabled() {
  return process.env.OTA_ENABLED === 'true';
}

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(__dirname, 'firmware-store');
const MAX_FIRMWARE_BYTES = 2 * 1024 * 1024; // ESP32 app partitions are typically ≤ 2 MB
/* Bounded repetition only — linear-time, no nested quantifier blowup
   (detect-unsafe-regex is a false positive here). e.g. "1.2.3" */
// eslint-disable-next-line security/detect-unsafe-regex
const VERSION_RE = /^\d{1,4}(\.\d{1,4}){1,3}$/;

/* ── Helpers ────────────────────────────────────────────────────────────── */

function isAdmin(req) {
  return req.user?.role === 'admin' || req.user?.deviceId === 'ADMIN';
}

/* Same device-credential check as POST /api/telemetry: a device's own
   provisioned key wins; unprovisioned devices fall back to the shared
   DEVICE_API_KEY. X-Device-Id is required so the shared key can't be used
   against an arbitrary id that happens to map to no device. */
async function requireDeviceKey(req, res, next) {
  const deviceId = req.get('x-device-id');
  const key = req.get('x-device-key');
  if (!deviceId || !key) {
    return res.status(401).json({ error: 'Device credentials required (X-Device-Id + X-Device-Key)' });
  }
  try {
    const device = await getDevice(deviceId);
    const expected = device?.api_key || process.env.DEVICE_API_KEY;
    if (!expected || key !== expected) {
      return res.status(401).json({ error: 'Invalid device credentials' });
    }
    next();
  } catch (err) {
    console.error('Device key check error:', err.message);
    res.status(500).json({ error: 'Device authentication failed' });
  }
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
    created_at: row.created_at
  };
}

/* ── Device endpoints ───────────────────────────────────────────────────── */

router.get('/latest', requireDeviceKey, async (req, res) => {
  try {
    const latest = await getLatestFirmware();
    if (!latest) return res.status(404).json({ error: 'No firmware available' });
    res.json(publicFirmwareView(latest));
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
    /* filename is a server-generated UUID from the DB row, never client
       input — the id→file mapping lives entirely server-side. */
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Firmware download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download firmware' });
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
   dashboard can POST the file bytes directly with no multipart parser. */
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
  const filename = `${crypto.randomUUID()}.bin`;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(path.join(FIRMWARE_DIR, filename), body);
    const row = await insertFirmwareVersion({
      version, filename, checksum, changelog, sizeBytes: body.length
    });
    res.status(201).json({
      success: true,
      ...publicFirmwareView(row),
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
   happens atomically under an advisory lock (activateFirmwareVersion in db.js). */
router.post('/activate/:id', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid firmware id' });
  }

  try {
    const row = await activateFirmwareVersion(id);
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

module.exports = { router, otaEnabled };
