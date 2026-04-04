'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// SMART MONITOR — نظام المراقبة الذكية
//
// يراقب الكوكيز والأخطاء كل 30 دقيقة.
// عند اكتشاف مشكلة → يحلل بـ Claude AI → يرسل إيميل تفصيلي.
//
// متغيرات البيئة المطلوبة:
//   ALERT_EMAIL          = your@gmail.com       ← بريدك
//   GMAIL_USER           = sender@gmail.com     ← Gmail المُرسِل
//   GMAIL_APP_PASSWORD   = xxxx xxxx xxxx xxxx  ← App Password من Gmail
//   ANTHROPIC_API_KEY    = sk-ant-...           ← موجود بالفعل
//   MONITOR_INTERVAL_MIN = 30                   ← اختياري (افتراضي 30)
// ═══════════════════════════════════════════════════════════════════════════════

const https = require('https');
const Anthropic  = require('@anthropic-ai/sdk');
const path       = require('path');
const fs         = require('fs');
const { db }     = require('../db/database');
const { getCookieStatus, COOKIES_DIR } = require('./cookie_store');
const logger     = require('../middleware/logger');

const INTERVAL_MS  = parseInt(process.env.MONITOR_INTERVAL_MIN || '30') * 60 * 1000;
const ALERT_EMAIL  = process.env.ALERT_EMAIL  || '';

// منع إرسال نفس التنبيه خلال ساعة
const _recentAlerts = new Map(); // key → timestamp

// ── إرسال الإيميل عبر Resend API (HTTP — يعمل على Render المجاني) ─────────────

async function sendAlert({ subject, html }) {
  if (!ALERT_EMAIL) {
    logger.warn('[monitor] ALERT_EMAIL غير مضبوط — تخطي الإيميل');
    return false;
  }

  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  if (!RESEND_KEY) {
    logger.warn('[monitor] RESEND_API_KEY غير مضبوط — تخطي الإيميل');
    return false;
  }

  const body = JSON.stringify({
    from:    'UrDown Monitor <onboarding@resend.dev>',
    to:      [ALERT_EMAIL],
    subject,
    html,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info(`[monitor] ✅ إيميل أُرسل عبر Resend: ${subject}`);
          resolve(true);
        } else {
          logger.error(`[monitor] Resend خطأ ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      logger.error(`[monitor] Resend فشل الاتصال: ${e.message}`);
      resolve(false);
    });

    req.setTimeout(15_000, () => {
      req.destroy();
      logger.error('[monitor] Resend timeout');
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}
// ── جمع بيانات الكوكيز ───────────────────────────────────────────────────────

function collectCookieData() {
  const status    = getCookieStatus();
  const problems  = [];
  const healthy   = [];

  for (const [platform, cookies] of Object.entries(status)) {
    const allBlocked  = cookies.every(c => c.blocked);
    const someBlocked = cookies.some(c => c.blocked);
    const total       = cookies.length;
    const available   = cookies.filter(c => !c.blocked).length;

    if (total === 0) continue;

    if (allBlocked) {
      problems.push({ platform, severity: 'critical', total, available: 0,
        msg: `جميع الكوكيز محجوبة (${total}/${total})` });
    } else if (someBlocked) {
      problems.push({ platform, severity: 'warning', total, available,
        msg: `${available}/${total} متاح` });
    } else {
      healthy.push({ platform, total, available });
    }
  }

  return { problems, healthy };
}

// ── جمع إحصائيات التيليمتري ──────────────────────────────────────────────────

function collectTelemetryStats(windowHours = 6) {
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;
  try {
    return db.prepare(`
      SELECT platform,
        COUNT(*) AS total,
        SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures,
        GROUP_CONCAT(DISTINCT error_type) AS error_types,
        ROUND(AVG(elapsed_ms)) AS avg_ms
      FROM telemetry
      WHERE created_at >= ?
      GROUP BY platform ORDER BY failures DESC
    `).all(since);
  } catch (_) { return []; }
}

// ── تحليل Claude AI ───────────────────────────────────────────────────────────

async function analyzeWithClaude(cookieData, telemetryStats) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length < 10) return 'تحليل AI غير متاح — أضف ANTHROPIC_API_KEY';

  const client = new Anthropic({ apiKey });

  const cookieText = cookieData.problems.length === 0
    ? 'لا توجد مشاكل في الكوكيز.'
    : cookieData.problems.map(p =>
        `- ${p.platform}: ${p.msg} (خطورة: ${p.severity})`
      ).join('\n');

  const statsText = telemetryStats.length === 0
    ? 'لا توجد بيانات تيليمتري.'
    : telemetryStats.map(r => {
        const rate = r.total > 0 ? ((r.successes / r.total) * 100).toFixed(1) : '0';
        return `- ${r.platform}: ${r.total} طلب، نجاح ${rate}%، أخطاء=[${r.error_types || 'لا يوجد'}]`;
      }).join('\n');

  const prompt = `أنت نظام مراقبة ذكي لسيرفر تحميل فيديو (UrDown) يعمل في العراق.

مشاكل الكوكيز المكتشفة:
${cookieText}

إحصائيات آخر 6 ساعات:
${statsText}

السياق: المستخدمون في العراق — TikTok وInstagram محجوبان جزئياً.
الكوكيز تنتهي بسبب: تغيير IP، سياسات المنصة، كثرة الاستخدام.

اكتب تحليلاً موجزاً بالعربية:
1. السبب الأرجح للمشكلة
2. مدى الخطورة (عاجل / متوسط / طبيعي)
3. الإجراء المطلوب منك كمسؤول
لا تزيد عن 5 أسطر.`;

  try {
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });
    return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  } catch (e) {
    return `تعذّر التحليل: ${e.message}`;
  }
}

// ── بناء HTML الإيميل ─────────────────────────────────────────────────────────

function buildEmailHtml({ cookieData, telemetryStats, aiAnalysis, alertType }) {
  const now     = new Date().toLocaleString('ar-EG', { timeZone: 'Asia/Baghdad' });
  const isUrgent = cookieData.problems.some(p => p.severity === 'critical');

  const headerColor = isUrgent ? '#DC2626' : '#D97706';
  const headerIcon  = isUrgent ? '🔴' : '🟡';
  const headerText  = isUrgent ? 'تنبيه عاجل' : 'تحذير';

  // صفوف الكوكيز
  const cookieRows = cookieData.problems.map(p => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">
        <strong>${p.platform}</strong>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:${p.severity === 'critical' ? '#DC2626' : '#D97706'}">
        ${p.msg}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">
        ${p.severity === 'critical' ? '🔴 حرج' : '🟡 تحذير'}
      </td>
    </tr>`).join('');

  const healthyRows = cookieData.healthy.map(h => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${h.platform}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#16A34A">
        ${h.available}/${h.total} متاح ✓
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">🟢 جيد</td>
    </tr>`).join('');

  // إحصائيات التيليمتري
  const statsRows = telemetryStats.map(r => {
    const rate  = r.total > 0 ? ((r.successes / r.total) * 100).toFixed(1) : '0';
    const color = parseFloat(rate) >= 90 ? '#16A34A' : parseFloat(rate) >= 70 ? '#D97706' : '#DC2626';
    return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${r.platform}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${r.total}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:${color};font-weight:bold">
        ${rate}%
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#DC2626;font-size:12px">
        ${r.error_types || '—'}
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:rtl">
  <div style="max-width:600px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">

    <!-- Header -->
    <div style="background:${headerColor};padding:24px;text-align:center">
      <div style="font-size:36px">${headerIcon}</div>
      <h1 style="color:#fff;margin:8px 0;font-size:22px">UrDown Monitor — ${headerText}</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:13px">${now}</p>
    </div>

    <!-- AI Analysis -->
    <div style="padding:20px;background:#FFFBEB;border-bottom:1px solid #FDE68A">
      <div style="font-size:13px;color:#92400E;margin-bottom:6px;font-weight:bold">
        🤖 تحليل Claude AI
      </div>
      <div style="font-size:14px;color:#78350F;line-height:1.7;white-space:pre-line">
        ${aiAnalysis}
      </div>
    </div>

    <!-- Cookie Status -->
    <div style="padding:20px">
      <h2 style="font-size:16px;margin:0 0 12px;color:#111">🍪 حالة الكوكيز</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f9f9f9">
            <th style="padding:8px 12px;text-align:right;color:#666">المنصة</th>
            <th style="padding:8px 12px;text-align:right;color:#666">الحالة</th>
            <th style="padding:8px 12px;text-align:right;color:#666">الخطورة</th>
          </tr>
        </thead>
        <tbody>
          ${cookieRows}
          ${healthyRows}
          ${cookieRows === '' && healthyRows === '' ? '<tr><td colspan="3" style="padding:12px;text-align:center;color:#888">لا توجد كوكيز مُضافة</td></tr>' : ''}
        </tbody>
      </table>
    </div>

    <!-- Telemetry Stats -->
    ${telemetryStats.length > 0 ? `
    <div style="padding:0 20px 20px">
      <h2 style="font-size:16px;margin:0 0 12px;color:#111">📊 إحصائيات آخر 6 ساعات</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f9f9f9">
            <th style="padding:8px 12px;text-align:right;color:#666">المنصة</th>
            <th style="padding:8px 12px;text-align:right;color:#666">الطلبات</th>
            <th style="padding:8px 12px;text-align:right;color:#666">النجاح</th>
            <th style="padding:8px 12px;text-align:right;color:#666">الأخطاء</th>
          </tr>
        </thead>
        <tbody>${statsRows}</tbody>
      </table>
    </div>` : ''}

    <!-- Actions -->
    <div style="padding:16px 20px;background:#f9f9f9;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#888;text-align:center">
        UrDown Intelligence Server — تقرير تلقائي
      </p>
    </div>

  </div>
</body>
</html>`;
}



// ── منع التكرار ───────────────────────────────────────────────────────────────

function shouldAlert(key, cooldownMs = 60 * 60 * 1000) {
  const last = _recentAlerts.get(key);
  if (last && Date.now() - last < cooldownMs) return false;
  _recentAlerts.set(key, Date.now());
  return true;
}

// ── الفحص الرئيسي ────────────────────────────────────────────────────────────

async function runCheck() {
  logger.info('[monitor] جاري الفحص...');

  const cookieData     = collectCookieData();
  const telemetryStats = collectTelemetryStats(6);
  const hasProblem     = cookieData.problems.length > 0;

  if (!hasProblem) {
    logger.info('[monitor] ✅ كل شيء يعمل بشكل طبيعي');
    return { ok: true, problems: 0 };
  }

  // تحقق من منع التكرار
  const alertKey = cookieData.problems.map(p => p.platform).sort().join(',');
  if (!shouldAlert(alertKey)) {
    logger.info('[monitor] تنبيه مؤجل (cooldown نشط)');
    return { ok: true, problems: cookieData.problems.length, skipped: true };
  }

  // تحليل Claude
  logger.info('[monitor] جاري تحليل المشكلة بـ Claude AI...');
  const aiAnalysis = await analyzeWithClaude(cookieData, telemetryStats);

  const isUrgent  = cookieData.problems.some(p => p.severity === 'critical');
  const platforms = cookieData.problems.map(p => p.platform).join('، ');
  const subject   = isUrgent
    ? `🔴 عاجل: كوكيز ${platforms} انتهت — UrDown`
    : `🟡 تحذير: مشاكل في كوكيز ${platforms} — UrDown`;

  const html = buildEmailHtml({ cookieData, telemetryStats, aiAnalysis });
  await sendAlert({ subject, html });

  return {
    ok:       true,
    problems: cookieData.problems.length,
    alerted:  true,
    platforms,
  };
}

// ── تشغيل دوري ───────────────────────────────────────────────────────────────

let _timer = null;

function startMonitor() {
  if (!ALERT_EMAIL) {
    logger.warn('[monitor] ALERT_EMAIL غير مضبوط — المراقبة معطّلة');
    return;
  }
  logger.info(`[monitor] بدء المراقبة — كل ${INTERVAL_MS / 60000} دقيقة → ${ALERT_EMAIL}`);

  // فحص فوري عند البدء
  runCheck().catch(e => logger.error(`[monitor] خطأ: ${e.message}`));

  _timer = setInterval(() => {
    runCheck().catch(e => logger.error(`[monitor] خطأ: ${e.message}`));
  }, INTERVAL_MS);
}

function stopMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── إرسال تقرير يدوي (من /admin/monitor/report) ──────────────────────────────

async function sendManualReport() {
  const cookieData     = collectCookieData();
  const telemetryStats = collectTelemetryStats(24); // آخر 24 ساعة للتقرير اليدوي
  const aiAnalysis     = await analyzeWithClaude(cookieData, telemetryStats);

  const subject = `📊 تقرير UrDown — ${new Date().toLocaleDateString('ar-EG')}`;
  const html    = buildEmailHtml({ cookieData, telemetryStats, aiAnalysis });

  const sent = await sendAlert({ subject, html });
  return { ok: sent, aiAnalysis, cookieProblems: cookieData.problems.length };
}

module.exports = { startMonitor, stopMonitor, runCheck, sendManualReport };
