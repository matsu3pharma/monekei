// bitbank 公開API（キー不要）
//   https://github.com/bitbankinc/bitbank-api-docs/blob/master/public-api_JP.md
//   https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api_JP.md（/spot/pairs, /spot/status）
import { fetchJson, TtlCache } from '../http.js';
import type { OrderBook } from '../calc/route.js';

const PUBLIC = 'https://public.bitbank.cc';
const API = 'https://api.bitbank.cc/v1';
const INTERVAL = 150; // bitbank 公開APIへのリクエスト間隔

export interface PairInfo {
  name: string; // eth_jpy
  base: string; // eth
  quote: string; // jpy
  takerFee: string; // taker_fee_rate_quote
  makerFee: string; // maker_fee_rate_quote
  isEnabled: boolean;
  stopBuy: boolean; // stop_order || stop_buy_order
  status?: string; // /spot/status の status（NORMAL など）
  minAmount?: string;
}

interface BitbankResponse<T> {
  success: 0 | 1;
  data: T;
}

function unwrap<T>(r: BitbankResponse<T>, what: string): T {
  if (r.success !== 1) throw new Error(`bitbank ${what} がエラーを返しました: ${JSON.stringify(r.data)}`);
  return r.data;
}

const pairsCache = new TtlCache<PairInfo[]>(5 * 60_000);
const depthCache = new TtlCache<OrderBook & { timestamp: number }>(5_000); // 板は数秒だけキャッシュ

export function getPairs(): Promise<PairInfo[]> {
  return pairsCache.get('pairs', async () => {
    const [pairsRes, statusRes] = await Promise.all([
      fetchJson<BitbankResponse<{ pairs: any[] }>>(`${API}/spot/pairs`, { minIntervalMs: INTERVAL }),
      fetchJson<BitbankResponse<{ statuses: any[] }>>(`${API}/spot/status`, { minIntervalMs: INTERVAL }).catch(() => null),
    ]);
    const statuses = new Map<string, any>();
    if (statusRes?.success === 1) for (const s of statusRes.data.statuses) statuses.set(s.pair, s);
    return unwrap(pairsRes, 'spot/pairs').pairs.map((p) => ({
      name: p.name,
      base: p.base_asset,
      quote: p.quote_asset,
      takerFee: p.taker_fee_rate_quote,
      makerFee: p.maker_fee_rate_quote,
      isEnabled: p.is_enabled,
      stopBuy: Boolean(p.stop_order || p.stop_buy_order),
      status: statuses.get(p.name)?.status,
      minAmount: statuses.get(p.name)?.min_amount,
    }));
  });
}

export function getDepth(pair: string): Promise<OrderBook & { timestamp: number }> {
  return depthCache.get(pair, async () => {
    const r = await fetchJson<BitbankResponse<{ asks: [string, string][]; bids: [string, string][]; timestamp: number }>>(
      `${PUBLIC}/${pair}/depth`,
      { minIntervalMs: INTERVAL },
    );
    const d = unwrap(r, `${pair}/depth`);
    return { asks: d.asks, bids: d.bids, timestamp: d.timestamp };
  });
}
