// backend/routes/userProfileRoutes.js

const express      = require('express');
const authenticate = require('../middleware/auth');
const UserProfile  = require('../models/UserProfile');

const router = express.Router();

// POST   /api/user-profile
// Protects via `authenticate`, then upserts the user’s profile
router.post(
  '/user-profile',
  authenticate,
  async (req, res) => {
    try {
      const userId = req.user.userId;
      const data   = req.body;

      const profile = await UserProfile.findOneAndUpdate(
        { userId },
        { userId, ...data },
        { new: true, upsert: true }
      );
      return res.json(profile);
    } catch (err) {
      console.error('user-profile POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// GET    /api/user-profile/:userId
// Only allows the logged‑in user to read their own profile
router.get(
  '/user-profile/:userId',
  authenticate,
  async (req, res) => {
    try {
      const requestedId = req.params.userId;
      if (requestedId !== req.user.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const profile = await UserProfile.findOne({ userId: requestedId });
      if (!profile) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.json(profile);
    } catch (err) {
      console.error('user-profile GET error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
