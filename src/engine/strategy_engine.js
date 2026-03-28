'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY ENGINE — PRODUCTION FIXED
//
// FIXES APPLIED:
//
// FIX-SE1  classifyPlatform: added facebook_live detection
//          (was returning 'facebook' for all Facebook URLs including live)
// FIX-SE2  classifyPlatform: added instagram_live detection
// FIX-SE3  evaluateRules: added facebook_live and instagram_live to platforms list
// FIX-SE4  resolveClients: live platforms skip client rotation (they use ffmpeg directly)
// ─────────────────────────────────────────────────────────────────────────────

const { stmts } = require('../db/database');
const { getLatestVersions } = require('./version_tracker');
const logger = require('../middleware/logger');

const SPIKE_WINDOW_SECS  = parseInt(process.env.SPIKE_WINDOW_MINUTES  || '5')  * 60;
const SPIKE_403          = parseInt(process.env.SPIKE_403_THRESHOLD   || '10');
const SPIKE_NOFORMAT     = parseInt(process.env.SPIKE_NOFORMAT_THRESHOLD || '8');

// ── Platform classifier ───────────────────────────────────────────────────────

function classifyPlatform(url, hintPlatform) {
  if (hintPlatform && hintPlatform !== 'auto') return hintPlatform;
  if (!url) return 'generic';

  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    if (url.includes('/live') || url.includes('live_stream')) return 'youtube_live';
    return 'youtube';
  }

  if (url.includes('tiktok.com')) {
    // FIX-SE1: tiktok live detection
    if (url.includes('/live')) return 'tiktok_live';
    return 'tiktok';
  }

  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    // FIX-SE1: facebook live detection (was missing — returned 'facebook' for all)
    // Facebook live URLs contain /videos/live or have live indicators
    if (
      url.includes('/videos/live') ||
      url.includes('live_video') ||
      url.includes('/live/') ||
      url.includes('?live_id=')
    ) {
      return 'facebook_live';
    }
    return 'facebook';
  }

  if (url.includes('instagram.com')) {
    // FIX-SE2: instagram live detection
    if (url.includes('/live/') || url.includes('/live?')) return 'instagram_live';
    return 'instagram';
  }

  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';

  // ── [NEW] منصات إضافية ────────────────────────────────────────────────────
  // Reddit — فيديوهات v.redd.it مجزأة (audio+video منفصل)
  if (url.includes('reddit.com') || url.includes('v.redd.it'))   return 'reddit';

  // Vimeo — CDN مختلف، جودات عالية
  if (url.includes('vimeo.com'))                                  return 'vimeo';

  // Dailymotion — منتشر في المنطقة العربية
  if (url.includes('dailymotion.com') || url.includes('dai.ly')) return 'dailymotion';

  // Snapchat Spotlight
  if (url.includes('snapchat.com') || url.includes('story.snapchat')) return 'snapchat';

  // Threads — مربوط بـ Instagram، يستخدم نفس الكوكيز
  if (url.includes('threads.net'))                                return 'threads';

  return 'generic';
}

// ── Spike detection ───────────────────────────────────────────────────────────

function isSpiking(platform, errorType) {
  try {
    const row = stmts.getSpikeCount.get(platform, errorType);
    if (!row) return false;
    if (errorType === 'forbidden')  return row.count >= SPIKE_403;
    if (errorType === 'no_formats') return row.count >= SPIKE_NOFORMAT;
    return false;
  } catch { return false; }
}

// ── Force-HLS decision ────────────────────────────────────────────────────────

function shouldForceHls(platform, config) {
  if (config.force_hls) return true;
  if (isSpiking(platform, 'forbidden'))  return true;
  if (isSpiking(platform, 'no_formats')) return true;
  return false;
}

// ── Client list — apply spike degradation ─────────────────────────────────────

function resolveClients(platform, config) {
  // FIX-SE4: live platforms use ffmpeg directly, no yt-dlp client rotation needed
  const isLive = platform.endsWith('_live');
  if (isLive) {
    return {
      clients:  [],
      fallback: [],
    };
  }

  let clients  = JSON.parse(config.clients  || '[]');
  let fallback = JSON.parse(config.fallback || '[]');

  if (isSpiking(platform, 'forbidden')) {
    clients  = clients.filter(c => c !== 'android');
    fallback = ['android_vr', 'web_safari', 'ios', 'web'].filter(c => !clients.includes(c));
    logger.warn(`[strategy] ${platform}: 403 spike — demoted android client`);
  }

  return { clients, fallback };
}

// ── Format priority — apply spike degradation ─────────────────────────────────

function resolveFormatPriority(platform, config, forceHls) {
  const base = JSON.parse(config.format_priority || '["mp4","hls"]');
  if (forceHls) {
    return ['hls', ...base.filter(f => f !== 'hls')];
  }
  return base;
}

// ── Main: build strategy for a request ───────────────────────────────────────

async function buildStrategy(url, hintPlatform, appVersion, device) {
  const platform = classifyPlatform(url, hintPlatform);

  let cfg = stmts.getConfig.get(platform) || stmts.getConfig.get('generic');
  if (!cfg) {
    cfg = {
      platform,
      clients:         '[]',
      fallback:        '[]',
      format_priority: '["mp4","hls"]',
      flags:           '["--socket-timeout","20"]',
      force_hls:       0,
      use_cookies:     0,
      extra:           null,
    };
  }

  const forceHls              = shouldForceHls(platform, cfg);
  const { clients, fallback } = resolveClients(platform, cfg);
  const formatPriority        = resolveFormatPriority(platform, cfg, forceHls);
  const flags                 = JSON.parse(cfg.flags || '[]');
  const extra                 = cfg.extra ? JSON.parse(cfg.extra) : {};

  const versions = await getLatestVersions();

  const strategy = {
    platform,
    clients,
    fallback,
    format_priority: formatPriority,
    flags,
    force_hls:   forceHls,
    use_cookies: Boolean(cfg.use_cookies),
    extra,
  };

  logger.info(`[strategy] ${platform} → clients=${clients.join('+')||'none'} hls=${forceHls} v=${versions.stable}`);

  return {
    strategy,
    yt_dlp_version: versions.stable,
    yt_dlp_nightly: versions.nightly,
    force_update:   false,
    server_time:    Date.now(),
  };
}

// ── Update config from admin or auto-heal ─────────────────────────────────────

function applyConfigPatch(platform, patch) {
  const existing = stmts.getConfig.get(platform);
  if (!existing) throw new Error(`Unknown platform: ${platform}`);

  const updated = {
    platform,
    clients:         patch.clients         ? JSON.stringify(patch.clients)        : existing.clients,
    fallback:        patch.fallback         ? JSON.stringify(patch.fallback)        : existing.fallback,
    format_priority: patch.format_priority  ? JSON.stringify(patch.format_priority) : existing.format_priority,
    flags:           patch.flags            ? JSON.stringify(patch.flags)           : existing.flags,
    force_hls:       patch.force_hls  !== undefined ? (patch.force_hls ? 1 : 0)  : existing.force_hls,
    use_cookies:     patch.use_cookies !== undefined ? (patch.use_cookies ? 1 : 0) : existing.use_cookies,
    extra:           patch.extra !== undefined ? JSON.stringify(patch.extra) : existing.extra,
  };

  stmts.updateConfig.run(updated);
  logger.info(`[strategy] config patched for ${platform}`);
  return updated;
}

module.exports = { buildStrategy, applyConfigPatch, classifyPlatform, isSpiking };
