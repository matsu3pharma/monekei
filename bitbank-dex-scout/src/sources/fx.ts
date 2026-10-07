// USD/JPY。どれもAPIキー不要
//   frankfurter : https://frankfurter.dev  （ECBの参照レート。日次）
//   open-er-api : https://www.exchangerate-api.com/docs/free （日次。frankfurter が落ちたときの予備にもする）
//   manual      : routes.yaml の fx.manual_rate
import Decimal from 'decimal.js';
import { fetchJson, TtlCache } from '../http.js';

export interface FxRate {
  rate: Decimal;
  provider: string;
  asOf: string; // 提供元のレート基準時刻
}

export interface FxConfig {
  provider?: string;
  manual_rate?: number;
}

const cache = new TtlCache<FxRate>(10 * 60_000);

async function frankfurter(): Promise<FxRate> {
  const r = await fetchJson<{ date: string; rates: { JPY: number } }>('https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY');
  return { rate: new Decimal(r.rates.JPY), provider: 'frankfurter', asOf: r.date };
}

async function openErApi(): Promise<FxRate> {
  const r = await fetchJson<{ result: string; time_last_update_utc: string; rates: { JPY: number } }>('https://open.er-api.com/v6/latest/USD');
  if (r.result !== 'success') throw new Error('open-er-api がエラーを返しました');
  return { rate: new Decimal(r.rates.JPY), provider: 'open-er-api', asOf: r.time_last_update_utc };
}

const providers: Record<string, () => Promise<FxRate>> = { frankfurter, 'open-er-api': openErApi };

export function getUsdJpy(cfg: FxConfig = {}): Promise<FxRate> {
  const name = cfg.provider ?? 'frankfurter';
  if (name === 'manual') {
    if (!cfg.manual_rate) return Promise.reject(new Error('fx.manual_rate が設定されていません'));
    return Promise.resolve({ rate: new Decimal(cfg.manual_rate), provider: 'manual', asOf: '設定ファイル' });
  }
  const primary = providers[name];
  if (!primary) return Promise.reject(new Error(`未知の為替プロバイダ: ${name}`));
  return cache.get(name, async () => {
    try {
      return await primary();
    } catch (e) {
      // 第一候補が落ちたら他を試す（全体を止めない）
      for (const [other, fn] of Object.entries(providers)) {
        if (other === name) continue;
        try {
          return await fn();
        } catch {}
      }
      throw e;
    }
  });
}
