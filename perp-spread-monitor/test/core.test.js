'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toHourly, compare, alertCandidates, applyCooldown } = require('../core');

const ALERT = {
  frSpreadAprPct: 30,
  priceSpreadPct: 0.5,
  minVolume24hUsd: 1000000,
  cooldownMinutes: 30,
  maxPriceRatioSanity: 1.2,
};

function row(symbol, price, fundingRaw, intervalHours, volume24h = 5e6) {
  return { symbol, raw: symbol, price, fundingHourly: toHourly(fundingRaw, intervalHours), volume24h };
}

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('toHourly', () => {
  close(toHourly(0.0001, 8), 0.0000125);
  close(toHourly(0.0001, 1), 0.0001);
  assert.equal(toHourly(null, 8), null);
  assert.equal(toHourly(0.01, 0), null);
});

test('1h / 4h / 8h が混ざったFRを1時間換算して比較する', () => {
  // 1時間あたりに直すと A=0.00001, B=0.00005, C=0.000002
  const byDex = {
    a: [row('ETH', 3000, 0.00001, 1)],
    b: [row('ETH', 3001, 0.0002, 4)],
    c: [row('ETH', 3002, 0.000016, 8)],
  };
  const [r] = compare(byDex, { alert: ALERT });
  assert.equal(r.symbol, 'ETH');
  assert.equal(r.dexCount, 3);
  assert.equal(r.fr.shortOn, 'b');
  assert.equal(r.fr.longOn, 'c');
  close(r.fr.hourlyPct, (0.00005 - 0.000002) * 100);
  close(r.fr.aprPct, (0.00005 - 0.000002) * 24 * 365 * 100);
  // 換算しない生の値で比べると b(0.0002) と a(0.00001) になってしまうことの確認
  assert.notEqual(r.fr.longOn, 'a');
});

test('1つのDEXにしかない銘柄は除外される', () => {
  const byDex = {
    a: [row('BTC', 60000, 0.0001, 1), row('ONLYA', 1, 0.001, 1)],
    b: [row('BTC', 60010, 0.0001, 8), row('ONLYB', 2, 0.001, 8)],
  };
  const res = compare(byDex, { alert: ALERT });
  assert.deepEqual(res.map((r) => r.symbol), ['BTC']);
});

test('価格乖離・出来高の最小値', () => {
  const byDex = {
    a: [row('SOL', 100, 0, 1, 2e6)],
    b: [row('SOL', 101, 0, 1, 9e6)],
  };
  const [r] = compare(byDex, { alert: ALERT });
  close(r.price.pct, 1);
  assert.equal(r.price.highOn, 'b');
  assert.equal(r.price.lowOn, 'a');
  assert.equal(r.price.suspicious, false);
  assert.equal(r.minVolume24h, 2e6);
  assert.equal(r.alert.price, true);
  assert.equal(r.alert.fr, false);
});

test('価格比が20%を超える銘柄は suspicious になり、アラートに出ない', () => {
  const byDex = {
    a: [row('PEPE', 0.00001, 0.001, 1)],
    b: [row('PEPE', 0.01, -0.001, 1)], // 単位違い
  };
  const res = compare(byDex, { alert: ALERT, maxPriceRatioSanity: 1.2 });
  assert.equal(res[0].suspicious, true);
  assert.equal(res[0].price.suspicious, true);
  assert.equal(res[0].alert.fr, false);
  assert.equal(res[0].alert.price, false);
  assert.equal(alertCandidates(res).length, 0);
});

test('出来高が足りないとアラートにならない', () => {
  const byDex = {
    a: [row('XYZ', 1, 0.001, 1, 5e6)],
    b: [row('XYZ', 1, -0.001, 1, 1e5)],
  };
  const [r] = compare(byDex, { alert: ALERT });
  assert.ok(r.fr.aprPct > ALERT.frSpreadAprPct);
  assert.equal(r.alert.fr, false);
});

test('watchlist で対象を絞れる', () => {
  const byDex = {
    a: [row('BTC', 1, 0, 1), row('ETH', 1, 0, 1)],
    b: [row('BTC', 1, 0, 1), row('ETH', 1, 0, 1)],
  };
  const res = compare(byDex, { watchlist: ['ETH'] });
  assert.deepEqual(res.map((r) => r.symbol), ['ETH']);
});

test('FR差年率の降順に並ぶ', () => {
  const byDex = {
    a: [row('A1', 1, 0.0001, 1), row('A2', 1, 0.001, 1), row('A3', 1, 0.00001, 1)],
    b: [row('A1', 1, 0, 1), row('A2', 1, 0, 1), row('A3', 1, 0, 1)],
  };
  assert.deepEqual(compare(byDex).map((r) => r.symbol), ['A2', 'A1', 'A3']);
});

test('クールダウン中は同じアラートを繰り返さない', () => {
  const byDex = {
    a: [row('ETH', 3000, 0.0001, 1)],
    b: [row('ETH', 3000, -0.0001, 1)],
  };
  const cands = alertCandidates(compare(byDex, { alert: ALERT }));
  assert.equal(cands.length, 1);
  assert.equal(cands[0].key, 'fr|ETH|a|b');

  const state = {};
  const t0 = 1_000_000;
  assert.equal(applyCooldown(cands, state, t0, 30).length, 1);
  assert.equal(applyCooldown(cands, state, t0 + 10 * 60000, 30).length, 0);
  assert.equal(applyCooldown(cands, state, t0 + 29 * 60000, 30).length, 0);
  assert.equal(applyCooldown(cands, state, t0 + 30 * 60000, 30).length, 1);

  // DEXの組が変われば別アラート
  const other = [{ ...cands[0], key: 'fr|ETH|c|b' }];
  assert.equal(applyCooldown(other, state, t0 + 31 * 60000, 30).length, 1);
});

test('3つ以上のDEXで1つだけ価格が大きく違うときは、その1つだけを比較から外す', () => {
  // 仮想通貨の QNT と、別DEXの株式 QNT（Quantinuum）のようなケース
  const byDex = {
    a: [row('QNT', 258.5, 0.0004, 1, 5e6)],
    b: [row('QNT', 258.4, -0.0004, 1, 5e6)],
    c: [row('QNT', 46.5, 0.01, 1, 5e6)],
  };
  const [r] = compare(byDex, { alert: ALERT, maxPriceRatioSanity: 1.2 });
  assert.equal(r.suspicious, false);
  assert.equal(r.dexCount, 2);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries.find((e) => e.dex === 'c').outlier, true);
  assert.equal(r.fr.shortOn, 'a');
  assert.equal(r.fr.longOn, 'b');
  assert.ok(r.price.pct < 0.1);
  assert.equal(r.alert.fr, true);
});

test('2つずつに割れていて本物が決められないときは従来どおり suspicious', () => {
  const byDex = {
    a: [row('XYZ', 1, 0, 1)],
    b: [row('XYZ', 1.01, 0, 1)],
    c: [row('XYZ', 100, 0, 1)],
    d: [row('XYZ', 101, 0, 1)],
  };
  const [r] = compare(byDex, { alert: ALERT, maxPriceRatioSanity: 1.2 });
  assert.equal(r.suspicious, true);
  assert.equal(r.dexCount, 4);
  assert.ok(r.entries.every((e) => !e.outlier));
});

test('全DEXのFRが同じでも、ショート先とロング先が同じDEXにならない', () => {
  const byDex = {
    a: [row('FET', 0.5, 0.0000125, 1)],
    b: [row('FET', 0.501, 0.0000125, 1)],
    c: [row('FET', 0.502, 0.0001, 8)],
  };
  const [r] = compare(byDex, { alert: ALERT });
  close(r.fr.aprPct, 0);
  assert.notEqual(r.fr.shortOn, r.fr.longOn);
  assert.notEqual(r.price.highOn, r.price.lowOn);
});

test('ショート先・ロング先の価格とFR、その2つの間の価格差を持つ', () => {
  const byDex = {
    a: [row('ETH', 3000, 0.0001, 1)],
    b: [row('ETH', 3030, -0.0001, 1)],
    c: [row('ETH', 2970, 0, 1)],
  };
  const [r] = compare(byDex, { alert: ALERT });
  assert.equal(r.fr.shortOn, 'a');
  assert.equal(r.fr.shortPrice, 3000);
  assert.equal(r.fr.longOn, 'b');
  assert.equal(r.fr.longPrice, 3030);
  close(r.fr.shortHourlyPct, 0.01);
  close(r.fr.longHourlyPct, -0.01);
  close(r.fr.pricePct, 1); // a と b の間（全体の最大最小 c〜b ではない）
  assert.equal(r.price.highPrice, 3030);
  assert.equal(r.price.lowPrice, 2970);
});

test('出来高の少ないDEXが混ざっていても、足りているDEXどうしで比べて通知する', () => {
  const byDex = {
    big1: [row('ZRO', 2.0, 0.0002, 1, 5e7)],
    big2: [row('ZRO', 2.001, 0, 1, 3e6)],
    thin: [row('ZRO', 2.002, -0.001, 1, 1e4)], // FR差は一番大きいが出来高が少ない
  };
  const [r] = compare(byDex, { alert: ALERT });
  // 全DEXでの比較（参考）では thin が選ばれる
  assert.equal(r.fr.longOn, 'thin');
  // 出来高が足りているDEXだけの比較
  assert.equal(r.liquid.dexCount, 2);
  assert.equal(r.liquid.fr.shortOn, 'big1');
  assert.equal(r.liquid.fr.longOn, 'big2');
  assert.equal(r.liquid.fr.minVolume24h, 3e6);
  assert.equal(r.alert.fr, true);
  const [c] = alertCandidates([r]);
  assert.equal(c.key, 'fr|ZRO|big1|big2');
  assert.equal(c.shortPrice, 2.0);
});

test('出来高が足りているDEXが1つしか無ければ通知しない', () => {
  const byDex = {
    a: [row('XYZ', 1, 0.001, 1, 5e6)],
    b: [row('XYZ', 1, -0.001, 1, 1e5)],
    c: [row('XYZ', 1, -0.002, 1, 2e5)],
  };
  const [r] = compare(byDex, { alert: ALERT });
  assert.equal(r.liquid, null);
  assert.equal(r.alert.fr, false);
});
