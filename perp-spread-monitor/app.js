'use strict';
// デスクトップアプリとしての入口（ダブルクリックで起動する単体アプリはこのファイルから始まる）。
// - 設定ファイルの置き場所を決める
// - すでに起動していれば、画面を開き直すだけで終わる
// - サーバーを起動して、画面（ブラウザのアプリ用ウィンドウ）を開く
// 開発中は `node app.js` でも同じ動きを確認できる。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSea } = require('./resources');
const desktop = require('./desktop');

const TITLE = 'Perp DEX 乖離モニター';
const SEA = isSea();
const args = process.argv.slice(2);
const smokeTest = args.find((a) => a.startsWith('--smoke-test'));

// 設定・ログの置き場所
// - Windows / Linux: 実行ファイルと同じフォルダ（フォルダごと持ち運べる）
// - Mac: ホームフォルダの「PerpSpreadMonitor」（.app の中や、ダウンロード直後の隔離された場所には書けないため）
function dataDir() {
  if (process.env.PSM_DATA_DIR) return process.env.PSM_DATA_DIR;
  if (!SEA) return __dirname;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'PerpSpreadMonitor');
  return path.dirname(process.execPath);
}

const DATA_DIR = dataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.CONFIG_PATH) process.env.CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// 単体アプリには黒い画面が無いので、ログはファイルにも書く
const LOG_PATH = path.join(DATA_DIR, 'monitor.log');
function setupLogFile() {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.old');
    }
  } catch {}
  const write = (level, parts) => {
    const line = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack : JSON.stringify(p))).join(' ');
    try {
      fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${line}\n`);
    } catch {}
  };
  for (const level of ['log', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...parts) => {
      write(level === 'log' ? 'INFO ' : 'ERROR', parts);
      try {
        orig(...parts);
      } catch {}
    };
  }
}

function configuredPort() {
  try {
    const raw = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    const p = Number(raw.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {}
  return 3939;
}

// このアプリがすでにそのポートで動いているか
async function alreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return !!(body && body.app && body.app.name === 'perp-spread-monitor');
  } catch {
    return false;
  }
}

async function fatal(message) {
  console.error(message);
  if (!smokeTest) await desktop.alert(TITLE, message);
  process.exit(1);
}

// CI 用: 1回だけ全DEXから取得して結果をファイルに書き、終了する（--smoke-test=結果ファイル）
// 黒い画面の無いアプリでも結果を確かめられるよう、標準出力ではなくファイルに書く
async function runSmokeTest() {
  const { readResource } = require('./resources');
  const { poll, getSnapshot } = require('./server');
  await poll();
  const snap = getSnapshot();
  const ok = Object.values(snap.exchanges).filter((e) => e.ok).length;
  const result = {
    sea: SEA,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    configPath: process.env.CONFIG_PATH,
    configCreated: fs.existsSync(process.env.CONFIG_PATH),
    indexHtmlBytes: readResource('index.html').length,
    exchangesOk: ok,
    exchanges: Object.fromEntries(Object.entries(snap.exchanges).map(([k, v]) => [k, v.ok ? v.count : v.error])),
    results: snap.results.length,
  };
  const out = smokeTest.includes('=') ? smokeTest.slice(smokeTest.indexOf('=') + 1) : path.join(DATA_DIR, 'smoke-test.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exit(ok > 0 && result.configCreated && result.indexHtmlBytes > 1000 ? 0 : 1);
}

async function main() {
  if (SEA || smokeTest) setupLogFile();
  process.on('uncaughtException', (err) => fatal(`予期しないエラーで終了しました。\n${(err && err.stack) || err}\n\nログ: ${LOG_PATH}`));

  if (smokeTest) {
    await runSmokeTest();
    return;
  }

  const port = configuredPort();
  const url = `http://localhost:${port}`;
  if (await alreadyRunning(port)) {
    // 2回目のダブルクリック: 画面だけ開き直す
    await desktop.openAppWindow(url);
    process.exit(0);
  }

  // Windows の単体アプリは、初回だけデスクトップにショートカットを作る（次からはそれをダブルクリック）
  if (SEA && process.platform === 'win32') {
    const flag = path.join(DATA_DIR, '.shortcut-created');
    if (!fs.existsSync(flag)) {
      if (await desktop.createWindowsShortcut('Perp DEX 乖離モニター', process.execPath, DATA_DIR)) {
        try {
          fs.writeFileSync(flag, new Date().toISOString());
        } catch {}
        console.log('デスクトップにショートカットを作りました');
      }
    }
  }

  const { startServer, loop } = require('./server');
  startServer({
    onListening: (p) => {
      console.log(`ログ: ${LOG_PATH}`);
      loop();
      if (!args.includes('--no-browser')) desktop.openAppWindow(`http://localhost:${p}`);
    },
    onError: (err, p) => {
      if (err.code === 'EADDRINUSE') {
        fatal(`ポート ${p} が別のアプリで使われているため起動できません。\n\n設定ファイルの "port" を別の番号（例: 3940）に変えてから、もう一度起動してください。\n\n設定ファイル: ${process.env.CONFIG_PATH}`);
      } else {
        fatal(`起動に失敗しました。\n${err.message}`);
      }
    },
  });
}

main();
