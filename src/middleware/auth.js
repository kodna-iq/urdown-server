'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// Validates X-API-Key header for all protected routes.
// Public routes (/health, /resolve, /telemetry) use a shared secret.
// Admin routes (/admin/*) require the same secret — extend for JWT if needed.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
require('dotenv').config();

const API_SECRET = process.env.API_SECRET || 'dev-secret-change-me';

function validateApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }
  // Constant-time comparison to prevent timing attacks
  const keyBuf    = Buffer.from(key);
  const secretBuf = Buffer.from(API_SECRET);
  if (keyBuf.length !== secretBuf.length ||
      !crypto.timingSafeEqual(keyBuf, secretBuf)) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

// Admin-only — same key for now, swap for JWT in production
const validateAdmin = validateApiKey;

module.exports = { validateApiKey, validateAdmin };
