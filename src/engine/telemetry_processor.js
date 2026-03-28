'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY PROCESSOR
// Receives success/failure events from apps.
// Maintains rolling spike counters per platform.
// Triggers auto-heal when thresholds are exceeded.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { stmts } = require('../db/database');
const { applyConfigPatch } = require('./strategy_engine');
const logger = require('../middleware/logger');

const WINDOW_SECS   = parseInt(process.env.SPIKE_WINDOW_MINUTES || '5') * 60;
const THRESH_403    = parseInt(process.env.SPIKE_403_THRESHOLD  || '10');
const THRESH_NOFORM = parseInt(process.env.SPIKE_NOFORMAT_THRESHOLD || '8');

// ── Error type classifier (mirrors Dart classifyFailure) ──────────────────────

function classifyError(errorType, errorRaw) {
  if (!errorType && !errorRaw) return 'unknown';
  const combined = `${errorType || ''} ${errorRaw || ''}`.toLowerCase();
  if (combined.includes('403') || combined.includes('forbidden') || combined.includes('sabr'))
    return 'forbidden';
  if (combined.includes('no_formats') || combined.includes('no formats') ||
      combined.includes('requested format'))
    return 'no_formats';
  if (combined.includes('timeout') || combined.includes('timed out'))
    return 'timeout';
  if (combined.includes('sign in') || combined.includes('login required'))
    return 'auth';
  if (combined.includes('network') || combined.includes('connection'))
    return 'network';
  if (combined.includes('extractor') || combined.includes('unsupported'))
    return 'extractor';
  return errorType || 'unknown';
}

// ── URL hash — never store raw URLs ──────────────────────────────────────────

function hashUrl(url) {
  if (!url) return 'none';
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

// ── Process incoming telemetry event ─────────────────────────────────────────

function processEvent(event) {
  const {
    event_id, platform, url, success,
    client_used, format_used, error_type,
    error_raw, elapsed_ms, app_version, device,
  } = event;

  const normalizedError = classifyError(error_type, error_raw);

  // Store (dedup by event_id)
  try {
    stmts.insertTelemetry.run({
      event_id:   event_id,
      platform:   platform || 'generic',
      url_hash:   hashUrl(url),
      success:    success ? 1 : 0,
      client_used: client_used || null,
      format_used: format_used || null,
      error_type:  normalizedError,
      error_raw:   !success ? (error_raw || '').slice(0, 500) : null,
      elapsed_ms:  elapsed_ms || null,
      app_version: app_version || null,
      device:      device || null,
    });
  } catch (e) {
    // Duplicate event_id — silently ignore
    if (!e.message.includes('UNIQUE')) logger.warn(`[telemetry] insert error: ${e.message}`);
    return;
  }

  if (!success) {
    _trackSpike(platform, normalizedError);
  }
}

// ── Spike tracking + auto-heal ────────────────────────────────────────────────

function _trackSpike(platform, errorType) {
  try {
    stmts.upsertSpike.run({
      platform,
      error_type:  errorType,
      window_start: Math.floor(Date.now() / 1000),
      window_secs:  WINDOW_SECS,
    });

    const row = stmts.getSpikeCount.get(platform, errorType);
    const count = row?.count || 0;

    if (errorType === 'forbidden' && count === THRESH_403) {
      logger.error(`[telemetry] 🚨 SPIKE: ${platform} 403 × ${count} — auto-healing`);
      _autoHeal(platform, 'forbidden');
    }
    if (errorType === 'no_formats' && count === THRESH_NOFORM) {
      logger.error(`[telemetry] 🚨 SPIKE: ${platform} no_formats × ${count} — auto-healing`);
      _autoHeal(platform, 'no_formats');
    }
  } catch (e) {
    logger.warn(`[telemetry] spike tracking error: ${e.message}`);
  }
}

// ── Auto-heal: patch config when spike detected ───────────────────────────────

function _autoHeal(platform, spikeType) {
  try {
    if (platform === 'youtube') {
      if (spikeType === 'forbidden') {
        // Demote android, promote ios to primary
        applyConfigPatch('youtube', {
          clients:  ['ios'],
          fallback: ['android_vr', 'web_safari', 'web'],
          force_hls: false,
        });
        logger.warn('[auto-heal] youtube: demoted android → ios primary');
      }
      if (spikeType === 'no_formats') {
        // Force HLS across all clients
        applyConfigPatch('youtube', { force_hls: true });
        logger.warn('[auto-heal] youtube: forced HLS globally');
      }
    }
    // Generic platform heal: force HLS
    if (platform !== 'youtube') {
      applyConfigPatch(platform.replace('_live', '') === platform ? platform : platform, {
        force_hls: true,
      });
      logger.warn(`[auto-heal] ${platform}: force_hls=true`);
    }
  } catch (e) {
    logger.error(`[auto-heal] failed: ${e.message}`);
  }
}

// ── Pruning cron ──────────────────────────────────────────────────────────────

function pruneOldTelemetry() {
  const days = parseInt(process.env.TELEMETRY_RETENTION_DAYS || '30');
  const result = stmts.pruneTelemetry.run({ days });
  if (result.changes > 0) logger.info(`[telemetry] pruned ${result.changes} old rows`);
}

module.exports = { processEvent, pruneOldTelemetry };
