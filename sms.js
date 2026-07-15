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
   called it. Returns true only when Africa's Talking accepted the message
   (statusCode 100 Processed / 101 Sent / 102 Queued). */
async function sendSms(phone, message) {
  try {
    if (!smsConfigured()) return false;
    const to = normalizePhone(phone);
    if (!to) return false;

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
      console.warn(`[SMS] Africa's Talking rejected send to ${to}:`,
        recipient?.status || data?.SMSMessageData?.Message || 'no recipient in response');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[SMS] Failed to send:', err.message);
    return false;
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

module.exports = { smsConfigured, normalizePhone, sendSms, sendLowBalanceSms, sendPowerCutSms };
