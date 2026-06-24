/**
 * mailer.js — email notifications
 *
 * Login alerts:         Gmail SMTP via nodemailer. Configure with EMAIL_USER +
 *                        EMAIL_PASS (a Gmail App Password) in .env.
 * Signup confirmation:   Resend. Configure with RESEND_API_KEY + RESEND_FROM_EMAIL.
 * Both are independently optional — if either is unset, that notification is
 * silently skipped and the app works fine without it.
 */

const nodemailer = require('nodemailer');
const { Resend }  = require('resend');

function mailerConfigured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function resendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

let resendClient = null;
function getResendClient() {
  if (!resendConfigured()) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

let transporter = null;
function getTransporter() {
  if (!mailerConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }
  return transporter;
}

/* Fire-and-forget — never let a mail failure affect the login response.
   Includes the account's email/deviceId/role explicitly — a display name
   alone (e.g. several test accounts all named "Demo Customer") isn't enough
   to tell which account actually signed in. */
async function sendLoginAlert(toEmail, { name, deviceId, role, time }) {
  try {
    const t = getTransporter();
    if (!t || !toEmail) return;

    await t.sendMail({
      from:    `"SolGrid" <${process.env.EMAIL_USER}>`,
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
  } catch (err) {
    console.warn('[Mailer] Failed to send login notification:', err.message);
  }
}

/* Fire-and-forget — never let a mail failure affect the registration response.
   Returns true/false so callers can log success without awaiting delivery. */
async function sendSignupConfirmation(toEmail, { name }) {
  try {
    const client = getResendClient();
    if (!client || !toEmail) return false;

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

module.exports = { sendLoginAlert, mailerConfigured, sendSignupConfirmation, resendConfigured };
