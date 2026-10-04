'use strict';
// 各DEXの公開ドキュメントのレスポンス形に合わせたサンプルで、解析部分だけを確認する
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHyperliquid, parseDydx, parseAster, parseLighter, parseParadex } = require('../exchanges');

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Hyperliquid: universe と ctxs を位置で対応させ、上場廃止を除外する', () => {
  const data = [
    { universe: [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }, { name: 'kPEPE' }] },
    [
      { markPx: '60000.5', funding: '0.0000125', dayNtlVlm: '5200000000' },
      { markPx: '1', funding: '0', dayNtlVlm: '0' },
      { markPx: '0.0123', funding: '-0.00002', dayNtlVlm: '1000' },
    ],
  ];
  const rows = parseHyperliquid(data, 1);
  assert.deepEqual(rows.map((r) => r.symbol), ['BTC', '1000PEPE']);
  assert.equal(rows[0].price, 60000.5);
  close(rows[0].fundingHourly, 0.0000125);
  assert.equal(rows[0].volume24h, 5.2e9);
  assert.equal(rows[1].raw, 'kPEPE');
});

test('dYdX: ACTIVE のみ', () => {
  const data = {
    markets: {
      'BTC-USD': { ticker: 'BTC-USD', status: 'ACTIVE', oraclePrice: '60001', nextFundingRate: '0.00001', volume24H: '123456' },
      'XXX-USD': { ticker: 'XXX-USD', status: 'FINAL_SETTLEMENT', oraclePrice: '1', nextFundingRate: '0', volume24H: '0' },
    },
  };
  const rows = parseDydx(data, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTC');
  close(rows[0].fundingHourly, 0.00001);
});

test('Aster: USDT建てのみ、銘柄ごとの間隔（なければ既定値）', () => {
  const premium = [
    { symbol: 'BTCUSDT', markPrice: '60000', lastFundingRate: '0.0001' },
    { symbol: 'ZORAUSDT', markPrice: '0.1', lastFundingRate: '0.0004' },
    { symbol: 'BTCUSD1', markPrice: '60000', lastFundingRate: '0.0001' },
  ];
  const info = [{ symbol: 'ZORAUSDT', fundingIntervalHours: 4 }];
  const tickers = [{ symbol: 'BTCUSDT', quoteVolume: '999' }];
  const rows = parseAster(premium, info, tickers, 8);
  assert.deepEqual(rows.map((r) => r.symbol), ['BTC', 'ZORA']);
  close(rows[0].fundingHourly, 0.0001 / 8);
  close(rows[1].fundingHourly, 0.0004 / 4);
  assert.equal(rows[0].volume24h, 999);
  assert.equal(rows[1].volume24h, null);
});

test('Lighter: exchange=lighter の値だけ使い、active のみ', () => {
  const fr = {
    funding_rates: [
      { market_id: 1, exchange: 'binance', symbol: 'BTC', rate: 0.5 },
      { market_id: 1, exchange: 'lighter', symbol: 'BTC', rate: 0.0008 },
      { market_id: 2, exchange: 'lighter', symbol: 'ETH', rate: -0.0008 },
    ],
  };
  const ob = {
    order_book_details: [
      { market_id: 1, symbol: 'BTC', status: 'active', last_trade_price: 60000, daily_quote_token_volume: 1e8 },
      { market_id: 2, symbol: 'ETH', status: 'inactive', last_trade_price: 3000 },
    ],
  };
  const rows = parseLighter(fr, ob, 8);
  assert.equal(rows.length, 1);
  close(rows[0].fundingHourly, 0.0001);
  assert.equal(rows[0].price, 60000);
});

test('Paradex: -USD-PERP のみ（オプション除外）', () => {
  const summary = {
    results: [
      { symbol: 'BTC-USD-PERP', mark_price: '60000', funding_rate: '0.0008', volume_24h: '1000000' },
      { symbol: 'BTC-USD-70000-C', mark_price: '100', funding_rate: '0' },
    ],
  };
  const rows = parseParadex(summary, null, 8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTC');
  close(rows[0].fundingHourly, 0.0001);
  // /v1/markets の funding_period_hours があればそちらを使う
  const rows2 = parseParadex(summary, { results: [{ symbol: 'BTC-USD-PERP', funding_period_hours: 4 }] }, 8);
  close(rows2[0].fundingHourly, 0.0002);
});

test('想定外の形ならエラーにする（チップを赤にするため）', () => {
  assert.throws(() => parseHyperliquid({}, 1));
  assert.throws(() => parseDydx(null, 1));
  assert.throws(() => parseAster({}, [], [], 8));
  assert.throws(() => parseLighter({}, {}, 8));
  assert.throws(() => parseParadex({}, null, 8));
});
