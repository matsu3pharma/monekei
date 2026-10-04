'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSymbol } = require('../exchanges');

test('銘柄名の正規化', () => {
  assert.equal(normalizeSymbol('BTC-USD'), 'BTC');
  assert.equal(normalizeSymbol('BTCUSDT'), 'BTC');
  assert.equal(normalizeSymbol('BTC-USD-PERP'), 'BTC');
  assert.equal(normalizeSymbol('kPEPE'), '1000PEPE');
  assert.equal(normalizeSymbol('1000PEPEUSDT'), '1000PEPE');
});

test('その他の表記', () => {
  assert.equal(normalizeSymbol('eth'), 'ETH');
  assert.equal(normalizeSymbol('ETH-PERP'), 'ETH');
  assert.equal(normalizeSymbol('ETH/USDC'), 'ETH');
  assert.equal(normalizeSymbol('SOLUSDC'), 'SOL');
  assert.equal(normalizeSymbol('kBONK'), '1000BONK');
  // 銘柄名そのものは消さない
  assert.equal(normalizeSymbol('USDT'), 'USDT');
  // 小文字 k で始まる普通の銘柄（全部小文字）は 1000 にしない
  assert.equal(normalizeSymbol('kaito'), 'KAITO');
  assert.equal(normalizeSymbol('KAITO'), 'KAITO');
});
