'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// /admin/* — protected management endpoints
//
//   GET  /admin/configs            — list all platform configs
//   GET  /admin/configs/:platform  — get one config
//   PUT  /admin/configs/:platform  — patch a config
//   GET  /admin/stats/:platform    — last-hour stats
//   GET  /admin/versions           — yt-dlp versions
//   POST /admin/versions/refresh   — force GitHub check
//   POST /admin/heal/:platform     — manually trigger auto-heal
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const Joi      = require('joi');
const { db, stmts }    = require('../db/database');
const { applyConfigPatch } = require('../engine/strategy_engine');
const { checkVersions, getLatestVersions } = require('../engine/version_tracker');
const { validateAdmin } = require('../middleware/auth');
const logger   = require('../middleware/logger');

router.use(validateAdmin);

// ── List all platform configs ─────────────────────────────────────────────────

router.get('/configs', (req, res) => {
  const rows = db.prepare('SELECT * FROM platform_configs ORDER BY platform').all();
  const parsed = rows.map(r => ({
    ...r,
    clients:         JSON.parse(r.clients),
    fallback:        JSON.parse(r.fallback),
    format_priority: JSON.parse(r.format_priority),
    flags:           JSON.parse(r.flags),
    extra:           r.extra ? JSON.parse(r.extra) : null,
  }));
  res.json(parsed);
});

// ── Get single config ─────────────────────────────────────────────────────────

router.get('/configs/:platform', (req, res) => {
  const row = stmts.getConfig.get(req.params.platform);
  if (!row) return res.status(404).json({ error: 'Platform not found' });
  res.json({
    ...row,
    clients:         JSON.parse(row.clients),
    fallback:        JSON.parse(row.fallback),
    format_priority: JSON.parse(row.format_priority),
    flags:           JSON.parse(row.flags),
    extra:           row.extra ? JSON.parse(row.extra) : null,
  });
});

// ── Patch config ──────────────────────────────────────────────────────────────

const patchSchema = Joi.object({
  clients:         Joi.array().items(Joi.string()).optional(),
  fallback:        Joi.array().items(Joi.string()).optional(),
  format_priority: Joi.array().items(Joi.string()).optional(),
  flags:           Joi.array().items(Joi.string()).optional(),
  force_hls:       Joi.boolean().optional(),
  use_cookies:     Joi.boolean().optional(),
  extra:           Joi.object().optional().allow(null),
});

router.put('/configs/:platform', (req, res) => {
  const { error, value } = patchSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const updated = applyConfigPatch(req.params.platform, value);
    logger.info(`[admin] patched config for ${req.params.platform}`);
    res.json({ ok: true, updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Last-hour stats per platform ──────────────────────────────────────────────

router.get('/stats/:platform', (req, res) => {
  const rows = stmts.platformStats.all(req.params.platform);
  const out  = { platform: req.params.platform, window: '1h', breakdown: rows };
  res.json(out);
});

// ── yt-dlp versions ───────────────────────────────────────────────────────────

router.get('/versions', async (req, res) => {
  const v = await getLatestVersions();
  res.json(v);
});

router.post('/versions/refresh', async (req, res) => {
  await checkVersions();
  const v = await getLatestVersions();
  res.json({ ok: true, ...v });
});

// ── Manual heal ───────────────────────────────────────────────────────────────

router.post('/heal/:platform', (req, res) => {
  const { platform } = req.params;
  const patch = req.body || {};
  try {
    applyConfigPatch(platform, patch);
    logger.warn(`[admin] manual heal applied to ${platform}`);
    res.json({ ok: true, platform });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── [NEW] Cookie Manager endpoints ───────────────────────────────────────────
// GET  /admin/cookies        → حالة كل ملفات الكوكيز (محجوب / متاح)
// POST /admin/cookies/unblock → رفع الحجب عن ملف معين
//
// مثال:
//   GET  /admin/cookies
//   POST /admin/cookies/unblock   { "file": "fb_1.txt" }

const { getCookieStatus, unblockCookie, COOKIES_DIR } = require('../engine/cookie_manager');
const path = require('path');

router.get('/cookies', validateAdmin, (req, res) => {
  res.json({
    cookies_dir: COOKIES_DIR,
    status: getCookieStatus(),
  });
});

router.post('/cookies/unblock', validateAdmin, (req, res) => {
  const { file } = req.body || {};
  if (!file) return res.status(400).json({ error: 'file required' });

  // أمان: منع path traversal
  const safeName = path.basename(file);
  const fullPath = path.join(COOKIES_DIR, safeName);

  unblockCookie(fullPath);
  logger.info(`[admin] cookie unblocked: ${safeName}`);
  res.json({ ok: true, file: safeName });
});

module.exports = router;
