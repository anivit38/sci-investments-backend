// backend/email.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const nodemailer = require('nodemailer');
const axios = require('axios');

const PASS = process.env.BREVO_SMTP_KEY || process.env.BREVO_API_KEY;

const transport = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: false,          // STARTTLS on 587
  requireTLS: true,
  auth: { user: 'apikey', pass: PASS },
});

async function sendEmail({ to, subject, html }) {
  try {
    return await transport.sendMail({
      from: `"${process.env.BREVO_FROM_NAME}" <${process.env.BREVO_FROM_EMAIL}>`,
      to, subject, html,
    });
  } catch (err) {
    // If SMTP auth fails, try HTTP API as a fallback
    if (err && err.code === 'EAUTH') {
      const payload = {
        sender: { email: process.env.BREVO_FROM_EMAIL, name: process.env.BREVO_FROM_NAME },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      };
      const r = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
        headers: {
          'api-key': process.env.BREVO_API_KEY || process.env.BREVO_SMTP_KEY,
          'accept': 'application/json',
          'content-type': 'application/json',
        },
        timeout: 15000,
      });
      return { messageId: r.data?.messageId || 'via-api' };
    }
    throw err;
  }
}

module.exports = { sendEmail };
