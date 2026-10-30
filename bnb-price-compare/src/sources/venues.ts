import { fetchJson, toLevels } from '../http.ts';
import type { Book, Venue, VenueConfig } from '../types.ts';

/** 価格順に並べ直す（bids 高い順、asks 安い順） */
export function sortBook(book: Book): Book {
  return {
    bids: [...book.bids].sort((a, b) => b[0] - a[0]),
    asks: [...book.asks].sort((a, b) => a[0] - b[0]),
  };
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : undefined;
};

const bitbank: Venue = {
  id: 'bitbank',
  name: 'bitbank',
  kind: 'cex',
  quote: 'JPY',
  async fetch(cfg, timeoutMs) {
    const r = await fetchJson(`${cfg.base_url}/${cfg.pair ?? 'bnb_jpy'}/depth`, { timeoutMs });
    if (r.success !== 1) throw new Error(`bitbank error code ${r.data?.code}`);
    return { book: { bids: toLevels(r.data.bids), asks: toLevels(r.data.asks) } };
  },
};

const binanceJapan: Venue = {
  id: 'binance_japan',
  name: 'Binance Japan',
  kind: 'cex',
  quote: 'JPY',
  async fetch(cfg, timeoutMs) {
    const symbol = cfg.symbol ?? 'BNBJPY';
    const r = await fetchJson(`${cfg.base_url}/api/v3/depth?symbol=${symbol}&limit=100`, { timeoutMs });
    return { book: { bids: toLevels(r.bids), asks: toLevels(r.asks) } };
  },
};

const hyperliquid: Venue = {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  kind: 'perp',
  quote: 'USDC',
  async fetch(cfg, timeoutMs) {
    const coin = String(cfg.coin ?? 'BNB');
    const url = `${cfg.base_url}/info`;
    const [book, [meta, ctxs]] = await Promise.all([
      fetchJson(url, { method: 'POST', body: { type: 'l2Book', coin }, timeoutMs }),
      fetchJson(url, { method: 'POST', body: { type: 'metaAndAssetCtxs' }, timeoutMs }),
    ]);
    const i = meta.universe.findIndex((u: { name: string }) => u.name === coin);
    const ctx = i >= 0 ? ctxs[i] : undefined;
    const lv = (side: Array<{ px: string; sz: string }>) => toLevels(side.map((l) => [l.px, l.sz]));
    return {
      book: { bids: lv(book.levels[0]), asks: lv(book.levels[1]) },
      mark: num(ctx?.markPx),
      index: num(ctx?.oraclePx),
      fundingRate: num(ctx?.funding),
      fundingIntervalH: 1,
    };
  },
};

let asterIntervalH: number | undefined;
const aster: Venue = {
  id: 'aster',
  name: 'Aster',
  kind: 'perp',
  quote: 'USDT',
  async fetch(cfg, timeoutMs) {
    const symbol = String(cfg.symbol ?? 'BNBUSDT');
    const [depth, prem] = await Promise.all([
      fetchJson(`${cfg.base_url}/fapi/v1/depth?symbol=${symbol}&limit=100`, { timeoutMs }),
      fetchJson(`${cfg.base_url}/fapi/v1/premiumIndex?symbol=${symbol}`, { timeoutMs }),
    ]);
    if (asterIntervalH === undefined) {
      const info = await fetchJson(`${cfg.base_url}/fapi/v1/fundingInfo`, { timeoutMs }).catch(() => []);
      asterIntervalH = num(info.find?.((x: { symbol: string }) => x.symbol === symbol)?.fundingIntervalHours) ?? 8;
    }
    return {
      book: { bids: toLevels(depth.bids), asks: toLevels(depth.asks) },
      mark: num(prem.markPrice),
      index: num(prem.indexPrice),
      fundingRate: num(prem.lastFundingRate),
      fundingIntervalH: asterIntervalH,
    };
  },
};

const lighterMarket = new Map<string, number>();
const lighter: Venue = {
  id: 'lighter',
  name: 'Lighter',
  kind: 'perp',
  quote: 'USDC',
  async fetch(cfg, timeoutMs) {
    const symbol = String(cfg.symbol ?? 'BNB');
    let marketId = lighterMarket.get(symbol);
    if (marketId === undefined) {
      const d = await fetchJson(`${cfg.base_url}/api/v1/orderBookDetails`, { timeoutMs });
      const m = d.order_book_details?.find(
        (x: { symbol: string; market_type?: string }) => x.symbol === symbol && x.market_type !== 'spot',
      );
      if (!m) throw new Error(`market ${symbol} not found`);
      marketId = Number(m.market_id);
      lighterMarket.set(symbol, marketId);
    }
    const r = await fetchJson(`${cfg.base_url}/api/v1/orderBookOrders?market_id=${marketId}&limit=100`, {
      timeoutMs,
    });
    const lv = (side: Array<{ price: string; remaining_base_amount: string }>) =>
      toLevels((side ?? []).map((o) => [o.price, o.remaining_base_amount]));
    return { book: { bids: lv(r.bids), asks: lv(r.asks) } };
  },
};

const dydx: Venue = {
  id: 'dydx',
  name: 'dYdX',
  kind: 'perp',
  quote: 'USD',
  async fetch(cfg, timeoutMs) {
    const ticker = String(cfg.ticker ?? 'BNB-USD');
    const [ob, mk] = await Promise.all([
      fetchJson(`${cfg.base_url}/v4/orderbooks/perpetualMarket/${ticker}`, { timeoutMs }),
      fetchJson(`${cfg.base_url}/v4/perpetualMarkets?ticker=${ticker}`, { timeoutMs }),
    ]);
    const m = mk.markets?.[ticker];
    const lv = (side: Array<{ price: string; size: string }>) => toLevels(side.map((l) => [l.price, l.size]));
    return {
      book: { bids: lv(ob.bids), asks: lv(ob.asks) },
      index: num(m?.oraclePrice),
      fundingRate: num(m?.nextFundingRate),
      fundingIntervalH: 1,
    };
  },
};

const paradex: Venue = {
  id: 'paradex',
  name: 'Paradex',
  kind: 'perp',
  quote: 'USD',
  async fetch(cfg, timeoutMs) {
    const market = String(cfg.market ?? 'BNB-USD-PERP');
    const [ob, sum] = await Promise.all([
      fetchJson(`${cfg.base_url}/v1/orderbook/${market}?depth=50`, { timeoutMs }),
      fetchJson(`${cfg.base_url}/v1/markets/summary?market=${market}`, { timeoutMs }),
    ]);
    const s = sum.results?.[0];
    return {
      book: { bids: toLevels(ob.bids), asks: toLevels(ob.asks) },
      mark: num(s?.mark_price),
      index: num(s?.underlying_price),
      fundingRate: num(s?.funding_rate),
      // Paradex の funding_rate は8時間あたりの率（funding_period_hours = 8）
      fundingIntervalH: 8,
    };
  },
};

const extended: Venue = {
  id: 'extended',
  name: 'Extended',
  kind: 'perp',
  quote: 'USD',
  async fetch(cfg, timeoutMs) {
    const market = String(cfg.market ?? 'BNB-USD');
    const [ob, mk] = await Promise.all([
      fetchJson(`${cfg.base_url}/api/v1/info/markets/${market}/orderbook`, { timeoutMs }),
      fetchJson(`${cfg.base_url}/api/v1/info/markets?market=${market}`, { timeoutMs }),
    ]);
    const st = mk.data?.[0]?.marketStats;
    const lv = (side: Array<{ price: string; qty: string }>) => toLevels((side ?? []).map((l) => [l.price, l.qty]));
    return {
      book: { bids: lv(ob.data?.bid), asks: lv(ob.data?.ask) },
      mark: num(st?.markPrice),
      index: num(st?.indexPrice),
      fundingRate: num(st?.fundingRate),
      fundingIntervalH: 1,
    };
  },
};

export const VENUES: Record<string, Venue> = Object.fromEntries(
  [bitbank, binanceJapan, hyperliquid, aster, lighter, dydx, paradex, extended].map((v) => [v.id, v]),
);

export function resolveVenues(cfgs: VenueConfig[]): Array<{ venue: Venue; cfg: VenueConfig }> {
  return cfgs
    .filter((c) => c.enabled)
    .map((cfg) => {
      const venue = VENUES[cfg.id];
      if (!venue) throw new Error(`config/venues.yaml: 未対応の取引所 id "${cfg.id}"`);
      return { venue, cfg };
    });
}
