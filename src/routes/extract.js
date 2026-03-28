'use strict';
// POST /extract — server-side extraction for Section 9
// Called by app when all local engines fail.

const express = require('express');
const Joi     = require('joi');
const router  = express.Router();
const { extractUrl }   = require('../extractors/remote_extractor');
const { validateApiKey } = require('../middleware/auth');
const logger  = require('../middleware/logger');

const schema = Joi.object({
  url:         Joi.string().uri().required(),
  app_version: Joi.string().optional().default('unknown'),
});

router.post('/', validateApiKey, async (req, res) => {
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  logger.info(`[/extract] ${value.url.slice(0, 80)}`);

  try {
    const result = await extractUrl(value.url);
    if (!result || !result.direct_url) {
      logger.warn(`[/extract] no URL found for ${value.url.slice(0, 80)}`);
      return res.status(404).json({ error: 'Could not extract direct URL' });
    }
    logger.info(`[/extract] ✓ ${result.format} ${result.direct_url.slice(0, 80)}`);
    res.json(result);
  } catch (e) {
    logger.error(`[/extract] ${e.message}`);
    res.status(500).json({ error: 'Extraction failed', detail: e.message });
  }
});

module.exports = router;
