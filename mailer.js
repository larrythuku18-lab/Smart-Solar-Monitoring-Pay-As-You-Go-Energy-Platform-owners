/**
 * mailer.js — email notifications, both via Resend.
 *
 * Login alerts and signup confirmations both go through Resend. Configure
 * with RESEND_API_KEY + RESEND_FROM_EMAIL. Optional — if RESEND_API_KEY is
 * unset, both are silently skipped and the app works fine without them.
 *
 * Previously, login alerts went through Gmail SMTP (nodemailer) — switched
 * because personal-Gmail-relayed mail has no sender reputation, so Gmail's
 * own spam filter routinely buried these in the recipient's spam folder.
 *
 * Caveat: Resend's sandbox sender (the default onboarding@resend.dev, used
 * until you verify a custom domain under Domains in the Resend dashboard)
 * only delivers to the email address your OWN Resend account is registered
 * under — not arbitrary recipients. Until a domain is verified, login alerts
 * for any account other than that one address will silently fail to send.
 */

const { Resend } = require('resend');
/* Pure message builders — no dependency on mailer.js (safe top-level
   require, matching the file's style). */
const { buildWeatherEmail } = require('./weather-alerts');

function resendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

/** Resend's onboarding@resend.dev sender only delivers to the account owner. */
function resendSandboxMode() {
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  return from.includes('@resend.dev');
}

function resendSandboxAllowedRecipient() {
  return process.env.RESEND_SANDBOX_RECIPIENT || process.env.ADMIN_EMAIL || null;
}

function canDeliverEmail(toEmail) {
  if (!toEmail) return false;
  if (!resendSandboxMode()) return true;
  const allowed = resendSandboxAllowedRecipient();
  if (!allowed) return false;
  return toEmail.toLowerCase() === allowed.toLowerCase();
}

let resendClient = null;
function getResendClient() {
  if (!resendConfigured()) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/* Fire-and-forget — never let a mail failure affect the login response.
   Includes the account's email/deviceId/role explicitly — a display name
   alone (e.g. several test accounts all named "Demo Customer") isn't enough
   to tell which account actually signed in. */
async function sendLoginAlert(toEmail, { name, deviceId, role, time }) {
  try {
    const client = getResendClient();
    if (!client || !canDeliverEmail(toEmail)) return;

    const { error } = await client.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to:      toEmail,
      subject: `New sign-in to your SolGrid account (${toEmail})`,
      text:
`Hi ${name || 'there'},

We noticed a new sign-in to your SolGrid account.

  Account:   ${toEmail}
  Device ID: ${deviceId || 'n/a'}
  Role:      ${role || 'n/a'}
  Time:      ${time}

If this was you, no action is needed. If you don't recognize this activity, please change your password immediately.

— SolGrid`
    });

    if (error) {
      console.warn('[Mailer] Resend rejected login alert:', error.message);
    }
  } catch (err) {
    console.warn('[Mailer] Failed to send login notification:', err.message);
  }
}

/* Fire-and-forget — never let a mail failure affect the registration response.
   Returns true/false so callers can log success without awaiting delivery. */
async function sendSignupConfirmation(toEmail, { name }) {
  try {
    const client = getResendClient();
    if (!client || !canDeliverEmail(toEmail)) return false;

    const { error } = await client.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to:      toEmail,
      subject: 'Welcome to SolGrid — your account is ready',
      text:
`Hi ${name || 'there'},

Your SolGrid account has been created successfully. You can now log in and top up your wallet to keep your power on.

— SolGrid`
    });

    if (error) {
      console.warn('[Mailer] Resend rejected signup confirmation:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Mailer] Failed to send signup confirmation:', err.message);
    return false;
  }
}

/* Fire-and-forget — the forgot-password endpoint answers identically whether
   or not the email exists, so a mail failure must never change the response.
   The raw reset link only ever exists here and in the recipient's inbox. */
async function sendPasswordReset(toEmail, { name, resetUrl }) {
  try {
    const client = getResendClient();
    if (!client || !canDeliverEmail(toEmail)) return false;

    const { error } = await client.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to:      toEmail,
      subject: 'Reset your SolGrid password',
      text:
`Hi ${name || 'there'},

We received a request to reset the password for your SolGrid account.

Reset it here (link valid for 1 hour):
${resetUrl}

If you didn't request this, you can safely ignore this email — your password is unchanged.

— SolGrid`
    });

    if (error) {
      console.warn('[Mailer] Resend rejected password reset email:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Mailer] Failed to send password reset email:', err.message);
    return false;
  }
}

/* Daily weather + energy-tip alert — content is built in weather-alerts.js
   (buildWeatherEmail). Fire-and-forget; a failed daily digest must never
   affect anything else. */
async function sendDailyWeatherEmail(toEmail, { name, day, city, days }) {
  try {
    const client = getResendClient();
    if (!client || !canDeliverEmail(toEmail)) return false;

    const { error } = await client.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to:      toEmail,
      subject: `SolGrid daily outlook — ${city || 'your area'} (${day?.label || ''})`,
      text:    buildWeatherEmail({ name, day, city, days })
    });

    if (error) {
      console.warn('[Mailer] Resend rejected daily weather email:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Mailer] Failed to send daily weather email:', err.message);
    return false;
  }
}

module.exports = { sendLoginAlert, sendSignupConfirmation, sendPasswordReset, sendDailyWeatherEmail, resendConfigured };
