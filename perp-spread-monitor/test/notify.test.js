'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAlert } = require('../notify');

const LABELS = { hyperliquid: 'Hyperliquid', dydx: 'dYdX', lighter: 'Lighter' };

test('FR乖離の通知文', () => {
  const text = formatAlert(
    { type: 'fr', symbol: 'ETH', aprPct: 105.12, hourlyPct: 0.012, shortOn: 'hyperliquid', longOn: 'dydx', pricePct: 0.1333 },
    LABELS
  );
  assert.equal(text, '【FR乖離】ETH  年率 105.1%（1h 0.0120%）\n  Hyperliquidでショート / dYdXでロング\n  価格差 0.133%');
});

test('価格乖離の通知文', () => {
  const text = formatAlert({ type: 'price', symbol: 'ETH', pricePct: 1.3333, highOn: 'lighter', lowOn: 'hyperliquid' }, LABELS);
  assert.equal(text, '【価格乖離】ETH  1.333%\n  高い: Lighter / 安い: Hyperliquid');
});

test('価格付きの通知文', () => {
  const fr = formatAlert(
    { type: 'fr', symbol: 'SAND', aprPct: 35.9, hourlyPct: 0.0041, shortOn: 'hyperliquid', longOn: 'dydx', shortPrice: 0.073958, longPrice: 0.07385, pricePct: 0.146 },
    LABELS
  );
  assert.equal(fr.split('\n')[1], '  Hyperliquidでショート（0.07396） / dYdXでロング（0.07385）');
  const p = formatAlert({ type: 'price', symbol: 'BTC', pricePct: 0.5, highOn: 'lighter', lowOn: 'dydx', highPrice: 85512.34, lowPrice: 85087 }, LABELS);
  assert.equal(p.split('\n')[1], '  高い: Lighter（85,512.3） / 安い: dYdX（85,087）');
});
