'use strict';

require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const { exec }    = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs   = require('fs');

const execAsync = promisify(exec);

// ── Logger ────────────────────────────────────────────────────────────────────
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

// Make logger available to middleware modules before they are loaded
process._urdownLogger = logger;

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.PORT || '3000', 10);
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TMP_DIR   = path.resolve(process.env.TMP_DIR || 'tmp');

const AUTO_UPDATE_INTERVAL_MS = parseInt(
  process.env.AUTO_UPDATE_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10
);

const TMP_MAX_AGE_MS    = parseInt(process.env.TMP_MAX_AGE_MS    || String(10 * 60 * 1000));
const TMP_MAX_SIZE_BYTES = parseInt(process.env.TMP_MAX_SIZE_MB   || '2048') * 1024 * 1024;

// ── Directory bootstrap ───────────────────────────────────────────────────────
['logs', 'data', 'tmp'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Server state ──────────────────────────────────────────────────────────────
const state = {
  ytdlpVersion:  'unknown',
  lastUpdated:   null,
  updateRunning: false,
  startTime:     Date.now(),
  requestCount:  0,
  errorCount:    0,
};

// ── Modules (loaded after directory bootstrap so SQLite file is created) ──────
const { db, stmts }             = require('./db/database');
const { buildStrategy }         = require('./engine/strategy_engine');
const { evaluateRules, analyzeClientPerformance } = require('./engine/rule_engine');
const { processEvent, pruneOldTelemetry }         = require('./engine/telemetry_processor');
const { startCron: startVersionCron }             = require('./engine/version_tracker');
const { validateApiKey, validateAdmin }           = require('./middleware/auth');

// ── Routes ────────────────────────────────────────────────────────────────────
const resolveRouter   = require('./routes/resolve');
const extractRouter   = require('./routes/extract');
const telemetryRouter = require('./routes/telemetry');
const adminRouter     = require('./routes/admin');
const aiRouter        = require('./routes/ai');
const proxyRouter     = require('./routes/proxy');

// Inject db dependency into proxy router
proxyRouter.setDb({ stmts });

// ── tmp cleaner ───────────────────────────────────────────────────────────────
function cleanTmpDir() {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const now   = Date.now();
    let cleaned  = 0;
    let totalSize = 0;

    const fileStats = files.map(f => {
      const fp = path.join(TMP_DIR, f);
      try {
        const st = fs.statSync(fp);
        totalSize += st.size;
        return { fp, mtime: st.mtimeMs, size: st.size };
      } catch { return null; }
    }).filter(Boolean);

    // Delete files older than TMP_MAX_AGE_MS
    for (const { fp, mtime } of fileStats) {
      if (now - mtime > TMP_MAX_AGE_MS) {
        try { fs.unlinkSync(fp); cleaned++; } catch (_) {}
      }
    }

    // If total size still exceeds limit, delete oldest first
    if (totalSize > TMP_MAX_SIZE_BYTES) {
      const sorted = [...fileStats].sort((a, b) => a.mtime - b.mtime);
      let sz = totalSize;
      for (const { fp, size } of sorted) {
        if (sz <= TMP_MAX_SIZE_BYTES) break;
        try { fs.unlinkSync(fp); sz -= size; cleaned++; } catch (_) {}
      }
      // FIX-M4: correct parentheses so we compute (totalSize - sz) before dividing
      logger.warn(`[tmp-clean] disk limit exceeded — freed ${((totalSize - sz) / 1024 / 1024).toFixed(1)}MB`);
    }

    if (cleaned > 0) logger.info(`[tmp-clean] removed ${cleaned} stale file(s)`);
  } catch (e) {
    logger.warn(`[tmp-clean] ${e.message}`);
  }
}

// ── yt-dlp auto-update ────────────────────────────────────────────────────────
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

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));

// FIX-H4: Restrict CORS to configured origins instead of allowing all.
// Set ALLOWED_ORIGINS in .env as a comma-separated list of permitted domains.
// If not set, CORS is disabled (no cross-origin access allowed).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length > 0) {
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (native apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
  }));
  logger.info(`[cors] allowed origins: ${allowedOrigins.join(', ')}`);
} else {
  // No ALLOWED_ORIGINS set — native app only, no browser CORS needed.
  // Still allow requests with no origin header (all native clients).
  logger.info('[cors] no ALLOWED_ORIGINS set — cross-origin browser access disabled');
}

app.use(compression());
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => { state.requestCount++; next(); });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT || '120', 10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests', code: 'rate_limited' },
});
app.use(limiter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
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
      files:  tmpFileCount,
      sizeMB: (tmpSizeBytes / 1024 / 1024).toFixed(2),
      maxMB:  Math.floor(TMP_MAX_SIZE_BYTES / 1024 / 1024),
    },
  });
});

// ── Core routes ───────────────────────────────────────────────────────────────
app.use('/resolve',   resolveRouter);
app.use('/extract',   extractRouter);
app.use('/telemetry', telemetryRouter);
app.use('/admin',     adminRouter);
app.use('/ai',        aiRouter);

// ── Proxy download (extracted to routes/proxy.js) ─────────────────────────────
app.use('/v2/proxy-download', proxyRouter);

// ── Manual yt-dlp update ──────────────────────────────────────────────────────
app.post('/v2/update-ytdlp', validateAdmin, async (_req, res) => {
  logger.info('[update] manual trigger');
  const result = await updateYtDlp(true);
  res.json(result);
});

// ── yt-dlp version info ───────────────────────────────────────────────────────
app.get('/v2/ytdlp-version', (_req, res) => {
  res.json({
    version:       state.ytdlpVersion,
    lastUpdated:   state.lastUpdated,
    updateRunning: state.updateRunning,
  });
});

// ── Remote config (geo-aware stall timings) ───────────────────────────────────
app.get('/v2/remote-config', (req, res) => {
  const cc           = (req.query.cc || '').toUpperCase();
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

// ── 404 / error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error(`[unhandled] ${err.message}`);
  state.errorCount++;
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  logger.info('========================================');
  logger.info(`UrDown Server v${require('../package.json').version} — port ${PORT}`);
  logger.info(`API_SECRET: ${(process.env.API_SECRET || process.env.API_KEY) ? 'set' : 'NOT SET — insecure default active'}`);
  logger.info(`Auto-update: every ${AUTO_UPDATE_INTERVAL_MS / 3_600_000}h`);
  logger.info('========================================');

  await scheduleAutoUpdate();
  startVersionCron();

  // Rule evaluation every 5 minutes
  setInterval(() => {
    try { evaluateRules(); } catch (e) { logger.warn(`[rules] ${e.message}`); }
  }, 5 * 60 * 1000);

  // Client performance analysis every hour
  setInterval(() => {
    try { analyzeClientPerformance(); } catch (e) { logger.warn(`[perf] ${e.message}`); }
  }, 60 * 60 * 1000);

  // Telemetry pruning every 24 hours
  setInterval(() => {
    try { pruneOldTelemetry(); } catch (e) { logger.warn(`[prune] ${e.message}`); }
  }, 24 * 60 * 60 * 1000);

  // tmp cleanup: immediate on start, then every 5 minutes
  cleanTmpDir();
  setInterval(() => {
    try { cleanTmpDir(); } catch (e) { logger.warn(`[tmp-clean] ${e.message}`); }
  }, 5 * 60 * 1000);

  logger.info('All engines started.');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => { logger.info('SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT — shutting down');  process.exit(0); });
process.on('uncaughtException',  err => { logger.error(`Uncaught: ${err.message}`);  state.errorCount++; });
process.on('unhandledRejection', r   => { logger.error(`Unhandled rejection: ${r}`); state.errorCount++; });
