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
