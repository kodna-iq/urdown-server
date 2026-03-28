'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// POST /resolve
// Core endpoint — app calls this before every extraction.
// Returns the optimal strategy for the given URL.
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const Joi      = require('joi');
const router   = express.Router();
const { buildStrategy } = require('../engine/strategy_engine');
const { validateApiKey } = require('../middleware/auth');
const logger   = require('../middleware/logger');

const schema = Joi.object({
  url:         Joi.string().uri().required(),
  platform:    Joi.string().optional().default('auto'),
  app_version: Joi.string().optional().default('unknown'),
  device:      Joi.string().valid('android','ios','desktop').optional().default('android'),
});

router.post('/', validateApiKey, async (req, res) => {
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    const result = await buildStrategy(
      value.url, value.platform, value.app_version, value.device
    );
    res.json(result);
  } catch (e) {
    logger.error(`[/resolve] ${e.message}`);
    res.status(500).json({ error: 'Strategy engine error', detail: e.message });
  }
});

module.exports = router;
