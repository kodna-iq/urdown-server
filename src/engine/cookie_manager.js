'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// COOKIE MANAGER — v1
//
// يدير ملفات الكوكيز لـ Facebook وInstagram بأسلوب round-robin
// مع آلية تعليم الكوكيز الفاشلة وتخطيها مؤقتاً
//
// هيكل المجلد المتوقع:
//   cookies/
//     fb_1.txt   ← Netscape cookie format
//     fb_2.txt
//     ig_1.txt
//     ig_2.txt
//
// طريقة الاستخدام:
//   const { pickCookie, markCookieFailed } = require('./cookie_manager');
//   const cookiePath = pickCookie('facebook');   // null إذا لا يوجد
//   if (err403) markCookieFailed(cookiePath);
// ═══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── المسار الجذر لمجلد الكوكيز ───────────────────────────────────────────────
const COOKIES_DIR = process.env.COOKIES_DIR
  || path.join(process.cwd(), 'cookies');

// ── فترة الحجب بعد فشل الكوكي (30 دقيقة) ───────────────────────────────────
const BLOCK_DURATION_MS = parseInt(process.env.COOKIE_BLOCK_MS || String(30 * 60 * 1000));

// ── الحالة الداخلية ───────────────────────────────────────────────────────────
// blockedUntil: Map<filePath, timestamp>
// roundRobinIdx: Map<platform, number>

const blockedUntil  = new Map();
const roundRobinIdx = new Map();

// ── prefix map: اسم المنصة → بادئة اسم الملف ─────────────────────────────────
const PLATFORM_PREFIX = {
  facebook:  'fb',
  instagram: 'ig',
  twitter:   'tw',
  tiktok:    'tt',
  youtube:   'yt',
};

// ── تحميل قائمة الملفات لمنصة معيّنة ────────────────────────────────────────

function loadCookieFiles(platform) {
  const prefix = PLATFORM_PREFIX[platform] || platform;
  if (!fs.existsSync(COOKIES_DIR)) return [];

  return fs.readdirSync(COOKIES_DIR)
    .filter(f => f.startsWith(prefix + '_') && f.endsWith('.txt'))
    .map(f => path.join(COOKIES_DIR, f))
    .sort();                                     // ترتيب ثابت: fb_1 قبل fb_2
}

// ── اختيار كوكي بأسلوب Round-Robin مع تخطي المحجوبة ─────────────────────────

function pickCookie(platform) {
  const files = loadCookieFiles(platform);
  if (files.length === 0) return null;

  const now = Date.now();

  // فلترة الملفات غير المحجوبة
  const available = files.filter(f => {
    const until = blockedUntil.get(f) || 0;
    return now > until;
  });

  if (available.length === 0) {
    // كل الكوكيز محجوبة — نُعيد أقدمها انتهاءً (الأقل ضرراً) كـ fallback
    const oldest = files.reduce((a, b) =>
      (blockedUntil.get(a) || 0) < (blockedUntil.get(b) || 0) ? a : b
    );
    console.warn(`[cookie_manager] All ${platform} cookies blocked — forcing ${path.basename(oldest)}`);
    return oldest;
  }

  // Round-robin على المتاحة
  const idx    = (roundRobinIdx.get(platform) || 0) % available.length;
  const chosen = available[idx];
  roundRobinIdx.set(platform, idx + 1);

  console.log(`[cookie_manager] ${platform} → ${path.basename(chosen)} (${available.length}/${files.length} available)`);
  return chosen;
}

// ── تعليم الكوكي على أنها فاشلة ──────────────────────────────────────────────

function markCookieFailed(filePath) {
  if (!filePath) return;
  const until = Date.now() + BLOCK_DURATION_MS;
  blockedUntil.set(filePath, until);
  console.warn(`[cookie_manager] ✗ Cookie blocked: ${path.basename(filePath)} for ${BLOCK_DURATION_MS / 60000} min`);
}

// ── رفع الحجب يدوياً (للـ admin) ─────────────────────────────────────────────

function unblockCookie(filePath) {
  blockedUntil.delete(filePath);
  console.log(`[cookie_manager] ✓ Cookie unblocked: ${path.basename(filePath)}`);
}

// ── حالة الكوكيز (للـ admin dashboard) ───────────────────────────────────────

function getCookieStatus() {
  const now      = Date.now();
  const result   = {};

  for (const [platform] of Object.entries(PLATFORM_PREFIX)) {
    const files = loadCookieFiles(platform);
    if (files.length === 0) continue;

    result[platform] = files.map(f => ({
      file:      path.basename(f),
      blocked:   now < (blockedUntil.get(f) || 0),
      blockedUntil: blockedUntil.get(f) || null,
      minutesLeft: Math.max(0, Math.ceil(((blockedUntil.get(f) || 0) - now) / 60000)),
    }));
  }
  return result;
}

// ── إنشاء مجلد cookies إذا لم يوجد (مع ملف README) ──────────────────────────

function ensureCookiesDir() {
  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });

    const readme = `# مجلد الكوكيز — Cookie Files

ضع هنا ملفات الكوكيز بصيغة Netscape (المدعومة من yt-dlp).

## تسمية الملفات:
  fb_1.txt, fb_2.txt   ← Facebook
  ig_1.txt, ig_2.txt   ← Instagram
  tw_1.txt             ← Twitter/X
  tt_1.txt             ← TikTok
  yt_1.txt             ← YouTube

## كيف تحصل على الكوكيز:
  1. ثبّت إضافة "Get cookies.txt LOCALLY" في Chrome/Firefox
  2. سجّل دخولك للمنصة
  3. صدّر الكوكيز بصيغة Netscape
  4. ضع الملف هنا

## ملاحظة:
  - الملف المحجوب (بعد فشله بـ 403) يُتخطى لمدة 30 دقيقة تلقائياً
  - يمكنك رفع الحجب من /admin/cookies
`;
    fs.writeFileSync(path.join(COOKIES_DIR, 'README.md'), readme, 'utf8');
    console.log(`[cookie_manager] Created cookies dir at: ${COOKIES_DIR}`);
  }
}

// تهيئة تلقائية عند تحميل الوحدة
ensureCookiesDir();

module.exports = {
  pickCookie,
  markCookieFailed,
  unblockCookie,
  getCookieStatus,
  COOKIES_DIR,
};
