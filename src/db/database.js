'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// DATABASE LAYER — PRODUCTION FIXED
//
// FIXES APPLIED:
//
// FIX-DB1  tiktok_live seed: --downloader-args format corrected
//          (was single string, now separate args per yt-dlp requirement)
//          Added -copyts flag for timestamp preservation
// FIX-DB2  Added facebook_live platform config (was missing entirely)
// FIX-DB3  Added instagram_live platform config (was missing)
// FIX-DB4  tiktok_live output forced to .ts via --output template logic
// FIX-DB5  Added youtube_live platform config
// ─────────────────────────────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './data/urdown.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS platform_configs (
    platform        TEXT PRIMARY KEY,
    clients         TEXT NOT NULL,
    fallback        TEXT NOT NULL,
    format_priority TEXT NOT NULL,
    flags           TEXT NOT NULL,
    force_hls       INTEGER NOT NULL DEFAULT 0,
    use_cookies     INTEGER NOT NULL DEFAULT 0,
    extra            TEXT,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT UNIQUE NOT NULL,
    platform      TEXT NOT NULL,
    url_hash      TEXT NOT NULL,
    success       INTEGER NOT NULL,
    client_used   TEXT,
    format_used   TEXT,
    error_type    TEXT,
    error_raw     TEXT,
    elapsed_ms    INTEGER,
    app_version   TEXT,
    device        TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_telemetry_platform_time
    ON telemetry(platform, created_at);

  CREATE TABLE IF NOT EXISTS error_spikes (
    platform   TEXT NOT NULL,
    error_type TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL,
    PRIMARY KEY (platform, error_type)
  );

  CREATE TABLE IF NOT EXISTS ytdlp_versions (
    channel     TEXT PRIMARY KEY,
    version     TEXT NOT NULL,
    checked_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ── Seed default configs ───────────────────────────────────────────────────────

const seedConfigs = [
  {
    platform: 'youtube',
    clients:  JSON.stringify(['android', 'ios']),
    fallback: JSON.stringify(['android_vr', 'web_safari', 'web']),
    format_priority: JSON.stringify(['dash', 'hls']),
    flags: JSON.stringify([
      '--socket-timeout', '10',
      '--concurrent-fragments', '8',
      '--buffer-size', '16M',
      '--http-chunk-size', '10M',
      '--retries', '5',
      '--fragment-retries', '5',
    ]),
    force_hls:   0,
    use_cookies: 0,
    extra: null,
  },
  {
    platform: 'youtube_live',
    clients:  JSON.stringify(['ios', 'android']),
    fallback: JSON.stringify(['web_safari', 'web']),
    format_priority: JSON.stringify(['hls']),
    flags: JSON.stringify([
      '--hls-use-mpegts',
      '--downloader',      'ffmpeg',
      '--downloader-args', 'ffmpeg_i:-fflags',
      '--downloader-args', 'ffmpeg_i:+genpts+discardcorrupt',
      '--downloader-args', 'ffmpeg_i:-avoid_negative_ts',
      '--downloader-args', 'ffmpeg_i:make_zero',
      '--downloader-args', 'ffmpeg_i:-copyts',
      '--no-part',
      '--socket-timeout', '30',
      '--retries', '10',
      '--fragment-retries', '10',
    ]),
    force_hls:   1,
    use_cookies: 0,
    extra: JSON.stringify({ remux_ts_to_mp4: true }),
  },
  {
    platform: 'tiktok',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'hls']),
    flags: JSON.stringify([
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--socket-timeout', '30',
      '--no-playlist',
      '--format', 'bv*+ba/b',
    ]),
    force_hls:   0,
    use_cookies: 0,
    extra: null,
  },
  {
    // FIX-DB1: corrected --downloader-args format + added -copyts
    platform: 'tiktok_live',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['hls']),
    flags: JSON.stringify([
      '--hls-use-mpegts',
      '--downloader',      'ffmpeg',
      // FIX-DB1: each ffmpeg flag passed as SEPARATE --downloader-args entry
      // Previous single-string format was silently ignored by yt-dlp
      '--downloader-args', 'ffmpeg_i:-fflags',
      '--downloader-args', 'ffmpeg_i:+genpts+discardcorrupt',
      '--downloader-args', 'ffmpeg_i:-avoid_negative_ts',
      '--downloader-args', 'ffmpeg_i:make_zero',
      '--downloader-args', 'ffmpeg_i:-copyts',   // FIX: timestamp preservation
      '--format',          'best',
      '--no-part',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Referer:https://www.tiktok.com/',
      '--socket-timeout',   '30',
      '--retries',          '10',
      '--fragment-retries', '10',
      '--skip-unavailable-fragments',
    ]),
    force_hls:   1,
    use_cookies: 0,
    extra: JSON.stringify({ remux_ts_to_mp4: true, output_ext: 'ts' }),
  },
  {
    platform: 'facebook',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'dash', 'hls']),
    flags: JSON.stringify(['--socket-timeout', '20', '--no-playlist']),
    force_hls:   0,
    use_cookies: 1,
    extra: null,
  },
  {
    // FIX-DB2: facebook_live was completely missing
    platform: 'facebook_live',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['hls']),
    flags: JSON.stringify([
      '--hls-use-mpegts',
      '--downloader',      'ffmpeg',
      '--downloader-args', 'ffmpeg_i:-fflags',
      '--downloader-args', 'ffmpeg_i:+genpts+discardcorrupt',
      '--downloader-args', 'ffmpeg_i:-avoid_negative_ts',
      '--downloader-args', 'ffmpeg_i:make_zero',
      '--downloader-args', 'ffmpeg_i:-copyts',
      '--format',          'best',
      '--no-part',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Referer:https://www.facebook.com/',
      '--socket-timeout',   '30',
      '--retries',          '10',
      '--fragment-retries', '10',
      '--skip-unavailable-fragments',
    ]),
    force_hls:   1,
    use_cookies: 1,
    extra: JSON.stringify({ remux_ts_to_mp4: true, output_ext: 'ts' }),
  },
  {
    platform: 'instagram',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'hls']),
    flags: JSON.stringify([
      '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      '--socket-timeout', '20',
      '--no-playlist',
    ]),
    force_hls:   0,
    use_cookies: 1,
    extra: null,
  },
  {
    // FIX-DB3: instagram_live was completely missing
    platform: 'instagram_live',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['hls']),
    flags: JSON.stringify([
      '--hls-use-mpegts',
      '--downloader',      'ffmpeg',
      '--downloader-args', 'ffmpeg_i:-fflags',
      '--downloader-args', 'ffmpeg_i:+genpts+discardcorrupt',
      '--downloader-args', 'ffmpeg_i:-avoid_negative_ts',
      '--downloader-args', 'ffmpeg_i:make_zero',
      '--downloader-args', 'ffmpeg_i:-copyts',
      '--format',          'best',
      '--no-part',
      '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
      '--add-header', 'Referer:https://www.instagram.com/',
      '--socket-timeout',   '30',
      '--retries',          '10',
      '--fragment-retries', '10',
    ]),
    force_hls:   1,
    use_cookies: 1,
    extra: JSON.stringify({ remux_ts_to_mp4: true, output_ext: 'ts' }),
  },
  // ── [NEW] Reddit ───────────────────────────────────────────────────────────
  {
    platform: 'reddit',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'hls']),
    flags: JSON.stringify(['--socket-timeout', '20', '--merge-output-format', 'mp4']),
    force_hls:   0,
    use_cookies: 0,
    extra: null,
  },
  // ── [NEW] Vimeo ────────────────────────────────────────────────────────────
  {
    platform: 'vimeo',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'hls']),
    flags: JSON.stringify(['--socket-timeout', '20']),
    force_hls:   0,
    use_cookies: 0,
    extra: null,
  },
  // ── [NEW] Dailymotion ──────────────────────────────────────────────────────
  {
    platform: 'dailymotion',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['hls', 'mp4']),
    flags: JSON.stringify(['--socket-timeout', '20']),
    force_hls:   1,
    use_cookies: 0,
    extra: null,
  },
  // ── [NEW] Snapchat Spotlight ───────────────────────────────────────────────
  {
    platform: 'snapchat',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['hls', 'mp4']),
    flags: JSON.stringify(['--socket-timeout', '20']),
    force_hls:   1,
    use_cookies: 0,
    extra: null,
  },
  // ── [NEW] Threads ──────────────────────────────────────────────────────────
  {
    platform: 'threads',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'hls']),
    flags: JSON.stringify(['--socket-timeout', '20']),
    force_hls:   0,
    use_cookies: 1,
    extra: null,
  },
  // ── Generic (fallback) ─────────────────────────────────────────────────────
  {
    platform: 'generic',
    clients:  JSON.stringify([]),
    fallback: JSON.stringify([]),
    format_priority: JSON.stringify(['mp4', 'hls']),
    flags: JSON.stringify(['--socket-timeout', '20']),
    force_hls:   0,
    use_cookies: 0,
    extra: null,
  },
];

const insertConfig = db.prepare(`
  INSERT OR IGNORE INTO platform_configs
    (platform, clients, fallback, format_priority, flags, force_hls, use_cookies, extra)
  VALUES
    (@platform, @clients, @fallback, @format_priority, @flags, @force_hls, @use_cookies, @extra)
`);

db.transaction(() => { for (const c of seedConfigs) insertConfig.run(c); })();

// ── Prepared statements ───────────────────────────────────────────────────────

const stmts = {
  getConfig: db.prepare('SELECT * FROM platform_configs WHERE platform = ?'),
  updateConfig: db.prepare(`
    UPDATE platform_configs SET
      clients = @clients, fallback = @fallback,
      format_priority = @format_priority, flags = @flags,
      force_hls = @force_hls, use_cookies = @use_cookies,
      extra = @extra, updated_at = unixepoch()
    WHERE platform = @platform
  `),
  insertTelemetry: db.prepare(`
    INSERT OR IGNORE INTO telemetry
      (event_id, platform, url_hash, success, client_used, format_used,
       error_type, error_raw, elapsed_ms, app_version, device)
    VALUES
      (@event_id, @platform, @url_hash, @success, @client_used, @format_used,
       @error_type, @error_raw, @elapsed_ms, @app_version, @device)
  `),
  getSpike: db.prepare('SELECT * FROM error_spikes WHERE platform = ? AND error_type = ?'),
  upsertSpike: db.prepare(`
    INSERT INTO error_spikes (platform, error_type, count, window_start)
    VALUES (@platform, @error_type, 1, @window_start)
    ON CONFLICT(platform, error_type) DO UPDATE SET
      count = CASE
        WHEN (unixepoch() - window_start) > @window_secs THEN 1
        ELSE count + 1
      END,
      window_start = CASE
        WHEN (unixepoch() - window_start) > @window_secs THEN unixepoch()
        ELSE window_start
      END
  `),
  getSpikeCount: db.prepare(
    'SELECT count FROM error_spikes WHERE platform = ? AND error_type = ?'
  ),
  setVersion: db.prepare(`
    INSERT INTO ytdlp_versions (channel, version, checked_at)
    VALUES (@channel, @version, unixepoch())
    ON CONFLICT(channel) DO UPDATE SET version = @version, checked_at = unixepoch()
  `),
  getVersion: db.prepare('SELECT version FROM ytdlp_versions WHERE channel = ?'),
  pruneTelemetry: db.prepare(
    'DELETE FROM telemetry WHERE created_at < unixepoch() - (@days * 86400)'
  ),
  platformStats: db.prepare(`
    SELECT
      success,
      COUNT(*) as cnt,
      AVG(elapsed_ms) as avg_ms,
      error_type
    FROM telemetry
    WHERE platform = ? AND created_at > unixepoch() - 3600
    GROUP BY success, error_type
  `),
};

module.exports = { db, stmts };
