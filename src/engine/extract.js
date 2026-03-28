// ═══════════════════════════════════════════════════════════════════════════════
// SERVER V10 — extract.js
//
// V10 FIXES:
//   • TikTok cache TTL: 30min → 3min (CDN URLs are IP-bound & expire fast)
//   • TikTok yt-dlp: mobile iPhone UA + alisg API hostname
//   • Response includes proxy_url for TikTok (server proxies the video)
//   • GET /proxy?url=...&platform=tiktok  — streams TikTok video through server
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const express  = require('express');
const { exec } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');

const router = express.Router();

// ── Platform-aware cache TTLs ──────────────────────────────────────────────
// V10 FIX: TikTok CDN URLs are IP-bound to the server IP.
// Device gets 403 using them directly. Reduced to 3min.

const CACHE_TTLS = {
  youtube:   5  * 60 * 1000,
  tiktok:    3  * 60 * 1000,   // V10: was 30min — CDN URLs expire & are IP-bound
  facebook:  60 * 60 * 1000,
  instagram: 10 * 60 * 1000,
  twitter:   10 * 60 * 1000,
  twitch:     2 * 60 * 1000,
  other:      5 * 60 * 1000,
};

const extractionCache = new Map();   // url → { result, timestamp, platform }

// ── [NEW] Request Deduplication ────────────────────────────────────────────
// يمنع تشغيل yt-dlp متعدد لنفس الرابط في نفس الوقت.
// الطلب الثاني لنفس الرابط يستلم نفس Promise الجارية بدل عملية جديدة.
const _pendingExtract = new Map(); // url → Promise

// ── Error classification ───────────────────────────────────────────────────

function classifyError(msg) {
  const e = (msg || '').toLowerCase();
  if (e.includes('403') || e.includes('forbidden') || e.includes('sabr')) return 'forbidden403';
  if (e.includes('timeout') || e.includes('timed out'))                   return 'timeout';
  if (e.includes('no video formats') || e.includes('no formats'))         return 'no_formats';
  if (e.includes('sign in') || e.includes('login'))                       return 'auth_required';
  if (e.includes('private'))                                               return 'private';
  if (e.includes('not currently live'))                                    return 'not_live';
  if (e.includes('network') || e.includes('socket'))                      return 'network_error';
  return 'unknown';
}

// ── Platform detection ─────────────────────────────────────────────────────

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com'))                             return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('instagram.com'))                          return 'instagram';
  if (u.includes('twitter.com') || u.includes('x.com'))    return 'twitter';
  if (u.includes('twitch.tv'))                              return 'twitch';
  // [NEW] منصات إضافية
  if (u.includes('reddit.com') || u.includes('v.redd.it')) return 'reddit';
  if (u.includes('vimeo.com'))                              return 'vimeo';
  if (u.includes('dailymotion.com') || u.includes('dai.ly')) return 'dailymotion';
  if (u.includes('snapchat.com') || u.includes('story.snapchat')) return 'snapchat';
  if (u.includes('threads.net'))                            return 'threads';
  return 'other';
}

// ── Cache helpers ──────────────────────────────────────────────────────────

function getCached(url, platform) {
  const entry = extractionCache.get(url);
  if (!entry) return null;
  const ttl = CACHE_TTLS[platform] || CACHE_TTLS.other;
  if (Date.now() - entry.timestamp > ttl) {
    extractionCache.delete(url);
    return null;
  }
  return entry.result;
}

function setCache(url, platform, result) {
  extractionCache.set(url, { result, timestamp: Date.now(), platform });
  // Prune if too large
  if (extractionCache.size > 500) {
    const firstKey = extractionCache.keys().next().value;
    extractionCache.delete(firstKey);
  }
}

// ── V9 yt-dlp args builder ─────────────────────────────────────────────────

function buildYtdlpArgs(url, platform, { cookiesPath, client = 'android' } = {}) {
  const args = [
    '--dump-json',
    '--no-download',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', '20',
  ];

  // V9: Client selection
  if (platform === 'youtube') {
    args.push('--extractor-args', `youtube:player_client=${client}`);
  }

  // V9: Platform headers
  switch (platform) {
    case 'tiktok':
      // V10 FIX: Use mobile iPhone UA — TikTok CDN is more permissive with mobile UAs.
      // alisg API hostname has better reachability from Railway's US servers.
      args.push(
        '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        '--add-header', 'Referer:https://www.tiktok.com/',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_version=35.1.3',
      );
      break;
    case 'instagram':
      args.push(
        '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      );
      break;
    default:
      args.push(
        '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      );
  }

  if (cookiesPath && fs.existsSync(cookiesPath)) {
    args.push('--cookies', cookiesPath);
  }

  return args;
}

// ── Main extraction endpoint ───────────────────────────────────────────────

router.post('/extract', async (req, res) => {
  const { url, cookiesPath, client = 'android', forceRefresh = false } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  const platform = detectPlatform(url);
  const t0       = Date.now();

  // Cache check
  if (!forceRefresh) {
    const cached = getCached(url, platform);
    if (cached) {
      console.log(`[V9Server] CACHE_HIT platform=${platform} url=${url.substring(0, 60)}`);
      return res.json({ ...cached, _cached: true, _latencyMs: 0 });
    }
  }

  // [NEW] Deduplication: لو في طلب جارٍ لنفس الرابط، انتظر نتيجته
  if (_pendingExtract.has(url)) {
    console.log(`[V9Server] DEDUP_WAIT platform=${platform} url=${url.substring(0, 60)}`);
    try {
      const dedupResult = await _pendingExtract.get(url);
      return res.json({ ...dedupResult, _deduped: true, _latencyMs: Date.now() - t0 });
    } catch (dedupErr) {
      // الطلب الأصلي فشل — اسمح لهذا الطلب يحاول من جديد
    }
  }

  const args    = buildYtdlpArgs(url, platform, { cookiesPath, client });
  const ytdlp   = process.env.YTDLP_PATH || 'yt-dlp';
  const cmd     = `${ytdlp} ${args.map(a => `"${a}"`).join(' ')} "${url}"`;

  console.log(`[V9Server] EXTRACT platform=${platform} client=${client}`);

  // V9: 25s timeout per request
  const timeout = 25_000;
  let proc;

  // [NEW] سجّل هذا الطلب في الـ pending map حتى الطلبات المتكررة تنتظره
  let _pendingResolve, _pendingReject;
  const _pendingPromise = new Promise((res, rej) => { _pendingResolve = res; _pendingReject = rej; });
  _pendingExtract.set(url, _pendingPromise);

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (proc) proc.kill('SIGKILL');
        reject(new Error('yt-dlp timeout'));
      }, timeout);

      proc = exec(cmd, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          const errType = classifyError(stderr || err.message);
          reject(Object.assign(err, { errType, stderr }));
        } else {
          resolve(stdout.trim());
        }
      });
    });

    // Parse JSON — find last valid JSON object
    const lines = result.split('\n').filter(Boolean);
    let parsed  = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { parsed = JSON.parse(lines[i]); break; } catch (_) {}
    }
    if (!parsed) throw new Error('No JSON in yt-dlp output');

    // Build response
    const formats = (parsed.formats || [])
      .filter(f => f.url)
      .map(f => ({
        url:     f.url,
        quality: f.height ? `${f.height}p` : (f.acodec !== 'none' && f.vcodec === 'none' ? 'audio' : 'best'),
        ext:     f.ext || 'mp4',
        height:  f.height,
        width:   f.width,
        bitrate: f.tbr,
        isAudio: f.vcodec === 'none' && f.acodec !== 'none',
        isHls:   f.ext === 'm3u8' || (f.url || '').includes('.m3u8'),
      }));

    const response = {
      direct_url:    parsed.url || (formats[0] && formats[0].url) || '',
      format:        parsed.ext || 'mp4',
      title:         parsed.title,
      thumbnail_url: parsed.thumbnail,
      uploader:      parsed.uploader,
      duration:      parsed.duration,
      is_live:       parsed.is_live || false,
      formats,
      _platform:     platform,
      _latencyMs:    Date.now() - t0,
      _engine:       'server_v10',
    };

    // V10 FIX: For TikTok, add proxy_url.
    // The direct_url is an IP-bound CDN URL valid only from the server's IP.
    // The app MUST use proxy_url to stream through the server instead of
    // hitting the CDN directly (which always results in 403).
    if (platform === 'tiktok' && response.direct_url) {
      const encoded = encodeURIComponent(response.direct_url);
      const serverBase = process.env.SERVER_BASE_URL || '';
      response.proxy_url = serverBase
        ? `${serverBase}/proxy?url=${encoded}&platform=tiktok`
        : null;
      response._tiktok_note = 'Use proxy_url for download — direct_url is IP-bound to server';
    }

    // Cache
    setCache(url, platform, response);

    // [NEW] أعلم الطلبات المنتظرة بالنتيجة ثم احذف من الـ map
    _pendingResolve(response);
    _pendingExtract.delete(url);

    console.log(`[V9Server] ✓ EXTRACT platform=${platform} ${Date.now() - t0}ms formats=${formats.length}`);
    res.json(response);

  } catch (err) {
    const errType = err.errType || classifyError(err.message);
    console.error(`[V9Server] ✗ EXTRACT platform=${platform} errType=${errType} err=${err.message}`);

    // [NEW] أعلم الطلبات المنتظرة بالفشل ثم احذف
    _pendingReject(err);
    _pendingExtract.delete(url);

    res.status(500).json({
      error:     err.message,
      errType,
      platform,
      _latencyMs: Date.now() - t0,
    });
  }
});

// ── /proxy — Server-side video proxy for TikTok (and others) ──────────────
// V10: TikTok CDN URLs are bound to the server's IP.
// The app calls this endpoint and the server streams the video bytes to the app.
// This completely bypasses the 403 problem because the request comes from
// the same server IP that extracted the URL.
//
// GET /proxy?url=<encoded_cdn_url>&platform=tiktok
//
// The app downloads the stream from this endpoint as if it were a normal HTTP file.

router.get('/proxy', async (req, res) => {
  const { url: rawUrl, platform = 'tiktok' } = req.query;
  if (!rawUrl) return res.status(400).json({ error: 'url query param required' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid url encoding' });
  }

  // Security: only allow known CDN hostnames — prevent open proxy abuse
  const ALLOWED_HOSTS = [
    'v16-webapp-prime.us.tiktok.com',
    'v19-webapp-prime.us.tiktok.com',
    'v26-webapp.tiktok.com',
    'v77.tiktok.com',
    'api16-normal-c-useast1a.tiktokv.com',
    'api22-normal-c-alisg.tiktokv.com',
    'v16-sg.tiktokcdn.com',
    'v19-sg.tiktokcdn.com',
    'rr1.sn-o097znsr.googlevideo.com',
    'rr2.sn-o097znsr.googlevideo.com',
    'rr3.sn-o097znsr.googlevideo.com',
    'rr4.sn-o097znsr.googlevideo.com',
    'rr5.sn-o097znsr.googlevideo.com',
    'rr6.sn-o097znsr.googlevideo.com',
  ];

  let parsedHost;
  try {
    parsedHost = new URL(targetUrl).hostname;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid target URL' });
  }

  const isAllowed = ALLOWED_HOSTS.some(h =>
    parsedHost === h || parsedHost.endsWith('.' + h.split('.').slice(-3).join('.'))
  );

  if (!isAllowed) {
    console.warn(`[proxy] BLOCKED host=${parsedHost}`);
    return res.status(403).json({ error: 'Host not allowed' });
  }

  // Build headers to forward — mimic what yt-dlp used during extraction
  const forwardHeaders = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Referer': platform === 'tiktok' ? 'https://www.tiktok.com/' : '',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
  };

  // Forward Range header from app (supports resume/seek)
  if (req.headers['range']) {
    forwardHeaders['Range'] = req.headers['range'];
  }

  console.log(`[proxy] → ${platform} host=${parsedHost} range=${req.headers['range'] || 'none'}`);

  const lib = targetUrl.startsWith('https') ? https : http;

  const proxyReq = lib.get(targetUrl, { headers: forwardHeaders }, (proxyRes) => {
    // Forward status and relevant headers to the app
    const statusCode = proxyRes.statusCode || 200;

    if (statusCode >= 400) {
      console.error(`[proxy] upstream ${statusCode} for ${parsedHost}`);
      res.status(statusCode).json({ error: `Upstream returned ${statusCode}` });
      proxyRes.resume();
      return;
    }

    const headersToForward = {};
    ['content-type', 'content-length', 'content-range', 'accept-ranges',
     'last-modified', 'etag'].forEach(h => {
      if (proxyRes.headers[h]) headersToForward[h] = proxyRes.headers[h];
    });

    // Always set content-disposition so app treats it as a download
    headersToForward['content-disposition'] = 'attachment';
    headersToForward['cache-control'] = 'no-store';

    res.writeHead(statusCode, headersToForward);
    proxyRes.pipe(res);

    let bytesSent = 0;
    proxyRes.on('data', chunk => { bytesSent += chunk.length; });
    proxyRes.on('end', () => {
      console.log(`[proxy] ✓ done ${parsedHost} bytes=${bytesSent}`);
    });
  });

  proxyReq.on('error', err => {
    console.error(`[proxy] request error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: `Proxy request failed: ${err.message}` });
    }
  });

  // If client disconnects, abort the upstream request
  req.on('close', () => {
    proxyReq.destroy();
  });
});

// ── Health endpoint ────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    version:    'v9',
    cacheSize:  extractionCache.size,
    timestamp:  new Date().toISOString(),
  });
});

// ── Cache stats ────────────────────────────────────────────────────────────

router.get('/cache-stats', (req, res) => {
  const platforms = {};
  for (const [, entry] of extractionCache) {
    platforms[entry.platform] = (platforms[entry.platform] || 0) + 1;
  }
  res.json({ total: extractionCache.size, platforms });
});

module.exports = router;
