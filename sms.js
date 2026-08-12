/**
 * sms.js — SMS notifications via Africa's Talking.
 *
 * Mirrors mailer.js: fire-and-forget, optional. Configure with AT_USERNAME +
 * AT_API_KEY (username "sandbox" auto-targets the sandbox API host). If either
 * is unset, every send silently no-ops and the app works fine without SMS.
 *
 * Sandbox caveat (same spirit as Resend's): sandbox messages never reach real
 * phones — they only appear in the simulator at
 * https://developers.africastalking.com (Launch Simulator, then register the
 * destination number there first). Going live means creating a production app
 * in the AT dashboard and pointing AT_USERNAME/AT_API_KEY at it.
 */

const axios = require('axios');
/* Pure message builders — no dependency on sms.js, so a top-level require
   is safe (no circular import) and matches the file's style. */
const { buildWeatherSms } = require('./weather-alerts');

const SEND_TIMEOUT = 10_000;

function smsConfigured() {
  return !!(process.env.AT_API_KEY && process.env.AT_USERNAME);
}

function apiHost() {
  return process.env.AT_USERNAME === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';
}

/* The users.phone column holds a mix of styles (+2547…, 2547…, 07…) — the
   signup form doesn't enforce a format. Africa's Talking only accepts
   international format with a leading +, so anything else is unusable. */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[\s\-()]/g, '');
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits))      return '+254' + digits.slice(1);
  if (/^254\d{9}$/.test(digits))    return '+' + digits;
  return null;
}

/* Fire-and-forget — a failed send must never break the cron loop that
   called it, so this never throws. Returns { ok, reason }: ok is true only
   when Africa's Talking accepted the message (statusCode 100 Processed /
   101 Sent / 102 Queued); on failure, reason carries a human-readable cause
   (e.g. AT's "InvalidPhoneNumber") so callers like the admin test-SMS panel
   can show *why* instead of a generic failure. */
async function sendSms(phone, message) {
  try {
    if (!smsConfigured()) {
      return { ok: false, reason: 'SMS is not configured — set AT_USERNAME and AT_API_KEY' };
    }
    const to = normalizePhone(phone);
    if (!to) {
      return { ok: false, reason: `"${phone}" is not a usable phone number — use international format like +254712345678` };
    }

    const body = new URLSearchParams({
      username: process.env.AT_USERNAME,
      to,
      message
    });
    if (process.env.AT_SENDER_ID) body.set('from', process.env.AT_SENDER_ID);

    const { data } = await axios.post(`${apiHost()}/version1/messaging`, body.toString(), {
      timeout: SEND_TIMEOUT,
      headers: {
        apiKey:         process.env.AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:         'application/json'
      }
    });

    const recipient = data?.SMSMessageData?.Recipients?.[0];
    if (!recipient || ![100, 101, 102].includes(recipient.statusCode)) {
      const cause = recipient?.status || data?.SMSMessageData?.Message || 'no recipient in response';
      console.warn(`[SMS] Africa's Talking rejected send to ${to}:`, cause);
      return { ok: false, reason: `Africa's Talking rejected the send to ${to}: ${cause}` };
    }
    return { ok: true };
  } catch (err) {
    /* 401 here usually means a wrong/not-yet-active API key (fresh keys can
       take ~3 minutes) — say so, since "status code 401" alone sends people
       hunting through the wrong config. */
    const hint = err.response?.status === 401
      ? 'Africa\'s Talking returned 401 — API key is wrong or not yet active (new keys take ~3 min)'
      : err.message;
    console.warn('[SMS] Failed to send:', hint);
    return { ok: false, reason: hint };
  }
}

/* Both messages are kept under 160 chars (one SMS segment) — a second
   segment doubles the per-message cost across the whole customer base. */

async function sendLowBalanceSms(phone, { name, balance }) {
  return sendSms(phone,
    `SolGrid: Hi ${name || 'there'}, your wallet is down to KES ${Number(balance).toFixed(2)}. `
    + 'Top up via M-Pesa before it runs out to keep your power on.');
}

async function sendPowerCutSms(phone, { name }) {
  return sendSms(phone,
    `SolGrid: Hi ${name || 'there'}, your wallet balance ran out and power to your unit is paused. `
    + 'Top up via M-Pesa to restore it right away.');
}

/* Daily weather + energy-tip alert — content is built in weather-alerts.js
   (buildWeatherSms), which already keeps the whole message under 160 chars
   (ASCII-only, so one GSM-7 segment) for a single-segment cost. Fire-and-
   forget like the rest. */
async function sendDailyWeatherSms(phone, { name, day, city }) {
  return sendSms(phone, buildWeatherSms({ name, day, city }));
}

module.exports = { smsConfigured, normalizePhone, sendSms, sendLowBalanceSms, sendPowerCutSms, sendDailyWeatherSms };
