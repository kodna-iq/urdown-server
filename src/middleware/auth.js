'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// Validates X-API-Key header for all protected routes.
//
// FIX-AUTH-1: Key comparison upgraded to SHA-256 HMAC to prevent:
//   (a) UTF-8 byte-length mismatch when key contains non-ASCII characters
//       causing timingSafeEqual to throw RangeError.
//   (b) Raw buffer comparison leaking key length via error path timing.
//   Both inputs are hashed before comparison, so lengths always match (32 bytes).
//
// FIX-AUTH-2: API_KEY env var alias added for backward compatibility.
//   Old deployments using API_KEY= still work; API_SECRET takes precedence.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
require('dotenv').config();

// Support both API_SECRET (canonical) and API_KEY (legacy alias).
// API_SECRET takes precedence if both are set.
const API_SECRET = process.env.API_SECRET || process.env.API_KEY || 'dev-secret-change-me';

if (API_SECRET === 'dev-secret-change-me') {
  // Warn at startup — this check runs when the module is first required.
  // process._urdownLogger may not be ready yet, so use console.warn.
  console.warn('[auth] WARNING: API_SECRET is not set. Using insecure default. Set API_SECRET in .env before deploying.');
}

/**
 * Hash a string with SHA-256 so timingSafeEqual always compares
 * equal-length buffers (32 bytes) regardless of input length or encoding.
 */
function _hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function validateApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) {
    return res.status(401).json({ error: 'Missing X-API-Key header', code: 'missing_key' });
  }

  // Hash both sides — guarantees equal buffer lengths for timingSafeEqual,
  // eliminating the RangeError thrown when raw buffers differ in length.
  const providedHash = _hash(key);
  const expectedHash = _hash(API_SECRET);

  if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
    return res.status(403).json({ error: 'Invalid API key', code: 'invalid_key' });
  }

  next();
}

// Admin routes use the same key for now.
// Extend with JWT claims in production if role separation is needed.
const validateAdmin = validateApiKey;

module.exports = { validateApiKey, validateAdmin };
