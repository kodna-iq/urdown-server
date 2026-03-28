'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { db }    = require('../db/database');
const logger    = require('../middleware/logger');

const WINDOW_HOURS = parseInt(process.env.AI_ADVISOR_WINDOW_HOURS || '24');

function collectStats() {
  const since = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600;
  const rows = db.prepare(`
    SELECT platform,
      COUNT(*) AS total,
      SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures,
      GROUP_CONCAT(DISTINCT error_type) AS error_types,
      AVG(elapsed_ms) AS avg_ms
    FROM telemetry_events WHERE created_at >= ?
    GROUP BY platform ORDER BY failures DESC
  `).all(since);

  const configs = db.prepare(
    'SELECT platform, clients, fallback, force_hls, use_cookies FROM platform_configs'
  ).all();

  return { stats: rows, configs, windowHours: WINDOW_HOURS };
}

function buildPrompt(data) {
  const statsText = data.stats.map(r => {
    const rate = r.total > 0 ? ((r.successes / r.total) * 100).toFixed(1) : '0';
    return `- ${r.platform}: ${r.total} طلب، نجاح ${rate}%، أخطاء=[${r.error_types || 'لا يوجد'}]، متوسط=${Math.round(r.avg_ms || 0)}ms`;
  }).join('\n') || '- لا توجد بيانات بعد';

  const configText = data.configs.map(c =>
    `- ${c.platform}: clients=${c.clients}, fallback=${c.fallback}, force_hls=${c.force_hls}`
  ).join('\n') || '- لا توجد إعدادات';

  return `أنت مهندس خبير في سيرفرات تحميل الفيديو باستخدام yt-dlp.
حلّل بيانات التيليمتري التالية من آخر ${data.windowHours} ساعة واقترح إصلاحات عملية.

بيانات التيليمتري:
${statsText}

الإعدادات الحالية:
${configText}

أجب بالعربية بهذا التنسيق:
📊 ملخص الوضع: (جملتان)
🚨 المشاكل: (إن وجدت)
🔧 التوصيات: (خطوات محددة قابلة للتطبيق)
✅ ما يعمل بشكل جيد:`;
}

async function runAdvisor() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length < 10) {
    return { ok: false, error: 'ANTHROPIC_API_KEY غير مضبوط' };
  }

  const client = new Anthropic({ apiKey });
  const data   = collectStats();

  logger.info('[ai-advisor] جاري التحليل...');

  const message = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: buildPrompt(data) }],
  });

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  logger.info('[ai-advisor] اكتمل التحليل');

  return {
    ok: true,
    analysis:    text,
    windowHours: WINDOW_HOURS,
    stats:       data.stats,
    timestamp:   new Date().toISOString(),
  };
}

module.exports = { runAdvisor, collectStats };
