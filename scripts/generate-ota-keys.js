#!/usr/bin/env node
/**
 * generate-ota-keys.js — mint the ECDSA P-256 keypair used to sign firmware.
 *
 * Usage:
 *   node scripts/generate-ota-keys.js
 *     Prints both halves of the keypair in drop-in form:
 *       1. FIRMWARE_SIGNING_KEY — the PRIVATE key, as a single-line value for
 *          the server's .env / secrets manager. NEVER commit or flash this.
 *       2. FIRMWARE_ROOT_PUBKEY — the PUBLIC key, as a C macro to paste into
 *          firmware/esp32-firmware.ino. Only this half ever ships to devices.
 *
 *   node scripts/generate-ota-keys.js --out ./ota-keys
 *     Also writes the raw PEMs to ./ota-keys/firmware-signing-key.pem and
 *     ./ota-keys/firmware-root-pubkey.pem (the private file is chmod 600).
 *
 * How it fits together:
 *   - The backend signs each uploaded binary with the private key
 *     (firmware.js → signFirmwareBinary) whenever FIRMWARE_SIGNING_KEY is set.
 *   - Devices verify against the baked-in root public key before flashing
 *     (firmware/esp32-firmware.ino → verifyFirmwareSignature). A build with
 *     an empty FIRMWARE_ROOT_PUBKEY accepts unsigned OTA — dev only.
 */
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? args[outFlag + 1] : null;

/* prime256v1 == NIST P-256. PKCS#8 for the private key (what node's
   createSign accepts), SPKI for the public key (what mbedtls parses). */
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const publicPem  = publicKey.export({ type: 'spki', format: 'pem' }).trim();

/* Single-line escape for .env files: dotenv turns "\n" inside double quotes
   back into real newlines; firmware.js also normalizes literal \n just in
   case. The C macro needs the same escaping (a \n in a string literal is a
   newline character). */
const esc = (pem) => pem.replace(/\n/g, '\\n');

if (outDir) {
  // The output path is a CLI argument the operator chose deliberately.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.mkdirSync(outDir, { recursive: true });
  const privFile = path.join(outDir, 'firmware-signing-key.pem');
  const pubFile  = path.join(outDir, 'firmware-root-pubkey.pem');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.writeFileSync(privFile, privatePem + '\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.writeFileSync(pubFile, publicPem + '\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.chmodSync(privFile, 0o600);
  console.log(`Wrote ${privFile} (chmod 600) and ${pubFile}\n`);
}

console.log('== 1) Server env var — put in .env / your secrets manager (PRIVATE, never commit) ==\n');
console.log(`FIRMWARE_SIGNING_KEY="${esc(privatePem)}"\n`);

console.log('== 2) Firmware macro — paste into firmware/esp32-firmware.ino (PUBLIC, safe to ship) ==\n');
console.log(`#define FIRMWARE_ROOT_PUBKEY "${esc(publicPem)}"\n`);

console.log('Then: flash OTA-enabled firmware, upload a .bin, and the backend signs it on the way in.');
