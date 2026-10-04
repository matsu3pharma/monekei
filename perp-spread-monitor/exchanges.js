'use strict';
// DEXごとのアダプタと銘柄名の正規化。
// 各アダプタは「取得(fetch)」と「解析(parse)」を分けている。parse は純粋関数なのでテストできる。
// DEX を追加するときは ADAPTERS に1つ追加し、config.json の exchanges にキーを足すだけでよい。

const SUFFIXES = ['-USD-PERP', '-PERP', '/USDC', '-USDC', '-USDT', '-USD', 'USDT', 'USDC'];

function normalizeSymbol(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  // Hyperliquid の kPEPE 形式（先頭が小文字の k + 大文字）は 1000PEPE
  const k = /^k([A-Z0-9]+)$/.exec(s);
  if (k) s = '1000' + k[1];
  s = s.toUpperCase();
  for (const suf of SUFFIXES) {
    if (s.length > suf.length && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
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
};
