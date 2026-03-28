'use strict';

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');
const { exec, spawn } = require('child_process');
const { promisify }   = require('util');
const path  = require('path');
const fs    = require('fs');

const execAsync = promisify(exec);

// ── Logger ───────────────────────────────────────────────────────────────────
const winston = require('winston');
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}][${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join('logs', 'server.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

// اجعل الـ logger متاحاً للـ middleware قبل تحميله
process._urdownLogger = logger;

// ── الإعدادات ─────────────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.PORT || '3000', 10);
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TMP_DIR   = path.resolve(process.env.TMP_DIR || 'tmp');

const AUTO_UPDATE_INTERVAL_MS = parseInt(
  process.env.AUTO_UPDATE_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10
);

// ── إنشاء المجلدات ────────────────────────────────────────────────────────────
['logs', 'data', 'tmp'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── حالة الخادم ──────────────────────────────────────────────────────────────
const state = {
  ytdlpVersion:  'unknown',
  lastUpdated:   null,
  updateRunning: false,
  startTime:     Date.now(),
  requestCount:  0,
  errorCount:    0,
};

// ── تحميل الـ modules الأصلية ─────────────────────────────────────────────────
// يتم التحميل بعد إنشاء المجلدات لأن database.js ينشئ ملف SQLite فوراً
const { db, stmts }             = require('./db/database');
const { buildStrategy }         = require('./engine/strategy_engine');
const { evaluateRules, analyzeClientPerformance } = require('./engine/rule_engine');
const { processEvent, pruneOldTelemetry }         = require('./engine/telemetry_processor');
const { startCron: startVersionCron, getLatestVersions } = require('./engine/version_tracker');
const { validateApiKey, validateAdmin } = require('./middleware/auth');
const { pickCookie, markCookieFailed }  = require('./engine/cookie_manager');

// ── Routes الأصلية ────────────────────────────────────────────────────────────
const resolveRouter   = require('./routes/resolve');
const extractRouter   = require('./routes/extract');
const telemetryRouter = require('./routes/telemetry');
const adminRouter     = require('./routes/admin');
const aiRouter        = require('./routes/ai');

// ═══════════════════════════════════════════════════════════════════════════════
//  URL Security — حماية من SSRF والروابط المشبوهة
// ═══════════════════════════════════════════════════════════════════════════════

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fd[0-9a-f]{2}:)/i;

function validateUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'url missing' };
  if (url.length > 2048)              return { ok: false, reason: 'url too long' };

  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid url format' }; }

  if (!['http:', 'https:'].includes(parsed.protocol))
    return { ok: false, reason: 'only http/https allowed' };

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(host))
    return { ok: false, reason: 'private/loopback addresses not allowed' };

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  تنظيف ملفات tmp القديمة — يُشغَّل كل 5 دقائق
// ═══════════════════════════════════════════════════════════════════════════════

const TMP_MAX_AGE_MS = parseInt(process.env.TMP_MAX_AGE_MS || String(10 * 60 * 1000)); // 10 دقائق
const TMP_MAX_SIZE_BYTES = parseInt(process.env.TMP_MAX_SIZE_MB || '2048') * 1024 * 1024;

function cleanTmpDir() {
  try {
    const files  = fs.readdirSync(TMP_DIR);
    const now    = Date.now();
    let   cleaned = 0;
    let   totalSize = 0;

    const fileStats = files.map(f => {
      const fp = path.join(TMP_DIR, f);
      try {
        const st = fs.statSync(fp);
        totalSize += st.size;
        return { fp, mtime: st.mtimeMs, size: st.size };
      } catch { return null; }
    }).filter(Boolean);

    // حذف الملفات الأقدم من TMP_MAX_AGE_MS
    for (const { fp, mtime } of fileStats) {
      if (now - mtime > TMP_MAX_AGE_MS) {
        try { fs.unlinkSync(fp); cleaned++; } catch (_) {}
      }
    }

    // إذا تجاوز الحجم الكلي الحد الأقصى، احذف الأقدم أولاً
    if (totalSize > TMP_MAX_SIZE_BYTES) {
      const sorted = fileStats.sort((a, b) => a.mtime - b.mtime);
      let sz = totalSize;
      for (const { fp, size } of sorted) {
        if (sz <= TMP_MAX_SIZE_BYTES) break;
        try { fs.unlinkSync(fp); sz -= size; cleaned++; } catch (_) {}
      }
      logger.warn(`[tmp-clean] disk limit exceeded — freed ${(totalSize - sz / 1024 / 1024).toFixed(1)}MB`);
    }

    if (cleaned > 0) logger.info(`[tmp-clean] removed ${cleaned} stale file(s)`);
  } catch (e) {
    logger.warn(`[tmp-clean] ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  تحديث yt-dlp تلقائياً
// ═══════════════════════════════════════════════════════════════════════════════
async function updateYtDlp(force = false) {
  if (state.updateRunning && !force) {
    logger.warn('[auto-update] already running — skipping');
    return { skipped: true };
  }
  state.updateRunning = true;
  const before = state.ytdlpVersion;
  try {
    logger.info('[auto-update] updating yt-dlp...');
    await execAsync(
      'pip3 install --break-system-packages --upgrade yt-dlp --quiet',
      { timeout: 120_000 }
    );
    const { stdout } = await execAsync(`${YTDLP_BIN} --version`);
    state.ytdlpVersion = stdout.trim();
    state.lastUpdated  = new Date().toISOString();
    logger.info(`[auto-update] ${before} → ${state.ytdlpVersion}`);
    return { updated: true, from: before, to: state.ytdlpVersion };
  } catch (err) {
    logger.error(`[auto-update] failed: ${err.message}`);
    return { updated: false, error: err.message };
  } finally {
    state.updateRunning = false;
  }
}

async function scheduleAutoUpdate() {
  try {
    const { stdout } = await execAsync(`${YTDLP_BIN} --version`);
    state.ytdlpVersion = stdout.trim();
    state.lastUpdated  = new Date().toISOString();
    logger.info(`[init] yt-dlp: ${state.ytdlpVersion}`);
  } catch (e) {
    logger.warn(`[init] yt-dlp version check failed: ${e.message}`);
  }

  setInterval(async () => {
    logger.info('[auto-update] scheduled trigger');
    await updateYtDlp();
  }, AUTO_UPDATE_INTERVAL_MS);

  logger.info(`[auto-update] every ${AUTO_UPDATE_INTERVAL_MS / 3_600_000}h`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  proxy-download: الخادم يحمّل الفيديو ويُعيده للتطبيق مباشرة
//  يُستخدم لـ TikTok وInstagram المحجوبة جغرافياً من العراق
// ═══════════════════════════════════════════════════════════════════════════════
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

function runYtDlp(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`yt-dlp timeout after ${timeoutMs}ms`)); }, timeoutMs);
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

async function proxyDownload(url, platform, format, res) {
  const tmpFile = path.join(TMP_DIR, `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const platformArgs = buildPlatformArgs(url, platform);

  // ── FIX: دمج Cookie Manager ───────────────────────────────────────────────
  // تحقق من إعداد use_cookies للمنصة ثم اختر كوكي متاح
  let activeCookiePath = null;
  const platformCfg = stmts.getConfig.get(platform) || stmts.getConfig.get('generic');
  if (platformCfg && platformCfg.use_cookies) {
    activeCookiePath = pickCookie(platform);
    if (activeCookiePath) {
      platformArgs.push('--cookies', activeCookiePath);
      logger.info(`[proxy-download] using cookie: ${path.basename(activeCookiePath)}`);
    }
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
    const ext  = path.extname(files[0]).toLowerCase().replace('.', '');
    const mime = ext === 'mp4' ? 'video/mp4' : ext === 'm4a' ? 'audio/mp4' : ext === 'webm' ? 'video/webm' : 'application/octet-stream';
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(filePath); } catch (_) {} });
  } catch (err) {
    // ── FIX: تعليم الكوكي على أنها فاشلة عند 403 ────────────────────────────
    const is403 = /403|forbidden/i.test(err.message);
    if (is403 && activeCookiePath) {
      markCookieFailed(activeCookiePath);
      logger.warn(`[proxy-download] 403 detected — cookie marked failed: ${path.basename(activeCookiePath)}`);
    }

    try {
      fs.readdirSync(TMP_DIR)
        .filter(f => f.startsWith(path.basename(tmpFile)))
        .forEach(f => fs.unlinkSync(path.join(TMP_DIR, f)));
    } catch (_) {}
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Express App
// ═══════════════════════════════════════════════════════════════════════════════
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => { state.requestCount++; next(); });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT || '120', 10),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests', code: 'rate_limited' },
});
app.use(limiter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  // احسب حجم tmp الحالي
  let tmpSizeBytes = 0;
  let tmpFileCount = 0;
  try {
    const files = fs.readdirSync(TMP_DIR);
    tmpFileCount = files.length;
    for (const f of files) {
      try { tmpSizeBytes += fs.statSync(path.join(TMP_DIR, f)).size; } catch (_) {}
    }
  } catch (_) {}

  res.json({
    status:      'ok',
    uptime:      Math.floor((Date.now() - state.startTime) / 1000),
    ytdlp:       state.ytdlpVersion,
    lastUpdated: state.lastUpdated,
    requests:    state.requestCount,
    errors:      state.errorCount,
    version:     require('../package.json').version,
    tmp: {
      files:   tmpFileCount,
      sizeMB:  (tmpSizeBytes / 1024 / 1024).toFixed(2),
      maxMB:   Math.floor(TMP_MAX_SIZE_BYTES / 1024 / 1024),
    },
  });
});

// ── Routes الأصلية (تعمل كما هي) ─────────────────────────────────────────────
app.use('/resolve',   resolveRouter);    // POST /resolve  — strategy engine
app.use('/extract',   extractRouter);    // POST /extract  — server-side extraction
app.use('/telemetry', telemetryRouter);  // POST /telemetry — collect events
app.use('/admin',     adminRouter);      // GET/PUT /admin/* — management
app.use('/ai',        aiRouter);         // GET /ai/advisor — AI analysis

// ── /v2/proxy-download ────────────────────────────────────────────────────────
// التطبيق يطلب هذا عندما يكون المحتوى محجوباً في منطقته
app.post('/v2/proxy-download', validateApiKey, async (req, res) => {
  const { url, platform, format } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  // ── FIX: SSRF + URL validation ────────────────────────────────────────────
  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) {
    logger.warn(`[proxy-download] rejected url: ${urlCheck.reason} — ${url.slice(0, 80)}`);
    return res.status(400).json({ error: urlCheck.reason, code: 'invalid_url' });
  }

  logger.info(`[proxy-download] ${platform || 'generic'} ${url.slice(0, 80)}`);
  try {
    await proxyDownload(url, platform || 'generic', format || 'video', res);
  } catch (err) {
    state.errorCount++;
    logger.error(`[proxy-download] failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── /v2/update-ytdlp — تحديث يدوي فوري ─────────────────────────────────────
app.post('/v2/update-ytdlp', validateAdmin, async (req, res) => {
  logger.info('[update] manual trigger');
  const result = await updateYtDlp(true);
  res.json(result);
});

// ── /v2/ytdlp-version ────────────────────────────────────────────────────────
app.get('/v2/ytdlp-version', (req, res) => {
  res.json({ version: state.ytdlpVersion, lastUpdated: state.lastUpdated, updateRunning: state.updateRunning });
});

// ── /v2/remote-config — إعدادات مخصصة حسب البلد ────────────────────────────
app.get('/v2/remote-config', (req, res) => {
  const cc = (req.query.cc || '').toUpperCase();
  const isRestricted = ['IQ', 'IR', 'SY', 'YE', 'LY', 'DZ', 'SA'].includes(cc);

  const base = {
    tiktok:    { grace: isRestricted ? 88000 : 55000, threshold: isRestricted ? 35200 : 22000, proxy: false, fragments: 2, fmt: 'bv*+ba/b' },
    instagram: { grace: isRestricted ? 48000 : 30000, threshold: 24000, proxy: isRestricted, fragments: 4 },
    youtube:   { grace: 30000, threshold: 20000, proxy: false, fragments: 4 },
    facebook:  { grace: isRestricted ? 40000 : 25000, threshold: isRestricted ? 24000 : 15000, proxy: false, fragments: 4 },
    twitter:   { grace: isRestricted ? 32000 : 20000, threshold: 24000, proxy: false, fragments: 4 },
  };

  res.json({ cc: cc || 'unknown', config: base, ytdlp: state.ytdlpVersion, serverTs: Date.now() });
});

// ── 404 + Error handler ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use((err, req, res, next) => {
  logger.error(`[unhandled] ${err.message}`);
  state.errorCount++;
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  تشغيل الخادم
// ═══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', async () => {
  logger.info(`========================================`);
  logger.info(`UrDown Server v${require('../package.json').version} — port ${PORT}`);
  logger.info(`API_KEY: ${process.env.API_SECRET ? 'set' : 'NOT SET — open access'}`);
  logger.info(`Auto-update: every ${AUTO_UPDATE_INTERVAL_MS / 3_600_000}h`);
  logger.info(`========================================`);

  // تشغيل كل الـ engines
  await scheduleAutoUpdate();
  startVersionCron();

  // تقييم القواعد كل 5 دقائق
  setInterval(() => {
    try { evaluateRules(); } catch (e) { logger.warn(`[rules] ${e.message}`); }
  }, 5 * 60 * 1000);

  // تحليل أداء الكلاينتات كل ساعة
  setInterval(() => {
    try { analyzeClientPerformance(); } catch (e) { logger.warn(`[perf] ${e.message}`); }
  }, 60 * 60 * 1000);

  // تنظيف التيليمتري القديمة كل 24 ساعة
  setInterval(() => {
    try { pruneOldTelemetry(); } catch (e) { logger.warn(`[prune] ${e.message}`); }
  }, 24 * 60 * 60 * 1000);

  // ── FIX: تنظيف tmp كل 5 دقائق لمنع تراكم الملفات المتسربة ─────────────
  cleanTmpDir(); // تنظيف فوري عند بدء التشغيل
  setInterval(() => {
    try { cleanTmpDir(); } catch (e) { logger.warn(`[tmp-clean] ${e.message}`); }
  }, 5 * 60 * 1000);

  logger.info('All engines started.');
});

// Graceful shutdown
process.on('SIGTERM', () => { logger.info('SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT — shutting down');  process.exit(0); });
process.on('uncaughtException',  err => { logger.error(`Uncaught: ${err.message}`);   state.errorCount++; });
process.on('unhandledRejection', r   => { logger.error(`Unhandled rejection: ${r}`);  state.errorCount++; });
