'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// COOKIE STORE — RAM-based cookie manager with GitHub sync
//
// المبدأ:
//   الكوكيز تعيش في RAM فقط — لا ملفات دائمة على القرص.
//   yt-dlp يحتاج FILE PATH → نكتب ملف /tmp مؤقت عند كل استخدام
//   ونحذفه فوراً بعد انتهاء yt-dlp.
//
// دورة الحياة:
//   1. السيرفر يبدأ → يجلب config.json من GitHub → يحفظ الكوكيز في RAM
//   2. كل 10 دقائق → يُعيد الجلب (يكتشف تحديثات بدون restart)
//   3. remote_extractor يطلب pickCookie('facebook') → يحصل على path /tmp/...
//   4. بعد انتهاء yt-dlp → يستدعي releaseCookie(path) → نحذف الملف
//   5. عند فشل 403 → markFailed(path) → الكوكي محجوب 30 دقيقة في RAM
//
// متغيرات البيئة:
//   GITHUB_CONFIG_TOKEN  ← GitHub PAT (repo read scope)
//   GITHUB_CONFIG_URL    ← رابط API لـ config.json
//   COOKIE_REFRESH_MS    ← فترة التحديث (افتراضي 10 دقائق)
//   COOKIE_BLOCK_MS      ← فترة الحجب بعد الفشل (افتراضي 30 دقيقة)
//
// التوافق مع النظام القديم:
//   يُصدِّر نفس الواجهة: pickCookie, markCookieFailed, unblockCookie,
//   getCookieStatus, COOKIES_DIR
//   → الملفات الأخرى لا تحتاج أي تغيير
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const logger = require('../middleware/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const REFRESH_MS      = parseInt(process.env.COOKIE_REFRESH_MS  || String(10 * 60 * 1000));
const BLOCK_MS        = parseInt(process.env.COOKIE_BLOCK_MS    || String(30 * 60 * 1000));
const GITHUB_TOKEN    = process.env.GITHUB_CONFIG_TOKEN || '';
const GITHUB_URL      = process.env.GITHUB_CONFIG_URL  ||
  'https://api.github.com/repos/kodna-iq/streamvault-cookies/contents/config.json';

// Legacy export — kept for backward compat with admin.js
const COOKIES_DIR = path.join(os.tmpdir(), 'urdown_cookies');

// ── RAM storage ───────────────────────────────────────────────────────────────
//
// _store: Map<platform, CookieSlot[]>
//   platform = 'tiktok' | 'facebook' | 'instagram' | 'youtube' | 'twitter'
//
// CookieSlot = {
//   id:          string,       // уникальный ID (platform_index)
//   content:     string,       // raw Netscape cookie text
//   blockedUntil: number,      // timestamp ms (0 = not blocked)
//   failCount:   number,
//   successCount: number,
//   lastUsed:    number,       // timestamp ms
// }

const _store      = new Map();  // Map<platform, CookieSlot[]>
const _rrIndex    = new Map();  // Map<platform, number>  — round-robin counter
const _tmpFiles   = new Map();  // Map<tmpPath, slotId>   — active tmp files

// ── Platform key mapping ───────────────────────────────────────────────────────
// config.json key → platform name
// Supports both "tiktok" (single) and "tiktok_1", "tiktok_2" (multiple)

const KNOWN_PLATFORMS = ['youtube', 'tiktok', 'facebook', 'instagram', 'twitter'];

function _parsePlatformKey(key) {
  const k = key.toLowerCase().trim();
  // Try "platform_N" first
  const match = k.match(/^(.+?)_(\d+)$/);
  if (match) {
    const platform = match[1];
    const index    = parseInt(match[2], 10);
    if (KNOWN_PLATFORMS.includes(platform)) return { platform, index };
  }
  // Try plain "platform"
  if (KNOWN_PLATFORMS.includes(k)) return { platform: k, index: 0 };
  return null;
}

// ── Load cookies from raw map (called after GitHub fetch) ─────────────────────

function _loadFromMap(rawCookies) {
  if (!rawCookies || typeof rawCookies !== 'object') return 0;

  // Build new store — keep blocked state from old store
  const newStore = new Map();

  for (const [key, content] of Object.entries(rawCookies)) {
    if (!content || typeof content !== 'string' || !content.trim()) continue;

    const parsed = _parsePlatformKey(key);
    if (!parsed) {
      logger.warn(`[cookie-store] Unknown key in config.json: "${key}" — skipped`);
      continue;
    }

    const { platform, index } = parsed;
    const id      = `${platform}_${index}`;
    const cleaned = content
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .trim();

    if (!newStore.has(platform)) newStore.set(platform, []);

    // Preserve blocked state if this slot already existed
    const existingSlots = _store.get(platform) || [];
    const existing      = existingSlots.find(s => s.id === id);

    newStore.get(platform).push({
      id,
      content:      cleaned,
      blockedUntil: existing ? existing.blockedUntil : 0,
      failCount:    existing ? existing.failCount    : 0,
      successCount: existing ? existing.successCount : 0,
      lastUsed:     existing ? existing.lastUsed     : 0,
    });
  }

  // Replace store, sort each platform's slots by index
  _store.clear();
  for (const [platform, slots] of newStore) {
    slots.sort((a, b) => {
      const ai = parseInt(a.id.split('_').pop(), 10);
      const bi = parseInt(b.id.split('_').pop(), 10);
      return ai - bi;
    });
    _store.set(platform, slots);
  }

  const total = [..._store.values()].reduce((n, s) => n + s.length, 0);
  logger.info(`[cookie-store] Loaded ${total} cookie(s) across ${_store.size} platform(s)`);
  return total;
}

// ── GitHub fetch ──────────────────────────────────────────────────────────────

async function _fetchFromGitHub() {
  if (!GITHUB_TOKEN) {
    logger.warn('[cookie-store] GITHUB_CONFIG_TOKEN not set — skipping GitHub sync');
    return null;
  }

  return new Promise((resolve) => {
    const url = new URL(GITHUB_URL);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github.v3.raw',
        'Cache-Control': 'no-cache',
        'User-Agent':    'urdown-server/2.0',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            // Handle both raw JSON and base64 envelope
            let json;
            try {
              json = JSON.parse(body);
            } catch {
              // base64 envelope from GitHub API
              const envelope = JSON.parse(body);
              const decoded  = Buffer.from(
                envelope.content.replace(/\n/g, ''), 'base64'
              ).toString('utf8');
              json = JSON.parse(decoded);
            }
            resolve(json);
          } catch (e) {
            logger.error(`[cookie-store] JSON parse error: ${e.message}`);
            resolve(null);
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          logger.error(`[cookie-store] GitHub auth failed (${res.statusCode}) — check GITHUB_CONFIG_TOKEN`);
          resolve(null);
        } else if (res.statusCode === 404) {
          logger.error('[cookie-store] config.json not found in repo (404)');
          resolve(null);
        } else {
          logger.warn(`[cookie-store] GitHub returned HTTP ${res.statusCode}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      logger.error(`[cookie-store] GitHub fetch error: ${e.message}`);
      resolve(null);
    });

    req.setTimeout(15_000, () => {
      req.destroy();
      logger.warn('[cookie-store] GitHub fetch timed out (15s)');
      resolve(null);
    });

    req.end();
  });
}

// ── Sync: fetch + load ────────────────────────────────────────────────────────

async function sync() {
  logger.info('[cookie-store] syncing from GitHub...');
  const config = await _fetchFromGitHub();
  if (!config) {
    logger.warn('[cookie-store] sync failed — keeping existing cookies in RAM');
    return false;
  }

  const rawCookies = config.cookies;
  if (!rawCookies || Object.keys(rawCookies).length === 0) {
    logger.warn('[cookie-store] config.json has no "cookies" key or it is empty');
    return false;
  }

  const count = _loadFromMap(rawCookies);
  logger.info(`[cookie-store] sync OK — ${count} cookie(s) in RAM`);
  return true;
}

// ── Tmp file management ───────────────────────────────────────────────────────
// yt-dlp requires --cookies FILE_PATH.
// We write a temp file per use and delete it after yt-dlp finishes.

function _writeTmpCookie(slot) {
  try {
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true });
    }
    const tmpPath = path.join(
      COOKIES_DIR,
      `${slot.id}_${crypto.randomBytes(4).toString('hex')}.txt`
    );
    fs.writeFileSync(tmpPath, slot.content, 'utf8');
    _tmpFiles.set(tmpPath, slot.id);
    return tmpPath;
  } catch (e) {
    logger.error(`[cookie-store] Failed to write tmp cookie: ${e.message}`);
    return null;
  }
}

function _cleanTmpFile(tmpPath) {
  if (!tmpPath) return;
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    _tmpFiles.delete(tmpPath);
  } catch (_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pick the best available cookie for a platform.
 * Returns a tmp file path (for yt-dlp --cookies) or null.
 * Caller MUST call releaseCookie(path) when yt-dlp finishes.
 */
function pickCookie(platform) {
  const slots = _store.get(platform);
  if (!slots || slots.length === 0) return null;

  const now       = Date.now();
  const available = slots.filter(s => now > s.blockedUntil);

  let chosen;
  if (available.length === 0) {
    // All blocked — use the one whose block expires soonest (least harm)
    chosen = slots.reduce((a, b) => a.blockedUntil < b.blockedUntil ? a : b);
    logger.warn(`[cookie-store] All ${platform} cookies blocked — forcing ${chosen.id}`);
  } else {
    // Round-robin over available
    const idx = (_rrIndex.get(platform) || 0) % available.length;
    _rrIndex.set(platform, idx + 1);
    chosen = available[idx];
  }

  chosen.lastUsed = Date.now();
  const tmpPath   = _writeTmpCookie(chosen);

  if (tmpPath) {
    logger.info(
      `[cookie-store] ${platform} → ${chosen.id} ` +
      `(${available.length}/${slots.length} available) → ${path.basename(tmpPath)}`
    );
  }
  return tmpPath;
}

/**
 * Call after yt-dlp finishes (success or failure) to clean up tmp file.
 * Separate from markFailed so callers control when to delete.
 */
function releaseCookie(tmpPath) {
  _cleanTmpFile(tmpPath);
}

/**
 * Mark a cookie as failed (403, auth error).
 * Blocks it for BLOCK_MS. Also deletes the tmp file.
 */
function markCookieFailed(tmpPath) {
  if (!tmpPath) return;

  const slotId = _tmpFiles.get(tmpPath);
  _cleanTmpFile(tmpPath);

  if (!slotId) return;

  for (const slots of _store.values()) {
    const slot = slots.find(s => s.id === slotId);
    if (slot) {
      slot.failCount++;
      slot.blockedUntil = Date.now() + BLOCK_MS;
      logger.warn(
        `[cookie-store] ✗ ${slotId} blocked for ${BLOCK_MS / 60000}min ` +
        `(totalFails=${slot.failCount})`
      );
      return;
    }
  }
}

/**
 * Mark a cookie as succeeded. Clears any existing block.
 * Also deletes the tmp file.
 */
function markCookieSuccess(tmpPath) {
  if (!tmpPath) return;

  const slotId = _tmpFiles.get(tmpPath);
  _cleanTmpFile(tmpPath);

  if (!slotId) return;

  for (const slots of _store.values()) {
    const slot = slots.find(s => s.id === slotId);
    if (slot) {
      slot.successCount++;
      slot.blockedUntil = 0;
      return;
    }
  }
}

/**
 * Backward-compat alias for markCookieFailed.
 * Old callers pass a file path — this now works transparently.
 */
const markCookieFailedAlias = markCookieFailed;

/**
 * Unblock a specific slot by ID (e.g. "tiktok_1").
 */
function unblockCookie(slotIdOrPath) {
  // Accept either slotId "tiktok_1" or old-style file path
  const slotId = slotIdOrPath.includes(path.sep)
    ? _tmpFiles.get(slotIdOrPath)            // path → slotId
    : slotIdOrPath;                           // already a slotId

  if (!slotId) return;

  for (const slots of _store.values()) {
    const slot = slots.find(s => s.id === slotId);
    if (slot) {
      slot.blockedUntil = 0;
      logger.info(`[cookie-store] ✓ ${slotId} unblocked`);
      return;
    }
  }
}

/**
 * Unblock all cookies for a platform.
 */
function unblockPlatform(platform) {
  const slots = _store.get(platform) || [];
  for (const slot of slots) slot.blockedUntil = 0;
  logger.info(`[cookie-store] ✓ All ${platform} cookies unblocked`);
}

/**
 * Returns status for admin dashboard.
 * Shape is backward-compatible with old getCookieStatus().
 */
function getCookieStatus() {
  const now    = Date.now();
  const result = {};

  for (const [platform, slots] of _store) {
    result[platform] = slots.map(s => ({
      file:         s.id,                    // was basename(filePath)
      blocked:      now < s.blockedUntil,
      blockedUntil: s.blockedUntil || null,
      minutesLeft:  Math.max(0, Math.ceil((s.blockedUntil - now) / 60000)),
      failCount:    s.failCount,
      successCount: s.successCount,
    }));
  }
  return result;
}

/**
 * Returns full status for /cookies/:platform endpoint.
 */
function getPlatformStatus(platform) {
  const slots = _store.get(platform);
  if (!slots) return null;

  const now       = Date.now();
  const available = slots.filter(s => now > s.blockedUntil).length;

  return {
    platform,
    total:     slots.length,
    available,
    allBlocked: available === 0 && slots.length > 0,
    slots: slots.map(s => ({
      id:           s.id,
      blocked:      now < s.blockedUntil,
      minutesLeft:  Math.max(0, Math.ceil((s.blockedUntil - now) / 60000)),
      failCount:    s.failCount,
      successCount: s.successCount,
    })),
  };
}

/**
 * Returns all platforms summary.
 */
function getAllStatus() {
  return KNOWN_PLATFORMS
    .map(p => getPlatformStatus(p))
    .filter(Boolean);
}

// ── Startup + auto-refresh ────────────────────────────────────────────────────

let _refreshTimer = null;

async function init() {
  await sync();

  _refreshTimer = setInterval(async () => {
    try { await sync(); }
    catch (e) { logger.error(`[cookie-store] refresh error: ${e.message}`); }
  }, REFRESH_MS);

  logger.info(`[cookie-store] auto-refresh every ${REFRESH_MS / 60000}min`);
}

function stop() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ── Cleanup stale tmp files on startup ───────────────────────────────────────
// In case of crash, /tmp may have leftover cookie files.

function _cleanStaleTmpFiles() {
  try {
    if (!fs.existsSync(COOKIES_DIR)) return;
    const files = fs.readdirSync(COOKIES_DIR);
    for (const f of files) {
      if (f.endsWith('.txt')) {
        try { fs.unlinkSync(path.join(COOKIES_DIR, f)); } catch (_) {}
      }
    }
    if (files.length > 0) {
      logger.info(`[cookie-store] Cleaned ${files.length} stale tmp file(s)`);
    }
  } catch (_) {}
}

_cleanStaleTmpFiles();

// ── Exports ───────────────────────────────────────────────────────────────────
// Backward-compatible: same names as old cookie_manager.js

module.exports = {
  // Lifecycle
  init,
  stop,
  sync,

  // Core API (same interface as old cookie_manager)
  pickCookie,
  releaseCookie,
  markCookieFailed:  markCookieFailedAlias,
  markCookieSuccess,
  unblockCookie,
  unblockPlatform,

  // Status
  getCookieStatus,
  getPlatformStatus,
  getAllStatus,

  // Legacy compat
  COOKIES_DIR,
};
