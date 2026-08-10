#!/usr/bin/env node
/**
 * scripts/check-mpesa-config.js — M-Pesa production readiness check
 *
 * Validates every credential + configuration the Daraja integration needs
 * and prints a pass/fail matrix with the exact fix for each failure. Safe
 * to run at any time (reads env only, no network calls, no secrets echoed
 * beyond a 6-char fingerprint).
 *
 * Usage:
 *   node scripts/check-mpesa-config.js          # check against .env / shell env
 *   node scripts/check-mpesa-config.js --prod   # same checks, production gates on
 *
 * Exit codes: 0 = ready, 1 = something missing (or a warning-level failure
 * when --prod). Useful in CI: gate a deploy on this passing.
 *
 * The checks mirror the PRODUCTION CHECKLIST in docs/mpesa-production.md —
 * keep both in sync when the integration changes.
 */

/* Load .env so the same file server.js reads is checked */
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const env = process.env;
const prod = process.argv.includes('--prod');

const fingerprint = (s) => (s && s.length >= 8 ? `${s.slice(0, 3)}…${s.slice(-3)}` : '(empty)');

const checks = [];
const result = (name, ok, detail) => checks.push({ name, ok, detail });

/* ── Core credentials (all four required for a live STK push) ──────────── */
result('MPESA_CONSUMER_KEY',     !!env.MPESA_CONSUMER_KEY,
  env.MPESA_CONSUMER_KEY ? `set (${fingerprint(env.MPESA_CONSUMER_KEY)})` : 'missing — generate from Safaricom Developer Portal → API keys');
result('MPESA_CONSUMER_SECRET',  !!env.MPESA_CONSUMER_SECRET,
  env.MPESA_CONSUMER_SECRET ? `set (${fingerprint(env.MPESA_CONSUMER_SECRET)})` : 'missing — same portal, keep secret');
result('MPESA_SHORTCODE',        !!env.MPESA_SHORTCODE,
  env.MPESA_SHORTCODE ? `set (${env.MPESA_SHORTCODE})` : 'missing — your registered paybill/till number');
result('MPESA_PASSKEY',          !!env.MPESA_PASSKEY,
  env.MPESA_PASSKEY ? `set (${fingerprint(env.MPESA_PASSKEY)})` : 'missing — the online passkey from the paybill settings page');

/* ── Environment: never go live on sandbox, never simulate in production ─ */
const envName = env.MPESA_ENVIRONMENT || 'sandbox';
result('MPESA_ENVIRONMENT=production', envName === 'production',
  envName === 'production' ? 'production (live Daraja API)' : `currently "${envName}" — set to production for go-live`);
if (envName !== 'production') {
  result('NODE_ENV not production (simulation allowed)', env.NODE_ENV !== 'production',
    'correct fail-closed behavior: M-Pesa refuses to simulate when NODE_ENV=production; '
    + (env.NODE_ENV === 'production' ? 'you are on production with sandbox M-Pesa — fix before go-live' : 'non-production — simulation is permitted'));
}

/* ── Callback: required for the async result of every STK push ─────────── */
result('MPESA_CALLBACK_URL',     !!env.MPESA_CALLBACK_URL,
  env.MPESA_CALLBACK_URL ? env.MPESA_CALLBACK_URL : 'missing — the HTTPS URL Safaricom POSTs results to');
if (env.MPESA_CALLBACK_URL && !env.MPESA_CALLBACK_URL.startsWith('https://')) {
  result('MPESA_CALLBACK_URL uses HTTPS', false,
    'Safaricom requires an HTTPS callback; a plain-http URL would leak payment data');
} else if (env.MPESA_CALLBACK_URL) {
  result('MPESA_CALLBACK_URL uses HTTPS', true, 'HTTPS');
}
result('MPESA_CALLBACK_SECRET',  !!env.MPESA_CALLBACK_SECRET,
  env.MPESA_CALLBACK_SECRET
    ? `set (${fingerprint(env.MPESA_CALLBACK_SECRET)}) — appended to the CallBackURL so /api/mpesa/callback can verify origin`
    : 'missing — REQUIRED in production: without it the callback endpoint accepts forged "payment succeeded" posts (server refuses to start)');

/* ── Production-only gates (fail loudly with --prod) ───────────────────── */
const prodGates = [];
if (prod) {
  if (env.MPESA_ENVIRONMENT !== 'production') {
    prodGates.push('MPESA_ENVIRONMENT must be "production" before going live');
  }
  if (!env.MPESA_CALLBACK_SECRET) {
    prodGates.push('MPESA_CALLBACK_SECRET is mandatory in production');
  }
  if (env.MPESA_CALLBACK_URL && !env.MPESA_CALLBACK_URL.startsWith('https://')) {
    prodGates.push('MPESA_CALLBACK_URL must be HTTPS');
  }
}

/* ── Render (or equivalent) reminder ─────────────────────────────────────
   These can't be verified from inside the container (the values ARE set
   here by definition on Render) — this is a reminder to audit the Render
   dashboard, not a machine check. Kept informational (always ok) so it
   never blocks a deploy. */
if (env.RENDER) {
  result('Render: set secrets in dashboard, not render.yaml', true,
    'manual audit item — ensure MPESA_* live in Render env vars (never render.yaml, which is in the repo)');
}

/* ── Output ────────────────────────────────────────────────────────────── */
const width = Math.max(...checks.map(c => c.name.length)) + 2;
console.log('M-Pesa production readiness check' + (prod ? '  (--prod gates ON)' : ''));
console.log('-'.repeat(72));
let failures = 0;
for (const c of checks) {
  const mark = c.ok ? '✅' : '❌';
  if (!c.ok) failures++;
  console.log(`${mark} ${c.name.padEnd(width)}${c.detail}`);
}
console.log('-'.repeat(72));

if (prodGates.length > 0) {
  console.log('\n🚫 Production gates failing (--prod):');
  for (const g of prodGates) console.log(`  • ${g}`);
  failures += prodGates.length;
}

console.log(failures === 0
  ? '\n✓ Ready for production (credentials + callback config present).'
  : `\n${failures} issue(s) to resolve before go-live.`);

process.exit(failures === 0 ? 0 : 1);
