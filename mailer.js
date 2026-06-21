/**
 * mailer.js — Gmail SMTP email notifications via nodemailer
 *
 * Configure with EMAIL_USER + EMAIL_PASS (a Gmail App Password) in .env.
 * If unset, sending is silently skipped — the app works fine without it.
 */

const nodemailer = require('nodemailer');

function mailerConfigured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
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

/* Fire-and-forget — never let a mail failure affect the login response */
async function sendLoginAlert(toEmail, { name, time }) {
  try {
    const t = getTransporter();
    if (!t || !toEmail) return;

    await t.sendMail({
      from:    `"Lagriff" <${process.env.EMAIL_USER}>`,
      to:      toEmail,
      subject: 'New sign-in to your Lagriff account',
      text:
`Hi ${name || 'there'},

We noticed a new sign-in to your Lagriff account on ${time}.

If this was you, no action is needed. If you don't recognize this activity, please change your password immediately.

— Lagriff`
    });
  } catch (err) {
    console.warn('[Mailer] Failed to send login notification:', err.message);
  }
}

module.exports = { sendLoginAlert, mailerConfigured };
