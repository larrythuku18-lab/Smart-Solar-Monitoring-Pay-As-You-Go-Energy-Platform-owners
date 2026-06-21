/**
 * scripts/generate-icons.js — regenerate PNG icon variants from icon.svg
 *
 * Dev-time only (requires sharp, a devDependency). Run with:
 *   npm run generate-icons
 *
 * Re-run this any time public/icons/icon.svg changes — the PNGs in
 * public/icons/ are committed, generated artifacts, not edited by hand.
 */
const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'icons', 'icon.svg');
const OUT = path.join(__dirname, '..', 'public', 'icons');

const targets = [
  { name: 'favicon-16.png', size: 16 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 }
];

(async () => {
  for (const { name, size } of targets) {
    await sharp(SRC).resize(size, size).png().toFile(path.join(OUT, name));
    console.log(`Generated ${name} (${size}x${size})`);
  }
})();
