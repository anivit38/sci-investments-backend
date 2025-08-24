const express = require('express');
const { sendEmail } = require('../email');
const router = express.Router();

router.post('/subscribe', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'invalid_email' });

    await sendEmail({
      to: email,
      subject: 'Welcome to SCI Investments Weekly Picks',
      html: `<h2>Welcome 👋</h2><p>Thanks for subscribing.</p>`,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('newsletter send failed:', e);
    res.status(500).json({ error: 'send_failed' });
  }
});

module.exports = router;
