#!/bin/sh
set -e

LOG_PREFIX="[entrypoint]"

log() { echo "$LOG_PREFIX $1"; }

log "========================================="
log "UrDown Server v2 — starting"
log "========================================="

# ── تحديث yt-dlp عند كل تشغيل ──────────────────────────────────────────
log "Checking yt-dlp version..."
CURRENT=$(yt-dlp --version 2>/dev/null || echo "not-installed")
log "Current yt-dlp: $CURRENT"

log "Updating yt-dlp..."
if pip3 install --break-system-packages --upgrade yt-dlp --quiet 2>/dev/null; then
  NEW=$(yt-dlp --version 2>/dev/null || echo "unknown")
  log "yt-dlp updated: $CURRENT → $NEW"
else
  log "WARNING: yt-dlp update failed — continuing with: $CURRENT"
fi

# ── التحقق من ffmpeg ────────────────────────────────────────────────────
if command -v ffmpeg >/dev/null 2>&1; then
  log "ffmpeg: $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f1-3)"
else
  log "WARNING: ffmpeg not found"
fi

# ── إنشاء المجلدات المطلوبة ──────────────────────────────────────────────
mkdir -p data logs tmp
log "Directories ready: data/ logs/ tmp/"

# ── التحقق من ملف .env ──────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    log "Created .env from .env.example"
  else
    log "WARNING: No .env file found"
  fi
fi

log "Starting Node.js server..."
log "========================================="

exec node src/index.js
