// backend/middleware/auth.js
const admin = require('firebase-admin');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const idToken = header.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = { userId: decoded.uid, email: decoded.email };
    return next();
  } catch (e) {
    console.error('Firebase Auth verify failed:', e);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticate;
