'use strict';
// 画面(index.html)と設定ひな形(config.example.json)の読み込み。
// 単体アプリ（Node.js の Single Executable Application）として動いているときは、
// 実行ファイルに埋め込んだ asset から読む。それ以外はこのフォルダのファイルを読む。

const fs = require('fs');
const path = require('path');

const FILES = {
  'index.html': path.join(__dirname, 'public', 'index.html'),
  'config.example.json': path.join(__dirname, 'config.example.json'),
};

let sea = null;
try {
  sea = require('node:sea');
} catch {}

function isSea() {
  return !!(sea && sea.isSea && sea.isSea());
}

function readResource(name) {
  if (isSea()) return sea.getAsset(name, 'utf8');
  return fs.readFileSync(FILES[name], 'utf8');
}

module.exports = { readResource, isSea };
