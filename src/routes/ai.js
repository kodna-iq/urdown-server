'use strict';
const express           = require('express');
const router            = express.Router();
const { validateAdmin } = require('../middleware/auth');
const { runAdvisor, collectStats } = require('../engine/ai_advisor');
const logger            = require('../middleware/logger');

router.use(validateAdmin);

router.get('/status', (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY || '';
  const ok  = key.length > 10;
  res.json({
    ai_enabled:   ok,
    model:        'claude-sonnet-4-20250514',
    window_hours: parseInt(process.env.AI_ADVISOR_WINDOW_HOURS || '24'),
    message:      ok ? '✅ AI Advisor جاهز' : '⚠️ أضف ANTHROPIC_API_KEY في Render Environment',
  });
});

router.get('/stats', (req, res) => {
  try { res.json({ ok: true, ...collectStats() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/advisor', async (req, res) => {
  try {
    const result = await runAdvisor();
    res.status(result.ok ? 200 : 503).json(result);
  } catch (e) {
    logger.error(`[ai/advisor] ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
