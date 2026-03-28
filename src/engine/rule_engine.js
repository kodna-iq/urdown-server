'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// SELF-EVOLVING RULE ENGINE — PRODUCTION FIXED
//
// FIXES APPLIED:
//
// FIX-RE1  evaluateRules: added facebook_live, instagram_live, youtube_live
//          to platforms list (was missing — live platform data was never analyzed)
// FIX-RE2  _tryRestoreDefaults: extended to handle all platforms (not just youtube)
// FIX-RE3  analyzeClientPerformance: skip live platforms (they have no clients)
// ─────────────────────────────────────────────────────────────────────────────

const { db, stmts }        = require('../db/database');
const { applyConfigPatch } = require('./strategy_engine');
const logger               = require('../middleware/logger');

// ── Rule evaluation ───────────────────────────────────────────────────────────

function evaluateRules() {
  // FIX-RE1: added all live platforms
  const platforms = [
    'youtube', 'youtube_live',
    'tiktok',  'tiktok_live',
    'facebook', 'facebook_live',
    'instagram', 'instagram_live',
    'generic',
  ];
  for (const platform of platforms) {
    try { _evaluatePlatform(platform); } catch (e) {
      logger.error(`[rule-engine] ${platform}: ${e.message}`);
    }
  }
}

function _evaluatePlatform(platform) {
  const stats = stmts.platformStats.all(platform);
  if (!stats.length) return;

  const totalFails    = stats.filter(s => !s.success).reduce((n, s) => n + s.cnt, 0);
  const totalSuccess  = stats.filter(s => s.success).reduce((n, s) => n + s.cnt, 0);
  const forbidden403  = stats.find(s => !s.success && s.error_type === 'forbidden')?.cnt || 0;
  const noFormats     = stats.find(s => !s.success && s.error_type === 'no_formats')?.cnt || 0;
  const totalAttempts = totalFails + totalSuccess;

  if (totalAttempts < 3) return;

  const failRate = totalFails / totalAttempts;

  // Rule 1: 403 spike on youtube/android → demote android
  if (platform === 'youtube' && forbidden403 >= 5) {
    const cfg = stmts.getConfig.get('youtube');
    if (!cfg) return;
    const clients = JSON.parse(cfg.clients || '[]');
    if (clients.includes('android') && clients[0] !== 'ios') {
      applyConfigPatch('youtube', {
        clients:  ['ios', 'android'],
        fallback: ['android_vr', 'web_safari', 'web'],
      });
      logger.warn(`[rule-engine] RULE 1: youtube 403×${forbidden403} → ios promoted`);
    }
  }

  // Rule 2: noFormats spike → force HLS (skip live platforms, already HLS)
  const isLive = platform.endsWith('_live');
  if (noFormats >= 5 && !_getForceHls(platform) && !isLive) {
    applyConfigPatch(platform, { force_hls: true });
    logger.warn(`[rule-engine] RULE 2: ${platform} noFormats×${noFormats} → force_hls=true`);
  }

  // Rule 3: >80% failure rate → force HLS + reset clients (skip live platforms)
  if (failRate > 0.80 && totalAttempts >= 10 && !isLive) {
    applyConfigPatch(platform, {
      force_hls: true,
      clients:   platform === 'youtube' ? ['ios'] : [],
      fallback:  platform === 'youtube' ? ['android_vr', 'web_safari', 'web'] : [],
    });
    logger.error(
      `[rule-engine] RULE 3: ${platform} failRate=${(failRate*100).toFixed(0)}% → EMERGENCY HLS`
    );
  }

  // Rule 4: recovery — restore defaults if things improve
  if (failRate < 0.15 && totalAttempts >= 10) {
    _tryRestoreDefaults(platform);
  }
}

function _getForceHls(platform) {
  const cfg = stmts.getConfig.get(platform);
  return cfg ? !!cfg.force_hls : false;
}

// FIX-RE2: extended to handle all non-live platforms
function _tryRestoreDefaults(platform) {
  if (platform.endsWith('_live')) return; // never auto-restore live configs

  if (platform === 'youtube') {
    const cfg = stmts.getConfig.get('youtube');
    if (!cfg) return;
    const clients = JSON.parse(cfg.clients || '[]');
    if (clients.length === 1 && clients[0] === 'ios') {
      applyConfigPatch('youtube', {
        clients:   ['android', 'ios'],
        force_hls: false,
      });
      logger.info('[rule-engine] RULE 4: youtube restored to android+ios (recovery)');
    }
  } else {
    // For other platforms: just restore force_hls=false if it was set
    if (_getForceHls(platform)) {
      applyConfigPatch(platform, { force_hls: false });
      logger.info(`[rule-engine] RULE 4: ${platform} force_hls restored to false (recovery)`);
    }
  }
}

// ── Client performance analyzer ───────────────────────────────────────────────

function analyzeClientPerformance() {
  try {
    const rows = db.prepare(`
      SELECT client_used, success, COUNT(*) as cnt, AVG(elapsed_ms) as avg_ms
      FROM telemetry
      WHERE created_at > unixepoch() - 3600
        AND client_used IS NOT NULL
        AND client_used != ''
      GROUP BY client_used, success
    `).all();

    const clients = {};
    for (const row of rows) {
      if (!clients[row.client_used]) clients[row.client_used] = { ok: 0, fail: 0, avgMs: 0 };
      if (row.success) {
        clients[row.client_used].ok    += row.cnt;
        clients[row.client_used].avgMs  = row.avg_ms;
      } else {
        clients[row.client_used].fail += row.cnt;
      }
    }

    const problems = Object.entries(clients)
      .filter(([, v]) => {
        const total = v.ok + v.fail;
        return total >= 5 && (v.fail / total) > 0.70;
      })
      .map(([client]) => client);

    if (problems.length > 0) {
      logger.warn(`[rule-engine] Underperforming clients: ${problems.join(', ')}`);
      // FIX-RE3: only re-rank non-live youtube config
      const ytCfg = stmts.getConfig.get('youtube');
      if (ytCfg) {
        const primary = JSON.parse(ytCfg.clients || '[]')
            .filter(c => !problems.includes(c));
        if (primary.length > 0) {
          applyConfigPatch('youtube', { clients: primary });
          logger.info(`[rule-engine] youtube primary clients → ${primary.join('+')}`);
        }
      }
    }
  } catch (e) {
    logger.warn(`[rule-engine] analyzeClientPerformance: ${e.message}`);
  }
}

module.exports = { evaluateRules, analyzeClientPerformance };
