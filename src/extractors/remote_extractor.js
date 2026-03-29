'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// REMOTE EXTRACTOR — v3
//
// التحسينات المضافة في v3:
//
// [1] REQUEST DEDUPLICATION (إلغاء التكرار)
//     Map بسيط يضمن أن نفس الرابط لا يُشغّل أكثر من yt-dlp واحد في الوقت ذاته.
//     أي طلب لاحق لنفس الرابط يستلم نفس Promise دون تشغيل عملية جديدة.
//
// [2] COOKIE ROTATION (تدوير الكوكيز)
//     Facebook وInstagram وThreads يستخدمان cookieManager.pickCookie()
//     لاختيار ملف بشكل round-robin. عند فشل بـ 403/auth يُعلَّم الملف
//     ويُتخطى 30 دقيقة.
//
// [3] NEW PLATFORMS (منصات إضافية)
//     Reddit (v.redd.it), Vimeo, Dailymotion, Snapchat Spotlight, Threads
//     مع هيدرات وإعدادات yt-dlp مخصصة لكل منها.
//
// FIXES FROM v2:
//   FIX-08  stdout string capped at 5MB
//   FIX-09  Rate limiting
//   FIX     Process cleanup on all exit paths
// ═══════════════════════════════════════════════════════════════════════════════

const { spawn }     = require('child_process');
const axios         = require('axios');
const logger        = require('../middleware/logger');
const cookieManager = require('../engine/cookie_store');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const MAX_STDOUT_BYTES = 5 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════════════════════
// [1] REQUEST DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════════

const _pendingRequests = new Map();

async function extractUrl(url) {
  if (_pendingRequests.has(url)) {
    logger.info(`[extractor] DEDUP hit for ${url.slice(0, 80)}`);
    return _pendingRequests.get(url);
  }

  const promise = _doExtract(url).finally(() => {
    _pendingRequests.delete(url);
  });

  _pendingRequests.set(url, promise);
  return promise;
}

async function _doExtract(url) {
  const ytdlpResult = await _extractYtDlp(url);
  if (ytdlpResult) return ytdlpResult;
  const directResult = await _extractDirect(url);
  if (directResult) return directResult;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// [3] PLATFORM DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function _detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be'))         return 'youtube';
  if (u.includes('tiktok.com'))                                     return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch'))        return 'facebook';
  if (u.includes('instagram.com'))                                  return 'instagram';
  if (u.includes('twitter.com') || u.includes('x.com'))            return 'twitter';
  if (u.includes('twitch.tv'))                                      return 'twitch';
  if (u.includes('reddit.com') || u.includes('v.redd.it'))         return 'reddit';
  if (u.includes('vimeo.com'))                                      return 'vimeo';
  if (u.includes('dailymotion.com') || u.includes('dai.ly'))       return 'dailymotion';
  if (u.includes('snapchat.com') || u.includes('story.snapchat'))  return 'snapchat';
  if (u.includes('threads.net'))                                    return 'threads';
  return 'other';
}

// ═══════════════════════════════════════════════════════════════════════════════
// [2] yt-dlp args builder (مع Cookie Rotation)
// ═══════════════════════════════════════════════════════════════════════════════

function _buildArgs(url, platform) {
  const args = [
    '--dump-json',
    '--no-download',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '20',
  ];

  // property مخفية لتمرير معلومة الكوكي المستخدمة للـ error handler
  let usedCookie = null;

  switch (platform) {
    case 'youtube':
      args.push('--extractor-args', 'youtube:player_client=android,ios');
      args.push('--add-header', `User-Agent:${UA_DESKTOP}`);
      break;

    case 'tiktok':
      args.push(
        '--add-header', `User-Agent:${UA_MOBILE}`,
        '--add-header', 'Referer:https://www.tiktok.com/',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--extractor-args', 'tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_version=35.1.3',
      );
      break;

    case 'facebook':
      usedCookie = cookieManager.pickCookie('facebook');
      if (usedCookie) args.push('--cookies', usedCookie);
      args.push('--add-header', 'User-Agent:facebookexternalhit/1.1');
      break;

    case 'instagram':
      usedCookie = cookieManager.pickCookie('instagram');
      if (usedCookie) args.push('--cookies', usedCookie);
      args.push('--add-header', `User-Agent:${UA_MOBILE}`);
      break;

    case 'twitter':
      args.push(
        '--add-header', `User-Agent:${UA_DESKTOP}`,
        '--add-header', 'Authorization:Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      );
      break;

    // [NEW] Reddit
    case 'reddit':
      args.push(
        '--add-header', `User-Agent:${UA_DESKTOP}`,
        '--add-header', 'Accept:application/json',
        '--merge-output-format', 'mp4',
      );
      break;

    // [NEW] Vimeo
    case 'vimeo':
      args.push(
        '--add-header', `User-Agent:${UA_DESKTOP}`,
        '--add-header', 'Referer:https://vimeo.com/',
      );
      break;

    // [NEW] Dailymotion
    case 'dailymotion':
      args.push(
        '--add-header', `User-Agent:${UA_DESKTOP}`,
        '--add-header', 'Referer:https://www.dailymotion.com/',
      );
      break;

    // [NEW] Snapchat
    case 'snapchat':
      args.push(
        '--add-header', `User-Agent:${UA_MOBILE}`,
        '--add-header', 'Referer:https://www.snapchat.com/',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
      );
      break;

    // [NEW] Threads (مربوط بـ Instagram — نفس الكوكيز)
    case 'threads':
      usedCookie = cookieManager.pickCookie('instagram');
      if (usedCookie) args.push('--cookies', usedCookie);
      args.push('--add-header', `User-Agent:${UA_MOBILE}`);
      break;

    default:
      args.push('--add-header', `User-Agent:${UA_DESKTOP}`);
  }

  return { args, usedCookie };
}

// ═══════════════════════════════════════════════════════════════════════════════
// yt-dlp extraction core
// ═══════════════════════════════════════════════════════════════════════════════

async function _extractYtDlp(url) {
  const platform = _detectPlatform(url);
  const { args, usedCookie } = _buildArgs(url, platform);

  try {
    const raw = await _spawnYtDlp(url, args);

    // Release tmp file after yt-dlp finishes (success path)
    if (usedCookie) cookieManager.releaseCookie(usedCookie);

    if (!raw) return null;

    const info = JSON.parse(raw.trim().split('\n').pop());

    const hls = info?.streamingData?.hlsManifestUrl || _findInFormats(info?.formats, 'm3u8');
    if (hls) return { direct_url: hls, format: 'm3u8', title: info.title, thumbnail_url: info.thumbnail, platform, headers: {} };

    const formats = (info?.formats || [])
      .filter(f => f.url && f.ext === 'mp4' && f.vcodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (formats.length > 0) {
      return { direct_url: formats[0].url, format: 'mp4', title: info.title, thumbnail_url: info.thumbnail, platform, headers: {} };
    }

    const any = info?.url || info?.manifest_url;
    if (any) return { direct_url: any, format: 'mp4', title: info.title, thumbnail_url: info.thumbnail, platform, headers: {} };

    return null;
  } catch (e) {
    // فشل بـ 403/auth → علّم الكوكي ثم احذف الملف المؤقت
    const msg = (e.message || '').toLowerCase();
    if (usedCookie && (msg.includes('403') || msg.includes('forbidden') || msg.includes('login') || msg.includes('sign in'))) {
      cookieManager.markCookieFailed(usedCookie); // يحذف الملف المؤقت داخلياً
    } else if (usedCookie) {
      cookieManager.releaseCookie(usedCookie);    // احذف الملف في بقية الأخطاء
    }
    logger.warn(`[extractor] yt-dlp failed (${platform}): ${e.message?.slice(0, 200)}`);
    return null;
  }
}

function _spawnYtDlp(url, extraArgs) {
  return new Promise((resolve, reject) => {
    const ytdlpBin  = process.env.YTDLP_PATH || 'yt-dlp';
    const spawnArgs = [...extraArgs, url];

    const proc = spawn(ytdlpBin, spawnArgs);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let capExceeded = false;

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!capExceeded) {
          capExceeded = true;
          logger.warn(`[extractor] stdout cap exceeded — killing yt-dlp`);
          proc.kill('SIGKILL');
          reject(new Error(`yt-dlp stdout exceeded ${MAX_STDOUT_BYTES / 1024 / 1024}MB`));
        }
        return;
      }
      stdout += chunk;
    });

    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp timeout'));
    }, 28_000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (capExceeded) return;
      if (code === 0 && stdout.trim()) {
        resolve(stdout);
      } else {
        const errLine = stderr.split('\n').find(l => l.includes('ERROR:')) || stderr.slice(0, 200);
        reject(new Error(errLine || `yt-dlp exit ${code}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      if (!capExceeded) reject(err);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Direct HTML extraction (fallback مع دعم المنصات الجديدة)
// ═══════════════════════════════════════════════════════════════════════════════

async function _extractDirect(rawUrl) {
  const platform = _detectPlatform(rawUrl);
  let url = rawUrl;
  try {
    let headers = { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'en-US,en;q=0.9' };

    switch (platform) {
      case 'tiktok':
        headers['Referer']    = 'https://www.tiktok.com/';
        headers['User-Agent'] = UA_MOBILE;
        break;
      case 'instagram':
      case 'threads':
        headers['User-Agent'] = UA_MOBILE;
        break;
      case 'facebook':
        headers['User-Agent'] = 'facebookexternalhit/1.1';
        break;
      case 'reddit':
        // Reddit JSON API
        url = url.replace(/\/$/, '') + '.json';
        headers['User-Agent'] = 'urdown-bot/1.0';
        break;
      case 'snapchat':
        headers['User-Agent'] = UA_MOBILE;
        headers['Referer']    = 'https://www.snapchat.com/';
        break;
    }

    const resp = await axios.get(url, { headers, timeout: 12_000, maxContentLength: 5 * 1024 * 1024 });
    const html = resp.data;
    if (!html) return null;

    const isString = typeof html === 'string';
    const title = isString ? (_ogTag(html, 'og:title') || _htmlTag(html, 'title') || 'Video') : 'Video';
    const thumb = isString ? _ogTag(html, 'og:image') : null;

    // YouTube
    if (platform === 'youtube' && isString) {
      const player = _extractJSON(html, 'ytInitialPlayerResponse');
      if (player) {
        const hlsUrl = player.streamingData?.hlsManifestUrl;
        if (hlsUrl) return { direct_url: hlsUrl, format: 'm3u8', title, thumbnail_url: thumb, platform, headers: {} };
        const fmts = player.streamingData?.formats || [];
        const mp4  = fmts.filter(f => (f.mimeType || '').includes('mp4')).sort((a, b) => (b.height || 0) - (a.height || 0));
        if (mp4.length > 0 && mp4[0].url) return { direct_url: mp4[0].url, format: 'mp4', title, thumbnail_url: thumb, platform, headers: {} };
      }
    }

    // TikTok
    if (platform === 'tiktok' && isString) {
      for (const pat of [/"playAddr"\s*:\s*"([^"]+)"/, /"downloadAddr"\s*:\s*"([^"]+)"/]) {
        const m = html.match(pat);
        if (m) {
          const v = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
          return { direct_url: v, format: 'mp4', title, thumbnail_url: thumb, platform, headers: { 'Referer': 'https://www.tiktok.com/' } };
        }
      }
    }

    // Facebook
    if (platform === 'facebook' && isString) {
      for (const pat of [/"hd_src"\s*:\s*"([^"]+)"/, /"sd_src"\s*:\s*"([^"]+)"/]) {
        const m = html.match(pat);
        if (m) {
          const v = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
          return { direct_url: v, format: 'mp4', title, thumbnail_url: thumb, platform, headers: {} };
        }
      }
    }

    // [NEW] Reddit JSON API
    if (platform === 'reddit') {
      try {
        const data = typeof html === 'string' ? JSON.parse(html) : html;
        const post  = data?.[0]?.data?.children?.[0]?.data;
        if (post) {
          const rv = post?.media?.reddit_video;
          if (rv?.fallback_url) {
            return { direct_url: rv.fallback_url, format: 'mp4', title: post.title || 'Reddit Video', thumbnail_url: post.thumbnail, platform, headers: {} };
          }
          if (rv?.hls_url) {
            return { direct_url: rv.hls_url, format: 'm3u8', title: post.title || 'Reddit Video', thumbnail_url: post.thumbnail, platform, headers: {} };
          }
          const cross = post?.crosspost_parent_list?.[0]?.media?.reddit_video?.fallback_url;
          if (cross) return { direct_url: cross, format: 'mp4', title: post.title || 'Reddit Video', thumbnail_url: post.thumbnail, platform, headers: {} };
        }
      } catch (_) {}
    }

    // [NEW] Vimeo
    if (platform === 'vimeo' && isString) {
      const m = html.match(/window\.vimeo\.clip_page_config\s*=\s*(\{.+?\});/s);
      if (m) {
        try {
          const cfg = JSON.parse(m[1]);
          const hls = cfg?.player?.config?.request?.files?.hls?.cdns;
          if (hls) {
            const firstCdn = Object.values(hls)[0];
            if (firstCdn?.url) return { direct_url: firstCdn.url, format: 'm3u8', title, thumbnail_url: thumb, platform, headers: {} };
          }
        } catch (_) {}
      }
    }

    // [NEW] Dailymotion
    if (platform === 'dailymotion' && isString) {
      const m = html.match(/"stream_chromecast_url"\s*:\s*"([^"]+)"/);
      if (m) {
        return { direct_url: m[1].replace(/\\u0026/g, '&'), format: 'm3u8', title, thumbnail_url: thumb, platform, headers: {} };
      }
    }

    // [NEW] Snapchat
    if (platform === 'snapchat' && isString) {
      const m = html.match(/"playback_url"\s*:\s*"([^"]+)"/);
      if (m) {
        return { direct_url: m[1], format: 'm3u8', title, thumbnail_url: thumb, platform, headers: {} };
      }
    }

    // Fallback: og:video
    if (isString) {
      const ogVideo = _ogTag(html, 'og:video:url') || _ogTag(html, 'og:video');
      if (ogVideo) {
        const fmt = ogVideo.includes('m3u8') ? 'm3u8' : ogVideo.includes('mpd') ? 'mpd' : 'mp4';
        return { direct_url: ogVideo, format: fmt, title, thumbnail_url: thumb, platform, headers: {} };
      }
    }

    return null;
  } catch (e) {
    logger.warn(`[extractor] direct failed (${platform}): ${e.message?.slice(0, 200)}`);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _findInFormats(formats, ext) {
  if (!formats) return null;
  const f = formats.find(f => f.url && (f.ext === ext || (f.manifest_url && ext === 'm3u8')));
  return f?.url || f?.manifest_url || null;
}

function _ogTag(html, prop) {
  const m = html.match(new RegExp(`property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
         || html.match(new RegExp(`content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'));
  return m?.[1] || null;
}

function _htmlTag(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return m?.[1]?.trim() || null;
}

function _extractJSON(html, varName) {
  const m = html.match(new RegExp(`(?:var |window\\.)?${varName}\\s*=\\s*(\\{.+?\\});`, 's'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

function getPendingCount() {
  return _pendingRequests.size;
}

module.exports = { extractUrl, getPendingCount };
