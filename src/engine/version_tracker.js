'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// VERSION TRACKER
// Polls GitHub releases for yt-dlp stable + nightly.
// Caches in DB. Runs on a cron schedule.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const cron   = require('node-cron');
const { stmts } = require('../db/database');
const logger = require('../middleware/logger');

const STABLE_API  = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const NIGHTLY_API = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';

const HEADERS = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'UrDown-Server/1.0',
};

let _cache = { stable: 'unknown', nightly: 'unknown', force_update: false };

async function fetchTag(apiUrl) {
  const res = await axios.get(apiUrl, { headers: HEADERS, timeout: 10000 });
  const tag = res.data?.tag_name;
  if (!tag) throw new Error('No tag_name in response');
  return tag;
}

async function checkVersions() {
  try {
    const [stable, nightly] = await Promise.allSettled([
      fetchTag(STABLE_API),
      fetchTag(NIGHTLY_API),
    ]);

    if (stable.status === 'fulfilled') {
      const v = stable.value;
      stmts.setVersion.run({ channel: 'stable',  version: v });
      _cache.stable = v;
      logger.info(`[version] stable=${v}`);
    }
    if (nightly.status === 'fulfilled') {
      const v = nightly.value;
      stmts.setVersion.run({ channel: 'nightly', version: v });
      _cache.nightly = v;
      logger.info(`[version] nightly=${v}`);
    }
  } catch (e) {
    logger.warn(`[version] check failed: ${e.message}`);
  }
}

async function getLatestVersions() {
  // Return from memory cache; DB as backup
  if (_cache.stable === 'unknown') {
    const s = stmts.getVersion.get('stable');
    const n = stmts.getVersion.get('nightly');
    if (s) _cache.stable  = s.version;
    if (n) _cache.nightly = n.version;
  }
  return { ..._cache };
}

function startCron() {
  const intervalMin = parseInt(process.env.YTDLP_CHECK_INTERVAL_MINUTES || '60');
  // Check on startup
  checkVersions();
  // Then on schedule
  cron.schedule(`*/${intervalMin} * * * *`, checkVersions);
  logger.info(`[version] cron started — every ${intervalMin} min`);
}

module.exports = { checkVersions, getLatestVersions, startCron };
