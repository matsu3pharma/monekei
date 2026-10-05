'use strict';
// ポーリング・アラート・HTTPサーバー。起動: node server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ADAPTERS, normalizeSymbol, makeFetchJson } = require('./exchanges');
const { compare, alertCandidates, applyCooldown, updateStreaks } = require('./core');
const { formatAlert, notifyAll } = require('./notify');
const { readResource } = require('./resources');
const desktop = require('./desktop');

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const MAX_HISTORY = 50;
// /api/snapshot に載せる目印。単体アプリが「すでに起動しているか」を確かめるのに使う
const APP_ID = 'perp-spread-monitor';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3939,
  pollSeconds: 30,
  exchanges: {},
  alert: {
    frSpreadAprPct: 30,
    priceSpreadPct: 0.5,
    minVolume24hUsd: 1000000,
    cooldownMinutes: 30,
    maxPriceRatioSanity: 1.2,
    minDurationMinutes: 0,
  },
  watchlist: [],
  notify: { discordWebhookUrl: '', telegramBotToken: '', telegramChatId: '' },
};

let lastGoodConfig = null;
let configError = null;

// ポーリングのたびに読み直す。壊れていたら直前の正常な設定で動き続ける。
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, readResource('config.example.json'));
      console.log('config.json が無かったので config.example.json からコピーしました');
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    const cfg = {
      ...DEFAULTS,
      ...raw,
      alert: { ...DEFAULTS.alert, ...(raw.alert || {}) },
      notify: { ...DEFAULTS.notify, ...(raw.notify || {}) },
      exchanges: {},
    };
    for (const [id, a] of Object.entries(ADAPTERS)) {
      const e = (raw.exchanges || {})[id] || {};
      const apiKey = typeof e.apiKey === 'string' ? e.apiKey.trim() : '';
      // 既定で無効のDEX（APIキー必須など）は、enabled を明示するかキーを入れたときだけ有効
      const defaultEnabled = a.defaultEnabled === false ? (a.requiresApiKey ? !!apiKey : false) : true;
      cfg.exchanges[id] = {
        enabled: e.enabled == null ? defaultEnabled : e.enabled !== false,
        intervalHours: Number(e.intervalHours) > 0 ? Number(e.intervalHours) : a.defaultIntervalHours,
        apiKey,
      };
    }
    cfg.pollSeconds = Math.max(5, Number(cfg.pollSeconds) || DEFAULTS.pollSeconds);
    cfg.watchlist = (Array.isArray(cfg.watchlist) ? cfg.watchlist : []).map(normalizeSymbol).filter(Boolean);
    lastGoodConfig = cfg;
    configError = null;
  } catch (err) {
    configError = `config.json の読み込みに失敗: ${err.message}`;
    console.error(configError);
    if (!lastGoodConfig) lastGoodConfig = loadDefaults();
  }
  return lastGoodConfig;
}

function loadDefaults() {
  const cfg = { ...DEFAULTS, exchanges: {} };
  for (const [id, a] of Object.entries(ADAPTERS)) {
    cfg.exchanges[id] = { enabled: a.defaultEnabled !== false, intervalHours: a.defaultIntervalHours, apiKey: '' };
  }
  return cfg;
}

const LABELS = Object.fromEntries(Object.entries(ADAPTERS).map(([id, a]) => [id, a.label]));
const fetchJson = makeFetchJson(15000);
const lastSent = {};

// 差が続いている時間の記録。再起動しても数分以内なら続きから数えられるよう、設定ファイルの隣に保存する
const STREAKS_PATH = path.join(path.dirname(CONFIG_PATH), 'streaks.json');
let streaks = {};
try {
  streaks = JSON.parse(fs.readFileSync(STREAKS_PATH, 'utf8')) || {};
} catch {}
let firstRound = true;

function saveStreaks() {
  try {
    fs.writeFileSync(STREAKS_PATH, JSON.stringify(streaks));
  } catch {}
}
const alertHistory = [];
let snapshot = {
  updatedAt: null,
  pollSeconds: DEFAULTS.pollSeconds,
  alertConfig: DEFAULTS.alert,
  labels: LABELS,
  exchanges: {},
  results: [],
  alerts: alertHistory,
  configError: null,
};

async function poll() {
  const cfg = loadConfig();
  const status = {};
  const byDex = {};

  await Promise.all(
    Object.entries(ADAPTERS).map(async ([id, adapter]) => {
      const ex = cfg.exchanges[id];
      if (!ex.enabled) {
        status[id] = { label: adapter.label, enabled: false, ok: false, count: 0, error: null };
        return;
      }
      const started = Date.now();
      try {
        const rows = await adapter.fetch({ fetchJson, intervalHours: ex.intervalHours, config: ex });
        if (!rows.length) throw new Error('銘柄が0件');
        byDex[id] = rows;
        status[id] = { label: adapter.label, enabled: true, ok: true, count: rows.length, error: null, ms: Date.now() - started };
      } catch (err) {
        const msg = err && err.name === 'TimeoutError' ? 'タイムアウト' : (err && err.message) || String(err);
        status[id] = { label: adapter.label, enabled: true, ok: false, count: 0, error: msg, ms: Date.now() - started };
        console.error(`[${adapter.label}] 取得失敗: ${msg}`);
      }
    })
  );

  const results = compare(byDex, {
    watchlist: cfg.watchlist,
    maxPriceRatioSanity: cfg.alert.maxPriceRatioSanity,
    alert: cfg.alert,
  });

  // 取得が1〜2回失敗しても途切れないよう、更新間隔の3倍（最低2分）までの空白は連続とみなす
  updateStreaks(results, streaks, Date.now(), {
    alert: cfg.alert,
    maxGapMs: Math.max(120000, cfg.pollSeconds * 3000),
    firstRound,
  });
  firstRound = false;
  saveStreaks();

  const fresh = applyCooldown(alertCandidates(results), lastSent, Date.now(), cfg.alert.cooldownMinutes);
  for (const a of fresh) {
    const text = formatAlert(a, LABELS);
    const item = { ...a, text, at: new Date().toISOString(), notifyErrors: [] };
    alertHistory.unshift(item);
    console.log(`\n${new Date().toLocaleString()}\n${text}`);
    notifyAll(cfg.notify, text).then((errors) => {
      if (errors.length) {
        item.notifyErrors = errors;
        console.error(`通知失敗: ${errors.join(' / ')}`);
      }
    });
  }
  alertHistory.length = Math.min(alertHistory.length, MAX_HISTORY);

  snapshot = {
    updatedAt: new Date().toISOString(),
    pollSeconds: cfg.pollSeconds,
    alertConfig: cfg.alert,
    watchlist: cfg.watchlist,
    labels: LABELS,
    exchanges: status,
    results,
    alerts: alertHistory,
    configError,
  };

  const okCount = Object.values(status).filter((s) => s.ok).length;
  const enabledCount = Object.values(status).filter((s) => s.enabled).length;
  console.log(
    `[${new Date().toLocaleTimeString()}] 取得 ${okCount}/${enabledCount} DEX, 比較対象 ${results.length} 銘柄, 新規アラート ${fresh.length} 件`
  );
  return cfg;
}

async function loop() {
  let cfg;
  try {
    cfg = await poll();
  } catch (err) {
    console.error('ポーリング中のエラー:', err);
    cfg = lastGoodConfig || loadDefaults();
  }
  setTimeout(loop, cfg.pollSeconds * 1000);
}

// ブラウザ以外（他のサイトのページなど）からの操作を防ぐ。
// Host が自分自身で、独自ヘッダ付き（= 他オリジンからはプリフライトで止まる）のときだけ受け付ける。
function isLocalAction(req, port) {
  const host = String(req.headers.host || '');
  const okHost = host === `localhost:${port}` || host === `127.0.0.1:${port}`;
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
  return okHost && okOrigin && req.headers['x-monitor-action'] === '1';
}

// opts.onListening(port): 待ち受け開始時 / opts.onError(err): 起動失敗時（省略時はメッセージを出して終了）
function startServer(opts = {}) {
  const cfg = loadConfig();
  const port = cfg.port;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname.startsWith('/api/action/')) {
      if (!isLocalAction(req, port)) {
        res.writeHead(403).end();
        return;
      }
      const name = url.pathname.slice('/api/action/'.length);
      if (name === 'open-config') {
        desktop.openFile(CONFIG_PATH);
        res.writeHead(204).end();
        return;
      }
      if (name === 'quit') {
        res.writeHead(204).end();
        console.log('画面の「終了」ボタンで終了しました');
        setTimeout(() => process.exit(0), 200);
        return;
      }
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html;
      try {
        html = readResource('index.html');
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('index.html が読めません');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
      return;
    }
    if (url.pathname === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...snapshot, app: { name: APP_ID, configPath: CONFIG_PATH } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  });
  server.on('error', (err) => {
    if (opts.onError) return opts.onError(err, port);
    if (err.code === 'EADDRINUSE') {
      console.error(`ポート ${port} は使用中です。すでに起動していないか確認するか、config.json の port を変えてください。`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  server.listen(port, cfg.host, () => {
    console.log(`Perp DEX 乖離モニターを起動しました → http://localhost:${port}`);
    console.log(`設定ファイル: ${CONFIG_PATH}`);
    if (opts.onListening) opts.onListening(port);
    else console.log('止めるときはこの画面で Ctrl + C を押してください。');
  });
  return server;
}

if (require.main === module) {
  startServer();
  loop();
}

module.exports = { loadConfig, poll, startServer, loop, getSnapshot: () => snapshot, APP_ID, CONFIG_PATH };
