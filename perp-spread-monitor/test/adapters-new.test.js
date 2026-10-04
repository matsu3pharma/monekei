'use strict';
// 追加DEXの解析部分。サンプルは 2026-10 時点の実レスポンスから必要なフィールドだけ抜き出したもの
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVariational,
  parseNado,
  parseDecibel,
  parseArcus,
  parseBulk,
  parseOndo,
  parseSodex,
  parsePopdex,
  fetchPages,
} = require('../exchanges');

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const BASE_HOURLY = 0.0000125; // 8hあたり0.01% を1時間あたりにした値

test('Variational: funding_rate は年率。休止中(interval=0)は除外', () => {
  const data = {
    listings: [
      { ticker: 'SOL', mark_price: '120.8', volume_24h: '1000', funding_rate: '0.1095', funding_interval_s: 28800 },
      { ticker: 'SAND', mark_price: '0.0739', volume_24h: '5', funding_rate: '-3.831675', funding_interval_s: 3600 },
      { ticker: 'US100S', mark_price: '1', volume_24h: '0', funding_rate: '0', funding_interval_s: 0 },
    ],
  };
  const rows = parseVariational(data);
  assert.deepEqual(rows.map((r) => r.symbol), ['SOL', 'SAND']);
  close(rows[0].fundingHourly, BASE_HOURLY);
  close(rows[1].fundingHourly, -3.831675 / 8760);
  assert.equal(rows[0].intervalHours, 8760);
  assert.equal(rows[0].volume24h, 1000);
});

test('Nado: funding_rate は24hあたり、銘柄名の -PERP_USDT0 と kPEPE を正規化', () => {
  const data = {
    'ETH-PERP_USDT0': { product_type: 'perpetual', base_currency: 'ETH-PERP', mark_price: 2700.4, funding_rate: 0.0003, quote_volume: 2.5e7 },
    'kPEPE-PERP_USDT0': { product_type: 'perpetual', base_currency: 'kPEPE-PERP', mark_price: 0.00428, funding_rate: -0.00002, quote_volume: 1e4 },
    'wQQQx_USDT0': { product_type: 'spot', base_currency: 'wQQQx', last_price: 754 },
  };
  const rows = parseNado(data, 24);
  assert.deepEqual(rows.map((r) => r.symbol), ['ETH', '1000PEPE']);
  close(rows[0].fundingHourly, BASE_HOURLY);
  assert.equal(rows[0].volume24h, 2.5e7);
});

test('Decibel: bps/時 と符号フラグ、market_addr で名前と出来高を対応させる', () => {
  const markets = [
    { market_addr: '0xbtc', market_name: 'BTC/USD' },
    { market_addr: '0xeth', market_name: 'ETH/USD' },
  ];
  const prices = [
    { market: '0xbtc', mark_px: 85000, funding_rate_bps: 0.125, is_funding_positive: true, funding_period_s: 3600 },
    { market: '0xeth', mark_px: 2700, funding_rate_bps: 0.5, is_funding_positive: false, funding_period_s: 3600 },
    { market: '0xunknown', mark_px: 1, funding_rate_bps: 0, is_funding_positive: true },
  ];
  const contexts = [{ market: '0xbtc', volume_24h: 123 }];
  const rows = parseDecibel(markets, prices, contexts);
  assert.deepEqual(rows.map((r) => r.symbol), ['BTC', 'ETH']);
  close(rows[0].fundingHourly, BASE_HOURLY);
  close(rows[1].fundingHourly, -0.00005);
  assert.equal(rows[0].volume24h, 123);
  assert.equal(rows[1].volume24h, null);
});

test('Arcus: ONLINE のみ、nextFundingRate(1h) を優先', () => {
  const data = {
    markets: [
      { marketDisplayName: 'BTC-USD', status: 'ONLINE', type: 'PERPETUAL', markPrice: '85052.2', fundingRate: '0.0000125', nextFundingRate: '0.0000097', volume24hNotional: '121654392.53' },
      { marketDisplayName: 'KBONK-USD', status: 'OFFLINE', type: 'PERPETUAL', markPrice: '0', fundingRate: '0' },
    ],
  };
  const rows = parseArcus(data, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTC');
  close(rows[0].fundingHourly, 0.0000097);
  assert.equal(rows[0].volume24h, 121654392.53);
});

test('BULK: fundingRate は1h、exchangeInfo が TRADING のものだけ', () => {
  const stats = {
    markets: [
      { symbol: 'BTC-USD', quoteVolume: 11464880.9, fundingRate: 0.0000125, markPrice: 85062.99 },
      { symbol: 'AAVE-USD', quoteVolume: 1, fundingRate: 0.0000125, markPrice: 200 },
    ],
  };
  const info = [{ symbol: 'BTC-USD', status: 'TRADING' }, { symbol: 'AAVE-USD', status: 'SUSPENDED' }];
  const rows = parseBulk(stats, info, 1);
  assert.deepEqual(rows.map((r) => r.symbol), ['BTC']);
  close(rows[0].fundingHourly, BASE_HOURLY);
  // exchangeInfo が取れなかったときは全部使う
  assert.equal(parseBulk(stats, [], 1).length, 2);
});

test('Ondo Perps: -USD.P を正規化、価格は板の仲値、disabled は除外', () => {
  const data = {
    result: [
      { market: 'BTC-USD.P', productType: 'perpetual', disabled: false, lastPrice: '85057', bid: '85059', ask: '85061', indexPrice: '85094', fundingRate: '0.0000125', nextFundingRate: '0.00002', usdVolume: '5105946.19' },
      { market: 'OLD-USD.P', productType: 'perpetual', disabled: true, lastPrice: '1', fundingRate: '0' },
    ],
  };
  const rows = parseOndo(data, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTC');
  assert.equal(rows[0].price, 85060);
  close(rows[0].fundingHourly, 0.00002);
  assert.equal(rows[0].volume24h, 5105946.19);
});

test('SoDEX: symbols の fundingInterval(秒) を使い、HALT は除外', () => {
  const tickers = {
    data: [
      { symbol: 'XLM-USD', markPrice: '0.21665', fundingRate: '0.0000125', quoteVolume: '1000' },
      { symbol: 'ABC-USD', markPrice: '1', fundingRate: '0.0008', quoteVolume: '1' },
      { symbol: 'HALTED-USD', markPrice: '1', fundingRate: '0' },
    ],
  };
  const symbols = {
    data: [
      { name: 'XLM-USD', fundingInterval: 3600, status: 'TRADING' },
      { name: 'ABC-USD', fundingInterval: 28800, status: 'TRADING' },
      { name: 'HALTED-USD', fundingInterval: 3600, status: 'HALT' },
    ],
  };
  const rows = parseSodex(tickers, symbols, 1);
  assert.deepEqual(rows.map((r) => r.symbol), ['XLM', 'ABC']);
  close(rows[0].fundingHourly, BASE_HOURLY);
  close(rows[1].fundingHourly, 0.0001);
});

test('PopDEX: funding-rate の精密な値と間隔を優先し、無ければ tickers の値', () => {
  const tickers = [
    {
      data: [
        { category: 'futures', symbol: 'BTCUSDT', markPrice: '85056', fundingRate: '0.000007', turnover24h: '14207809.9', status: 'Trading' },
        { category: 'futures', symbol: 'kPEPEUSDT', markPrice: '0.0043', fundingRate: '0.000012', turnover24h: '10', status: 'Trading' },
      ],
    },
  ];
  const funding = [{ data: [{ symbol: 'BTCUSDT', fundingRate: '0.0000632', fundingRateInterval: '8' }] }];
  const rows = parsePopdex(tickers, funding, 1);
  assert.deepEqual(rows.map((r) => r.symbol), ['BTC', '1000PEPE']);
  close(rows[0].fundingHourly, 0.0000079);
  close(rows[1].fundingHourly, 0.000012);
  assert.equal(rows[0].volume24h, 14207809.9);
});

test('fetchPages: cursor をたどって total まで取る', async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({ i }));
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const cursor = Number(u.searchParams.get('cursor'));
    const limit = Number(u.searchParams.get('limit'));
    return { data: all.slice(cursor, cursor + limit), cursor: String(cursor + limit), total: String(all.length) };
  };
  const pages = await fetchPages(fetchJson, 'https://x.test/a?category=Futures', 2);
  assert.equal(pages.flatMap((p) => p.data).length, 5);
  assert.equal(urls.length, 3);
});

test('想定外の形ならエラーにする', () => {
  assert.throws(() => parseVariational({}));
  assert.throws(() => parseNado(null, 24));
  assert.throws(() => parseDecibel([], {}, []));
  assert.throws(() => parseArcus({}, 1));
  assert.throws(() => parseBulk({}, [], 1));
  assert.throws(() => parseOndo({}, 1));
  assert.throws(() => parseSodex({}, null, 1));
  assert.throws(() => parsePopdex([{}], [], 1));
});
