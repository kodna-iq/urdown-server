'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// POST /v2/proxy-download
// Server downloads the video and streams it directly to the app.
// Used when content is geo-blocked in the client's region (Iraq, etc.).
//
// EXTRACTED from index.js for maintainability.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');

const { validateApiKey }                              = require('../middleware/auth');
const { pickCookie, markCookieFailed, releaseCookie } = require('../engine/cookie_store');
const logger = require('../middleware/logger');

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TMP_DIR   = path.resolve(process.env.TMP_DIR || 'tmp');

// ── SSRF protection ───────────────────────────────────────────────────────────
const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fd[0-9a-f]{2}:)/i;

function validateUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'url missing' };
  if (url.length > 2048)               return { ok: false, reason: 'url too long' };

  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid url format' }; }

  if (!['http:', 'https:'].includes(parsed.protocol))
    return { ok: false, reason: 'only http/https allowed' };

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(host))
    return { ok: false, reason: 'private/loopback addresses not allowed' };

  return { ok: true };
}

// ── Safe extension extraction ─────────────────────────────────────────────────
function safeExt(filename) {
  const raw = path.extname(filename).toLowerCase().replace('.', '');
  return raw.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'mp4';
}

// ── Platform-specific yt-dlp arguments ───────────────────────────────────────
function buildPlatformArgs(url, platform) {
  const args = [];
  const u = (url || '').toLowerCase();

  if (platform === 'youtube' || u.includes('youtube.com') || u.includes('youtu.be')) {
    args.push('--extractor-args', 'youtube:player_client=tv_embedded,web;skip=hls,dash');
  } else if (platform === 'tiktok' || u.includes('tiktok.com') || u.includes('vt.tiktok')) {
    args.push(
      '--add-header', 'Referer:https://www.tiktok.com/',
      '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      '--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_version=35.1.3'
    );
  } else if (platform === 'instagram' || u.includes('instagram.com')) {
    args.push(
      '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    );
  } else if (platform === 'facebook' || u.includes('facebook.com') || u.includes('fb.watch')) {
    args.push(
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--no-check-certificates'
    );
  }
  return args;
}

// ── yt-dlp runner ─────────────────────────────────────────────────────────────
function runYtDlp(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`yt-dlp timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      const errLine = stderr.split('\n').find(l => l.startsWith('ERROR:') || (l.startsWith('[') && l.includes(':')))
        || stderr.split('\n').pop() || 'unknown error';
      reject(new Error(errLine.trim()));
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Core proxy-download logic ─────────────────────────────────────────────────
async function proxyDownload(url, platform, format, res, db) {
  const tmpFile = path.join(TMP_DIR, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const platformArgs = buildPlatformArgs(url, platform);

  // Cookie manager integration
  let activeCookiePath = null;
  try {
    const { stmts } = db;
    const platformCfg = stmts.getConfig.get(platform) || stmts.getConfig.get('generic');
    if (platformCfg && platformCfg.use_cookies) {
      activeCookiePath = pickCookie(platform);
      if (activeCookiePath) {
        platformArgs.push('--cookies', activeCookiePath);
        logger.info(`[proxy-download] using cookie: ${path.basename(activeCookiePath)}`);
      }
    }
  } catch (_) {
    // cookie manager is optional — proceed without cookies
  }

  const formatStr = format === 'audio'
    ? 'bestaudio[ext=m4a]/bestaudio'
    : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';

  const args = [
    ...platformArgs,
    '--no-playlist', '--merge-output-format', 'mp4',
    '--no-mtime', '--no-warnings',
    '--socket-timeout', '30', '--retries', '3',
    '-f', formatStr, '-o', `${tmpFile}.%(ext)s`, url,
  ];

  try {
    await runYtDlp(args, 120_000);
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(path.basename(tmpFile)));
    if (!files.length) throw new Error('Download completed but file not found');

    const filePath = path.join(TMP_DIR, files[0]);
    const ext      = safeExt(files[0]);
    const mime     = ext === 'mp4' ? 'video/mp4'
                   : ext === 'm4a' ? 'audio/mp4'
                   : ext === 'webm' ? 'video/webm'
                   : 'application/octet-stream';
    const stat = fs.statSync(filePath);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => {
      try { fs.unlinkSync(filePath); } catch (_) {}
      // Release cookie tmp file after download completes
      if (activeCookiePath) releaseCookie(activeCookiePath);
    });

  } catch (err) {
    // Mark cookie as failed on 403, release on other errors
    const is403 = /403|forbidden/i.test(err.message);
    if (is403 && activeCookiePath) {
      try { markCookieFailed(activeCookiePath); } catch (_) {}
      logger.warn(`[proxy-download] 403 — cookie marked failed: ${path.basename(activeCookiePath)}`);
    } else if (activeCookiePath) {
      try { releaseCookie(activeCookiePath); } catch (_) {}
    }
    // Clean up any partial tmp files
    try {
      fs.readdirSync(TMP_DIR)
        .filter(f => f.startsWith(path.basename(tmpFile)))
        .forEach(f => { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) {} });
    } catch (_) {}
    throw err;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
// db is injected by index.js when registering the router
let _db = null;

router.post('/', validateApiKey, async (req, res) => {
  const { url, platform, format } = req.body;
  if (!url) return res.status(400).json({ error: 'url required', code: 'missing_url' });

  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) {
    logger.warn(`[proxy-download] rejected: ${urlCheck.reason} — ${url.slice(0, 80)}`);
    return res.status(400).json({ error: urlCheck.reason, code: 'invalid_url' });
  }

  logger.info(`[proxy-download] ${platform || 'generic'} ${url.slice(0, 80)}`);
  try {
    await proxyDownload(url, platform || 'generic', format || 'video', res, _db);
  } catch (err) {
    logger.error(`[proxy-download] failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message, code: 'download_failed' });
  }
});

// Called by index.js: require('./routes/proxy').setDb(db)
router.setDb = function(db) { _db = db; };

module.exports = router;
