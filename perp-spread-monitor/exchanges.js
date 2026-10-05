'use strict';
// DEXごとのアダプタと銘柄名の正規化。
// 各アダプタは「取得(fetch)」と「解析(parse)」を分けている。parse は純粋関数なのでテストできる。
// DEX を追加するときは ADAPTERS に1つ追加し、config.json の exchanges にキーを足すだけでよい。

// 長いものから順に照合する（'-USD-PERP' を '-USD' より先に、など）
const SUFFIXES = ['-PERP_USDT0', '-USD-PERP', '-USD.P', '-PERP', '/USDC', '/USD', '-USDC', '-USDT', '-USD', 'USDT', 'USDC'];

function normalizeSymbol(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  const upper = s.toUpperCase();
  for (const suf of SUFFIXES) {
    if (upper.length > suf.length && upper.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  // Hyperliquid などの kPEPE 形式（先頭が小文字の k + 大文字）は 1000PEPE
  const k = /^k([A-Z0-9]+)$/.exec(s);
  if (k) s = '1000' + k[1];
  return s.toUpperCase();
}

function num(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function firstNum(...xs) {
  for (const x of xs) {
    const n = num(x);
    if (n != null && n > 0) return n;
  }
  return null;
}

// rate: DEXの生のFR、intervalHours: そのFRが何時間あたりか
function makeRow(raw, price, rate, intervalHours, volume24h) {
  const fundingRaw = num(rate);
  const h = num(intervalHours);
  return {
    symbol: normalizeSymbol(raw),
    raw: String(raw),
    price,
    fundingHourly: fundingRaw != null && h > 0 ? fundingRaw / h : null,
    volume24h: num(volume24h),
    fundingRaw,
    intervalHours: h,
  };
}

// ---------- Hyperliquid ----------
function parseHyperliquid(data, intervalHours) {
  const [meta, ctxs] = data || [];
  if (!meta || !Array.isArray(meta.universe) || !Array.isArray(ctxs)) {
    throw new Error('Hyperliquid: 想定外のレスポンス形式');
  }
  const rows = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!u || u.isDelisted || !c) return;
    const price = firstNum(c.markPx, c.oraclePx, c.midPx);
    if (price == null) return;
    rows.push(makeRow(u.name, price, c.funding, intervalHours, c.dayNtlVlm));
  });
  return rows;
}

// ---------- dYdX v4 ----------
function parseDydx(data, intervalHours) {
  if (!data || typeof data.markets !== 'object') throw new Error('dYdX: 想定外のレスポンス形式');
  const rows = [];
  for (const [key, m] of Object.entries(data.markets)) {
    if (!m || m.status !== 'ACTIVE') continue;
    const price = firstNum(m.oraclePrice);
    if (price == null) continue;
    rows.push(makeRow(m.ticker || key, price, m.nextFundingRate, intervalHours, m.volume24H));
  }
  return rows;
}

// ---------- Aster (Binance互換) ----------
function parseAster(premium, fundingInfo, tickers, defaultIntervalHours) {
  if (!Array.isArray(premium)) throw new Error('Aster: premiumIndex が配列ではない');
  const intervals = new Map();
  for (const f of Array.isArray(fundingInfo) ? fundingInfo : []) {
    const h = num(f && f.fundingIntervalHours);
    if (h > 0) intervals.set(f.symbol, h);
  }
  const volumes = new Map();
  for (const t of Array.isArray(tickers) ? tickers : []) volumes.set(t.symbol, t.quoteVolume);
  const rows = [];
  for (const p of premium) {
    if (!p || typeof p.symbol !== 'string' || !p.symbol.endsWith('USDT')) continue;
    const price = firstNum(p.markPrice, p.indexPrice);
    if (price == null) continue;
    const h = intervals.get(p.symbol) ?? defaultIntervalHours;
    rows.push(makeRow(p.symbol, price, p.lastFundingRate, h, volumes.get(p.symbol)));
  }
  return rows;
}

// ---------- Lighter ----------
function parseLighter(fundingRates, orderBooks, intervalHours) {
  const details = (orderBooks && (orderBooks.order_book_details || orderBooks.orderBookDetails)) || null;
  if (!Array.isArray(details)) throw new Error('Lighter: order_book_details が見つからない');
  const list = (fundingRates && fundingRates.funding_rates) || [];
  // funding-rates には他取引所(binance等)の値も混ざっているので lighter のみ使う
  const own = list.filter((r) => r && String(r.exchange).toLowerCase() === 'lighter');
  const byId = new Map();
  const bySymbol = new Map();
  for (const r of own) {
    if (r.market_id != null) byId.set(Number(r.market_id), r.rate);
    if (r.symbol != null) bySymbol.set(String(r.symbol), r.rate);
  }
  const rows = [];
  for (const d of details) {
    if (!d || String(d.status).toLowerCase() !== 'active') continue;
    if (d.market_type && d.market_type !== 'perp') continue;
    const price = firstNum(d.mark_price, d.last_trade_price);
    if (price == null) continue;
    const rate = byId.has(Number(d.market_id)) ? byId.get(Number(d.market_id)) : bySymbol.get(String(d.symbol));
    rows.push(makeRow(d.symbol, price, rate, intervalHours, d.daily_quote_token_volume));
  }
  return rows;
}

// ---------- Paradex ----------
function parseParadex(summary, markets, defaultIntervalHours) {
  const results = summary && summary.results;
  if (!Array.isArray(results)) throw new Error('Paradex: results が見つからない');
  // /v1/markets に funding_period_hours があれば銘柄ごとにそれを使う
  const periods = new Map();
  for (const m of (markets && Array.isArray(markets.results) && markets.results) || []) {
    const h = num(m && m.funding_period_hours);
    if (h > 0) periods.set(m.symbol, h);
  }
  const rows = [];
  for (const r of results) {
    if (!r || typeof r.symbol !== 'string' || !r.symbol.endsWith('-USD-PERP')) continue;
    const price = firstNum(r.mark_price, r.underlying_price, r.last_traded_price);
    if (price == null) continue;
    const h = periods.get(r.symbol) ?? defaultIntervalHours;
    rows.push(makeRow(r.symbol, price, r.funding_rate, h, r.volume_24h));
  }
  return rows;
}

// ---------- Variational Omni ----------
// funding_rate は「年率」の小数（例: 0.1095 = 年10.95% = 8hあたり0.01%）。
// funding_interval_s は支払い間隔で、レートの単位ではない。
const HOURS_PER_YEAR = 24 * 365;
// 価格について: mark_price は数分に1回しか更新されない（2026-10 実測: 6分で1回）。
// quotes の bid/ask は約1分ごとに更新されるので、その中間値を使い、quotes.updated_at から価格の古さも記録する。
function parseVariational(data, now = Date.now()) {
  const listings = data && data.listings;
  if (!Array.isArray(listings)) throw new Error('Variational: listings が見つからない');
  const rows = [];
  for (const l of listings) {
    if (!l || typeof l.ticker !== 'string') continue;
    // funding_interval_s = 0 は市場休止中の RWA（FR=0・価格固定）なので除外
    if (!(num(l.funding_interval_s) > 0)) continue;
    const q = l.quotes || {};
    const bid = num(q.base && q.base.bid);
    const ask = num(q.base && q.base.ask);
    const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null;
    const price = firstNum(mid, l.mark_price);
    if (price == null) continue;
    const row = makeRow(l.ticker, price, l.funding_rate, HOURS_PER_YEAR, l.volume_24h);
    const updated = mid != null ? Date.parse(q.updated_at) : NaN;
    if (Number.isFinite(updated)) row.priceAgeMs = Math.max(0, now - updated);
    rows.push(row);
  }
  return rows;
}

// ---------- Nado (Vertex 系) ----------
// /archive/v2/contracts の funding_rate は「24時間あたり」（公式: hourly = /24）
function parseNado(data, intervalHours) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Nado: 想定外のレスポンス形式');
  const rows = [];
  for (const c of Object.values(data)) {
    if (!c || c.product_type !== 'perpetual' || typeof c.base_currency !== 'string') continue;
    const price = firstNum(c.mark_price, c.last_price, c.index_price);
    if (price == null) continue;
    rows.push(makeRow(c.base_currency, price, c.funding_rate, intervalHours, c.quote_volume));
  }
  return rows;
}

// ---------- Decibel (Aptos) ----------
// /prices の funding_rate_bps は「1時間あたり・bps」。符号は is_funding_positive で持つ。
function parseDecibel(markets, prices, contexts) {
  if (!Array.isArray(prices)) throw new Error('Decibel: prices が配列ではない');
  const names = new Map();
  for (const m of Array.isArray(markets) ? markets : []) {
    if (m && m.market_addr) names.set(m.market_addr, m.market_name);
  }
  const volumes = new Map();
  for (const c of Array.isArray(contexts) ? contexts : []) {
    if (c && c.market) volumes.set(c.market, c.volume_24h);
  }
  const rows = [];
  for (const p of prices) {
    if (!p || !p.market) continue;
    const name = names.get(p.market);
    if (!name) continue;
    const price = firstNum(p.mark_px, p.mid_px, p.oracle_px);
    if (price == null) continue;
    const bps = num(p.funding_rate_bps);
    const rate = bps == null ? null : (p.is_funding_positive === false ? -1 : 1) * Math.abs(bps) / 10000;
    rows.push(makeRow(name, price, rate, 1, volumes.get(p.market)));
  }
  return rows;
}

// ---------- Arcus ----------
// fundingRate / nextFundingRate は「1時間あたり」（基準 0.0000125 = 8hあたり0.01%）
function parseArcus(data, intervalHours) {
  const markets = data && data.markets;
  if (!Array.isArray(markets)) throw new Error('Arcus: markets が見つからない');
  const rows = [];
  for (const m of markets) {
    if (!m || m.status !== 'ONLINE' || (m.type && m.type !== 'PERPETUAL')) continue;
    const price = firstNum(m.markPrice, m.oraclePrice, m.lastTradePrice);
    if (price == null) continue;
    const rate = num(m.nextFundingRate) ?? num(m.fundingRate);
    rows.push(makeRow(m.marketDisplayName || m.baseAsset, price, rate, intervalHours, m.volume24hNotional));
  }
  return rows;
}

// ---------- BULK ----------
// /stats の markets[].fundingRate は「1時間あたり」（fundingRateAnnualized = ×8760 と一致）
function parseBulk(stats, exchangeInfo, intervalHours) {
  const markets = stats && stats.markets;
  if (!Array.isArray(markets)) throw new Error('BULK: markets が見つからない');
  const status = new Map();
  for (const i of Array.isArray(exchangeInfo) ? exchangeInfo : []) {
    if (i && i.symbol) status.set(i.symbol, i.status);
  }
  const rows = [];
  for (const m of markets) {
    if (!m || typeof m.symbol !== 'string') continue;
    // exchangeInfo が取れたときは TRADING のものだけ
    if (status.size && status.get(m.symbol) !== 'TRADING') continue;
    const price = firstNum(m.markPrice, m.lastPrice);
    if (price == null) continue;
    rows.push(makeRow(m.symbol, price, m.fundingRate, intervalHours, m.quoteVolume));
  }
  return rows;
}

// ---------- Ondo Perps ----------
// /v1/perps/contracts。FRは毎時。nextFundingRate（今の時間の予想値）を優先する。
// マーク価格が無いので、板の仲値 → 最終約定 → インデックス価格の順で使う。
function parseOndo(data, intervalHours) {
  const list = data && data.result;
  if (!Array.isArray(list)) throw new Error('Ondo Perps: result が見つからない');
  const rows = [];
  for (const c of list) {
    if (!c || c.disabled || c.productType !== 'perpetual' || typeof c.market !== 'string') continue;
    const bid = num(c.bid);
    const ask = num(c.ask);
    const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null;
    const price = firstNum(mid, c.lastPrice, c.indexPrice);
    if (price == null) continue;
    const rate = num(c.nextFundingRate) ?? num(c.fundingRate);
    rows.push(makeRow(c.market, price, rate, intervalHours, c.usdVolume ?? c.quoteVolume));
  }
  return rows;
}

// ---------- SoDEX ----------
// /perps/markets/tickers。fundingRate は1回の支払い（symbols の fundingInterval 秒）あたり。現状は全銘柄3600秒。
function parseSodex(tickers, symbols, defaultIntervalHours) {
  const list = tickers && tickers.data;
  if (!Array.isArray(list)) throw new Error('SoDEX: data が見つからない');
  const info = new Map();
  for (const s of (symbols && Array.isArray(symbols.data) && symbols.data) || []) {
    if (s && s.name) info.set(s.name, s);
  }
  const rows = [];
  for (const t of list) {
    if (!t || typeof t.symbol !== 'string') continue;
    const s = info.get(t.symbol);
    if (s && s.status && s.status !== 'TRADING') continue;
    const price = firstNum(t.markPrice, t.lastPx, t.indexPrice);
    if (price == null) continue;
    const sec = num(s && s.fundingInterval);
    const h = sec > 0 ? sec / 3600 : defaultIntervalHours;
    rows.push(makeRow(t.symbol, price, t.fundingRate, h, t.quoteVolume));
  }
  return rows;
}

// ---------- PopDEX ----------
// tickers の fundingRate は小数6桁に丸められているので、/market/funding-rate の値（と間隔）を優先する。
// fundingRate は1回の支払い（fundingRateInterval 時間）あたり。
function parsePopdex(tickerPages, fundingPages, defaultIntervalHours) {
  const tickers = tickerPages.flatMap((p) => (p && Array.isArray(p.data) ? p.data : []));
  if (!tickerPages.length || !tickerPages.every((p) => p && Array.isArray(p.data))) {
    throw new Error('PopDEX: tickers の data が見つからない');
  }
  const funding = new Map();
  for (const f of fundingPages.flatMap((p) => (p && Array.isArray(p.data) ? p.data : []))) {
    if (f && f.symbol) funding.set(f.symbol, f);
  }
  const rows = [];
  for (const t of tickers) {
    if (!t || typeof t.symbol !== 'string' || String(t.category).toLowerCase() !== 'futures') continue;
    if (t.status && t.status !== 'Trading') continue;
    const price = firstNum(t.markPrice, t.lastPrice, t.indexPrice);
    if (price == null) continue;
    const f = funding.get(t.symbol);
    const rate = f ? f.fundingRate : t.fundingRate;
    const h = num(f && f.fundingRateInterval) > 0 ? num(f.fundingRateInterval) : defaultIntervalHours;
    rows.push(makeRow(t.symbol, price, rate, h, t.turnover24h));
  }
  return rows;
}

// cursor 方式のページングをまとめて取る（最大 maxPages ページ）
async function fetchPages(fetchJson, url, limit, maxPages = 10) {
  const pages = [];
  let cursor = '0';
  for (let i = 0; i < maxPages; i++) {
    const sep = url.includes('?') ? '&' : '?';
    const page = await fetchJson(`${url}${sep}limit=${limit}&cursor=${encodeURIComponent(cursor)}`);
    pages.push(page);
    const n = page && Array.isArray(page.data) ? page.data.length : 0;
    const next = page && page.cursor != null ? String(page.cursor) : null;
    const total = num(page && page.total);
    const seen = pages.reduce((a, p) => a + (p && Array.isArray(p.data) ? p.data.length : 0), 0);
    if (n < limit || next == null || next === cursor || (total != null && seen >= total)) break;
    cursor = next;
  }
  return pages;
}

const ADAPTERS = {
  hyperliquid: {
    label: 'Hyperliquid',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const data = await fetchJson('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      return parseHyperliquid(data, intervalHours);
    },
  },
  dydx: {
    label: 'dYdX',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const data = await fetchJson('https://indexer.dydx.trade/v4/perpetualMarkets');
      return parseDydx(data, intervalHours);
    },
  },
  aster: {
    label: 'Aster',
    defaultIntervalHours: 8,
    async fetch({ fetchJson, intervalHours }) {
      const base = 'https://fapi.asterdex.com/fapi/v1';
      const [premium, info, tickers] = await Promise.all([
        fetchJson(`${base}/premiumIndex`),
        // fundingInfo が取れなくても全体は止めない（全銘柄 intervalHours 扱いになる）
        fetchJson(`${base}/fundingInfo`).catch(() => []),
        fetchJson(`${base}/ticker/24hr`).catch(() => []),
      ]);
      return parseAster(premium, info, tickers, intervalHours);
    },
  },
  lighter: {
    label: 'Lighter',
    defaultIntervalHours: 8,
    async fetch({ fetchJson, intervalHours }) {
      const base = 'https://mainnet.zklighter.elliot.ai/api/v1';
      const [fr, ob] = await Promise.all([
        fetchJson(`${base}/funding-rates`),
        fetchJson(`${base}/orderBookDetails?filter=perp`),
      ]);
      return parseLighter(fr, ob, intervalHours);
    },
  },
  paradex: {
    label: 'Paradex',
    defaultIntervalHours: 8,
    async fetch({ fetchJson, intervalHours }) {
      const base = 'https://api.prod.paradex.trade/v1';
      const [summary, markets] = await Promise.all([
        fetchJson(`${base}/markets/summary?market=ALL`),
        fetchJson(`${base}/markets`).catch(() => null),
      ]);
      return parseParadex(summary, markets, intervalHours);
    },
  },
  variational: {
    label: 'Variational',
    // APIのFRが年率なので「8760時間あたり」として扱う（config で変える必要はない）
    defaultIntervalHours: HOURS_PER_YEAR,
    async fetch({ fetchJson }) {
      const data = await fetchJson('https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats');
      return parseVariational(data);
    },
  },
  nado: {
    label: 'Nado',
    defaultIntervalHours: 24,
    async fetch({ fetchJson, intervalHours }) {
      const data = await fetchJson('https://api.prod.nado.xyz/archive/v2/contracts');
      return parseNado(data, intervalHours);
    },
  },
  arcus: {
    label: 'Arcus',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const data = await fetchJson('https://api.arcus.xyz/v1/markets');
      return parseArcus(data, intervalHours);
    },
  },
  bulk: {
    label: 'BULK',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const base = 'https://mainnet-api1.bulk.trade/api/v1';
      const [stats, info] = await Promise.all([
        fetchJson(`${base}/stats`),
        fetchJson(`${base}/exchangeInfo`).catch(() => []),
      ]);
      return parseBulk(stats, info, intervalHours);
    },
  },
  ondo: {
    label: 'Ondo Perps',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const data = await fetchJson('https://api.ondoperps.xyz/v1/perps/contracts');
      return parseOndo(data, intervalHours);
    },
  },
  sodex: {
    label: 'SoDEX',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const base = 'https://mainnet-gw.sodex.dev/api/v1/perps/markets';
      const [tickers, symbols] = await Promise.all([
        fetchJson(`${base}/tickers`),
        fetchJson(`${base}/symbols`).catch(() => null),
      ]);
      return parseSodex(tickers, symbols, intervalHours);
    },
  },
  popdex: {
    label: 'PopDEX',
    defaultIntervalHours: 1,
    async fetch({ fetchJson, intervalHours }) {
      const base = 'https://api.popdex.xyz/api/v1';
      const [tickers, funding] = await Promise.all([
        fetchPages(fetchJson, `${base}/public/market/tickers?category=Futures`, 100),
        fetchPages(fetchJson, `${base}/market/funding-rate`, 100).catch(() => []),
      ]);
      return parsePopdex(tickers, funding, intervalHours);
    },
  },
  decibel: {
    label: 'Decibel',
    defaultIntervalHours: 1,
    // API キー（Geomi の Bearer トークン）が必須。config.json の exchanges.decibel.apiKey に入れると有効になる
    defaultEnabled: false,
    requiresApiKey: true,
    async fetch({ fetchJson, config }) {
      const key = config && config.apiKey;
      if (!key) throw new Error('APIキー未設定（config.json の exchanges.decibel.apiKey）');
      const base = 'https://api.mainnet.aptoslabs.com/decibel/api/v1';
      const init = { headers: { authorization: `Bearer ${key}`, origin: 'https://app.decibel.trade' } };
      const [markets, prices, contexts] = await Promise.all([
        fetchJson(`${base}/markets`, init),
        fetchJson(`${base}/prices`, init),
        fetchJson(`${base}/asset_contexts`, init).catch(() => []),
      ]);
      return parseDecibel(markets, prices, contexts);
    },
  },
};

function makeFetchJson(timeoutMs = 15000) {
  return async function fetchJson(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', 'user-agent': 'perp-spread-monitor/1.0', ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${url} ${body.slice(0, 120)}`);
    }
    return res.json();
  };
}

module.exports = {
  ADAPTERS,
  normalizeSymbol,
  makeFetchJson,
  parseHyperliquid,
  parseDydx,
  parseAster,
  parseLighter,
  parseParadex,
  parseVariational,
  parseNado,
  parseDecibel,
  parseArcus,
  parseBulk,
  parseOndo,
  parseSodex,
  parsePopdex,
  fetchPages,
};
