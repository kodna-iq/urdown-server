'use strict';
// POST /telemetry — FIXED: allowUnknown + engine field added

const express  = require('express');
const Joi      = require('joi');
const router   = express.Router();
const { processEvent } = require('../engine/telemetry_processor');
const { validateApiKey } = require('../middleware/auth');
const logger   = require('../middleware/logger');

const schema = Joi.object({
  event_id:    Joi.string().max(64).required(),
  platform:    Joi.string().max(32).required(),
  url:         Joi.string().uri().optional(),
  success:     Joi.boolean().required(),
  client_used: Joi.string().max(32).optional().allow(null, ''),
  format_used: Joi.string().max(32).optional().allow(null, ''),
  error_type:  Joi.string().max(64).optional().allow(null, ''),
  error_raw:   Joi.string().max(500).optional().allow(null, ''),
  elapsed_ms:  Joi.number().integer().min(0).optional().allow(null),
  app_version: Joi.string().max(32).optional().allow(null, ''),
  device:      Joi.string().max(32).optional().allow(null, ''),
  // FIX: added engine field (sent by app but was missing from schema → 400)
  engine:      Joi.string().max(64).optional().allow(null, ''),
}).options({ allowUnknown: true });  // FIX: ignore any extra fields gracefully

router.post('/', validateApiKey, (req, res) => {
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    processEvent(value);
    res.json({ ok: true });
  } catch (e) {
    logger.error(`[/telemetry] ${e.message}`);
    res.status(500).json({ error: 'Telemetry processing error' });
  }
});

module.exports = router;
