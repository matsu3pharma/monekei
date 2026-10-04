'use strict';
// Discord / Telegram 送信とメッセージ整形。

function fmtPct(x, digits) {
  return x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(digits)}%`;
}

// labels: { dex: 表示名 }
function formatAlert(a, labels = {}) {
  const L = (d) => labels[d] || d;
  if (a.type === 'fr') {
    return [
      `【FR乖離】${a.symbol}  年率 ${fmtPct(a.aprPct, 1)}（1h ${fmtPct(a.hourlyPct, 4)}）`,
      `  ${L(a.shortOn)}でショート / ${L(a.longOn)}でロング`,
      `  価格差 ${fmtPct(a.pricePct, 3)}`,
    ].join('\n');
  }
  return [
    `【価格乖離】${a.symbol}  ${fmtPct(a.pricePct, 3)}`,
    `  高い: ${L(a.highOn)} / 安い: ${L(a.lowOn)}`,
  ].join('\n');
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

async function sendDiscord(webhookUrl, text) {
  await post(webhookUrl, { content: text.slice(0, 1900) });
}

async function sendTelegram(token, chatId, text) {
  await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });
}

// notifyCfg が空なら何もしない。失敗しても例外は投げず、エラー文字列の配列を返す。
async function notifyAll(notifyCfg = {}, text) {
  const jobs = [];
  if (notifyCfg.discordWebhookUrl) jobs.push(['Discord', sendDiscord(notifyCfg.discordWebhookUrl, text)]);
  if (notifyCfg.telegramBotToken && notifyCfg.telegramChatId) {
    jobs.push(['Telegram', sendTelegram(notifyCfg.telegramBotToken, notifyCfg.telegramChatId, text)]);
  }
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  return settled
    .map((s, i) => (s.status === 'rejected' ? `${jobs[i][0]}: ${s.reason && s.reason.message}` : null))
    .filter(Boolean);
}

module.exports = { formatAlert, notifyAll, sendDiscord, sendTelegram };
