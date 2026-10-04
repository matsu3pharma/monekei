'use strict';
// ポーリング・アラート・HTTPサーバー。起動: node server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ADAPTERS, normalizeSymbol, makeFetchJson } = require('./exchanges');
const { compare, alertCandidates, applyCooldown } = require('./core');
const { formatAlert, notifyAll } = require('./notify');

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const MAX_HISTORY = 50;

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
  },
  watchlist: [],
  notify: { discordWebhookUrl: '', telegramBotToken: '', telegramChatId: '' },
};

let lastGoodConfig = null;
let configError = null;

// ポーリングのたびに読み直す。壊れていたら直前の正常な設定で動き続ける。
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
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

function startServer() {
  const cfg = loadConfig();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(INDEX_PATH, (err, buf) => {
        if (err) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('index.html が読めません');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(buf);
      });
      return;
    }
    if (url.pathname === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`ポート ${cfg.port} は使用中です。すでに起動していないか確認するか、config.json の port を変えてください。`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Perp DEX 乖離モニターを起動しました → http://localhost:${cfg.port}`);
    console.log('止めるときはこの画面で Ctrl + C を押してください。');
  });
}

if (require.main === module) {
  startServer();
  loop();
}

module.exports = { loadConfig, poll };
