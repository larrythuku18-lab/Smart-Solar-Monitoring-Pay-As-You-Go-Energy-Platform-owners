#!/usr/bin/env node
/**
 * scripts/migrate-device-keys.js
 *
 * Bulk-provision per-device API keys for the entire fleet, with a seamless
 * migration mode that sets each device's initial key to the current shared
 * DEVICE_API_KEY so existing hardware continues working without re-flashing.
 *
 * Usage:
 *   node scripts/migrate-device-keys.js --dry-run          # preview only
 *   node scripts/migrate-device-keys.js                    # provision every device that lacks a key
 *   node scripts/migrate-device-keys.js --apply-existing   # see below
 *
 * --apply-existing
 *   Sets each unprovisioned device's *initial* api_key to the value of
 *   DEVICE_API_KEY (read from the environment).  This is the zero-downtime
 *   path: you can run this right now, then slowly re-flash devices with
 *   their own keys via /rotate-key, and finally turn on
 *   ENFORCE_PER_DEVICE_KEYS=true once the fleet is migrated.
 *
 *   Without --apply-existing, every device gets a fresh random key.  The
 *   old shared key stops working for any device that hasn't been re-flashed
 *   with its new key, which means you flash everything before you enforce.
 *
 * Output:
 *   Writes a CSV report to stdout: device_id, api_key, provisioned_at
 *   Also prints a summary count at the end.
 */

/* Load .env early so DEVICE_API_KEY and DATABASE_URL are available */
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { getAllDevices, provisionDevice } = require('../db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const applyExisting = args.includes('--apply-existing');

const SHARED_KEY = process.env.DEVICE_API_KEY || null;

(async () => {
  if (applyExisting && !SHARED_KEY) {
    console.error('FATAL: --apply-existing requires DEVICE_API_KEY to be set in the environment / .env');
    process.exit(1);
  }

  if (dryRun) console.log('=== DRY RUN — no changes will be made ===\n');

  const allDevices = await getAllDevices();
  const unprovisioned = allDevices.filter(d => !d.api_key);
  const alreadyKeyed = allDevices.filter(d => d.api_key);

  console.log(`Fleet total:       ${allDevices.length}`);
  console.log(`Already keyed:     ${alreadyKeyed.length}`);
  console.log(`Missing key:       ${unprovisioned.length}`);
  console.log('');

  if (unprovisioned.length === 0) {
    console.log('Every device already has a per-device key. Nothing to do.');
    if (alreadyKeyed.length > 0) {
      console.log('\nYou can now set ENFORCE_PER_DEVICE_KEYS=true and restart the server.');
    }
    process.exit(0);
  }

  if (applyExisting && SHARED_KEY) {
    console.log(`Mode: --apply-existing  →  each device gets the shared key (${SHARED_KEY.slice(0, 8)}…) as its initial api_key`);
    console.log('Devices will continue working immediately. Re-flash them one by one with real keys');
    console.log('via /rotate-key, then set ENFORCE_PER_DEVICE_KEYS=true once the fleet is migrated.\n');
  }

  console.log('device_id,api_key,provisioned_at');
  console.log('---------,-------,---------------');

  let successCount = 0;
  let errorCount = 0;

  for (const device of unprovisioned) {
    /* In --apply-existing mode, we still call provisionDevice() which
       generates a random key — but we then override it with the shared
       key via a direct UPDATE.  This is cleaner than special-casing
       provisionDevice's signature, and the key rotation endpoint
       (/rotate-key) is the path to a real per-device key later. */
    try {
      if (dryRun) {
        console.log(`${device.device_id},${applyExisting ? SHARED_KEY : '<random>'}${dryRun ? ',DRY-RUN' : ''}`);
        successCount++;
        continue;
      }

      if (applyExisting) {
        /* Provision with a random key, then immediately overwrite it with
           the shared key so the device keeps working.  The next time the
           admin uses /rotate-key on this device, it gets a real key. */
        await provisionDevice(device.device_id, device.name, device.location);
        await require('../db').pool.query(
          'UPDATE devices SET api_key = $1 WHERE device_id = $2',
          [SHARED_KEY, device.device_id]
        );
        const ts = new Date().toISOString();
        console.log(`${device.device_id},${SHARED_KEY},${ts}`);
      } else {
        const result = await provisionDevice(device.device_id, device.name, device.location);
        const ts = new Date().toISOString();
        console.log(`${device.device_id},${result.api_key},${ts}`);
      }

      successCount++;
    } catch (err) {
      console.error(`${device.device_id},ERROR,${err.message}`);
      errorCount++;
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`DRY RUN: ${successCount} devices would be provisioned, ${errorCount} errors`);
  } else {
    console.log(`Done: ${successCount} provisioned, ${errorCount} errors`);
    if (successCount > 0) {
      if (applyExisting) {
        console.log('\nThe shared key is now stored as every device\'s per-device key.');
        console.log('Set ENFORCE_PER_DEVICE_KEYS=true once you have re-flashed devices with real keys.');
      } else {
        console.log('\nAll devices now have unique per-device keys. Re-flash each device with its new key,');
        console.log('then set ENFORCE_PER_DEVICE_KEYS=true to enforce per-device auth.');
      }
    }
  }

  process.exit(errorCount > 0 ? 1 : 0);
})();