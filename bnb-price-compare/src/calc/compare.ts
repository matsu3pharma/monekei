import type { Fx, Level, Quote, VenueResult } from '../types.ts';

export interface Fill {
  /** 平均約定価格（板の通貨建て） */
  avgPrice: number;
  /** 約定したBNB数量 */
  base: number;
  /** 約定した金額（板の通貨建て） */
  notional: number;
  /** 指定金額を板で埋めきれたか */
  complete: boolean;
}

/** 板を最良から順に食べ、指定金額（板の通貨建て）分を約定させたときの平均価格を出す */
export function fillNotional(levels: Level[], notional: number): Fill | undefined {
  let remaining = notional;
  let base = 0;
  let spent = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(size, remaining / price);
    base += take;
    spent += take * price;
    remaining -= take * price;
  }
  if (base === 0) return undefined;
  return { avgPrice: spent / base, base, notional: spent, complete: remaining <= notional * 1e-9 };
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Row {
  id: string;
  name: string;
  kind: 'cex' | 'perp';
  quote: Quote;
  ok: boolean;
  error?: string;
  /** 板の通貨建て */
  bid?: number;
  ask?: number;
  mid?: number;
  mark?: number;
  index?: number;
  midJpy?: number;
  midUsd?: number;
  spreadPct?: number;
  /** 基準価格（Perp DEXの仲値の中央値）からの乖離 */
  deviationPct?: number;
  /** 指定金額を成行で買う／売るときの平均価格（円換算、手数料前後） */
  buyJpy?: number;
  sellJpy?: number;
  buyJpyNet?: number;
  sellJpyNet?: number;
  buyComplete?: boolean;
  sellComplete?: boolean;
  takerFee: number;
  /** 資金調達率（8時間換算） */
  funding8h?: number;
  latencyMs?: number;
  warnings: string[];
}

export interface Comparison {
  amountJpy: number;
  fx: Fx;
  /** 基準価格：Perp DEXの仲値（USD）の中央値 */
  refUsd?: number;
  refJpy?: number;
  rows: Row[];
  bestBuy?: { id: string; name: string; priceJpy: number };
  bestSell?: { id: string; name: string; priceJpy: number };
  /** 最安で買って最高値で売ったときの差（手数料込み、送金コスト・為替コストは含まない） */
  gapPct?: number;
  ts: number;
}

const STALE_FEE_DAYS = 30;

export function buildComparison(results: VenueResult[], fx: Fx, amountJpy: number, now = Date.now()): Comparison {
  const rows: Row[] = results.map((r) => {
    const base = {
      id: r.venue.id,
      name: r.venue.name,
      kind: r.venue.kind,
      quote: r.venue.quote,
      takerFee: r.cfg.taker_fee,
      warnings: [] as string[],
    };
    if (r.cfg.fee_checked_at) {
      const days = (now - Date.parse(r.cfg.fee_checked_at)) / 86_400_000;
      if (days > STALE_FEE_DAYS) base.warnings.push(`手数料の確認が${Math.floor(days)}日前`);
    }
    if (!r.ok) return { ...base, ok: false, error: r.error };

    const { book } = r.data;
    const bid = book.bids[0]?.[0];
    const ask = book.asks[0]?.[0];
    if (bid === undefined || ask === undefined) return { ...base, ok: false, error: '板が空' };

    const toJpy = r.venue.quote === 'JPY' ? 1 : fx.mid;
    const mid = (bid + ask) / 2;
    const notional = amountJpy / toJpy;
    const buy = fillNotional(book.asks, notional);
    const sell = fillNotional(book.bids, notional);
    const spreadPct = (ask - bid) / mid;
    if (spreadPct > 0.005) base.warnings.push('スプレッドが広い');
    if (buy && !buy.complete) base.warnings.push('買い板が金額に足りない');
    if (sell && !sell.complete) base.warnings.push('売り板が金額に足りない');

    const funding8h =
      r.data.fundingRate !== undefined && r.data.fundingIntervalH
        ? (r.data.fundingRate * 8) / r.data.fundingIntervalH
        : undefined;

    return {
      ...base,
      ok: true,
      bid,
      ask,
      mid,
      mark: r.data.mark,
      index: r.data.index,
      midJpy: mid * toJpy,
      midUsd: (mid * toJpy) / fx.mid,
      spreadPct,
      buyJpy: buy && buy.avgPrice * toJpy,
      sellJpy: sell && sell.avgPrice * toJpy,
      buyJpyNet: buy && buy.avgPrice * toJpy * (1 + r.cfg.taker_fee),
      sellJpyNet: sell && sell.avgPrice * toJpy * (1 - r.cfg.taker_fee),
      buyComplete: buy?.complete,
      sellComplete: sell?.complete,
      funding8h,
      latencyMs: r.latencyMs,
    };
  });

  const okRows = rows.filter((r) => r.ok && r.midUsd !== undefined);
  const perpMids = okRows.filter((r) => r.kind === 'perp').map((r) => r.midUsd!);
  const refUsd = median(perpMids.length ? perpMids : okRows.map((r) => r.midUsd!));
  const refJpy = refUsd !== undefined ? refUsd * fx.mid : undefined;
  for (const r of okRows) if (refJpy) r.deviationPct = r.midJpy! / refJpy - 1;

  const buyable = okRows.filter((r) => r.buyComplete && r.buyJpyNet !== undefined);
  const sellable = okRows.filter((r) => r.sellComplete && r.sellJpyNet !== undefined);
  const b = buyable.sort((x, y) => x.buyJpyNet! - y.buyJpyNet!)[0];
  const s = sellable.sort((x, y) => y.sellJpyNet! - x.sellJpyNet!)[0];

  return {
    amountJpy,
    fx,
    refUsd,
    refJpy,
    rows,
    bestBuy: b && { id: b.id, name: b.name, priceJpy: b.buyJpyNet! },
    bestSell: s && { id: s.id, name: s.name, priceJpy: s.sellJpyNet! },
    gapPct: b && s && b.id !== s.id ? s.sellJpyNet! / b.buyJpyNet! - 1 : undefined,
    ts: now,
  };
}
