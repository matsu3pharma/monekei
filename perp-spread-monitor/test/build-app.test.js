'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setWindowsGuiSubsystem, makeIco, makeIcns, bundle } = require('../scripts/build-app');

test('ico: 6サイズの PNG を含む', () => {
  const ico = makeIco();
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 6);
  const firstOffset = ico.readUInt32LE(6 + 12);
  assert.equal(ico.toString('ascii', firstOffset + 1, firstOffset + 4), 'PNG');
});

test('icns: ヘッダの長さがファイル全体と一致', () => {
  const icns = makeIcns();
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
});

test('PE の Subsystem を GUI(2) にする', () => {
  // 最小限の PE ヘッダだけを持つダミー
  const buf = Buffer.alloc(0x200);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  const off = 0x80 + 4 + 20 + 68;
  buf.writeUInt16LE(3, off);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psm-')), 'a.exe');
  fs.writeFileSync(file, buf);
  setWindowsGuiSubsystem(file);
  assert.equal(fs.readFileSync(file).readUInt16LE(off), 2);
});

test('bundle: 全モジュールを含み、構文として正しい', () => {
  const src = bundle();
  for (const m of ['app', 'server', 'exchanges', 'core', 'notify', 'resources', 'desktop']) {
    assert.ok(src.includes(`${JSON.stringify(m)}: function`), m);
  }
  // 実行はせず、構文チェックだけ
  assert.doesNotThrow(() => new Function('require', 'process', src));
});
