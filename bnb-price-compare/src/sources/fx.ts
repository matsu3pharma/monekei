import { fetchJson } from '../http.ts';
import type { Fx } from '../types.ts';

type Provider = (timeoutMs: number) => Promise<Fx>;

/** GMOコイン 外国為替FX 公開API：リアルタイムのBid/Ask（キー不要） */
const gmo: Provider = async (timeoutMs) => {
  const r = await fetchJson('https://forex-api.coin.z.com/public/v1/ticker', { timeoutMs });
  const t = r.data?.find((x: { symbol: string }) => x.symbol === 'USD_JPY');
  if (!t) throw new Error('USD_JPY not found');
  const bid = Number(t.bid);
  const ask = Number(t.ask);
  return {
    mid: (bid + ask) / 2,
    bid,
    ask,
    source: 'GMOコイン FX',
    realtime: true,
    marketClosed: t.status !== 'OPEN',
    ts: Date.parse(t.timestamp) || Date.now(),
  };
};

/** open.er-api.com：1日1回更新（予備） */
const erapi: Provider = async (timeoutMs) => {
  const r = await fetchJson('https://open.er-api.com/v6/latest/USD', { timeoutMs });
  const jpy = Number(r.rates?.JPY);
  if (!Number.isFinite(jpy)) throw new Error('JPY rate not found');
  return { mid: jpy, source: 'open.er-api（日次）', realtime: false, ts: r.time_last_update_unix * 1000 };
};

const PROVIDERS: Record<string, Provider> = { gmo, erapi };

export async function fetchUsdJpy(order: string[], timeoutMs: number): Promise<Fx> {
  const errors: string[] = [];
  for (const name of order) {
    const p = PROVIDERS[name];
    if (!p) {
      errors.push(`${name}: 未対応`);
      continue;
    }
    try {
      return await p(timeoutMs);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`USD/JPYを取得できません（${errors.join(' / ')}）`);
}
