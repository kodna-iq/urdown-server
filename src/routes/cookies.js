'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// GET  /cookies/:platform   → best cookie content for platform (for Flutter)
// GET  /cookies             → all platforms status
// POST /cookies/:platform/unblock → unblock all slots for platform
// POST /cookies/sync        → force re-fetch from GitHub now
//
// Protected by X-API-Key header (validateApiKey).
// Flutter app can call this to know if cookies are available before download.
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const { validateApiKey } = require('../middleware/auth');
const store    = require('../engine/cookie_store');
const logger   = require('../middleware/logger');

// All cookie routes require API key
router.use(validateApiKey);

// ── GET /cookies — all platforms summary ─────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    ok:        true,
    platforms: store.getAllStatus(),
    source:    'ram',
  });
});

// ── GET /cookies/:platform — status for one platform ─────────────────────────
router.get('/:platform', (req, res) => {
  const { platform } = req.params;
  const status = store.getPlatformStatus(platform.toLowerCase());

  if (!status) {
    return res.status(404).json({
      ok:       false,
      platform,
      error:    'No cookies loaded for this platform',
      total:    0,
      available: 0,
    });
  }

  res.json({ ok: true, ...status });
});

// ── POST /cookies/:platform/unblock — unblock all slots ──────────────────────
router.post('/:platform/unblock', (req, res) => {
  const { platform } = req.params;
  store.unblockPlatform(platform.toLowerCase());
  logger.info(`[cookies] unblocked all: ${platform}`);
  res.json({ ok: true, platform, message: `All ${platform} cookies unblocked` });
});

// ── POST /cookies/sync — force GitHub re-fetch ───────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    logger.info('[cookies] manual sync triggered');
    const ok = await store.sync();
    res.json({
      ok,
      message: ok ? 'Synced from GitHub' : 'Sync failed — check GITHUB_CONFIG_TOKEN',
      status:  store.getAllStatus(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
