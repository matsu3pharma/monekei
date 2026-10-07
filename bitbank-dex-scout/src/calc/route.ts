// 損失計算（純粋関数のみ。通信はしない）
//
// 1ルート（銘柄×チェーン×受け取りUSDC）について、投入額 X 円が最終的に何USDCになるかを計算する。
//   ① simulateBuy  : bitbank の板（asks）を食べて数量 Q と VWAP を出す（取引手数料込みで X 円に収まるように）
//   ② computeLoss  : 出金手数料・DEX見積り・ガス代を差し引いて R を出し、損失と内訳を円で出す
// ①と②の間で、呼び出し側が Q' = Q − W を使って DEX の見積りを取る。
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export type Level = [price: Decimal.Value, amount: Decimal.Value];
export interface OrderBook {
  asks: Level[]; // 安い順
  bids: Level[]; // 高い順
}
export type FeeMode = 'taker' | 'maker';

export type BuyResult =
  | {
      ok: true;
      mode: FeeMode;
      amountJpy: Decimal; // X
      feeRate: Decimal;
      notionalJpy: Decimal; // 約定代金 N（手数料を除いた分）
      feeJpy: Decimal; // X − N（メイカーのリベートなら負）
      quantity: Decimal; // Q
      vwap: Decimal; // N / Q
      bestAsk: Decimal;
      bestBid: Decimal;
      mid: Decimal; // (bestAsk + bestBid) / 2
      levelsUsed: number;
      slippage: Decimal; // VWAP / bestAsk − 1
    }
  | { ok: false; error: 'empty_book' | 'insufficient_liquidity'; amountJpy: Decimal; filledJpy?: Decimal; filledQuantity?: Decimal };

/**
 * 板を上から食べて、X 円（取引手数料込み）で買える数量を出す。
 * 手数料はクオート（円）建てで約定代金 N に対して feeRate を掛けるので、N × (1 + feeRate) = X → N = X / (1 + feeRate)。
 * メイカー想定では、最良買値に指値を置いて全量がその値段で約定したと仮定する（板は食べない）。
 */
export function simulateBuy(
  book: OrderBook,
  amountJpy: Decimal.Value,
  feeRate: Decimal.Value,
  mode: FeeMode = 'taker',
): BuyResult {
  const X = new Decimal(amountJpy);
  const r = new Decimal(feeRate);
  if (book.asks.length === 0 || book.bids.length === 0) return { ok: false, error: 'empty_book', amountJpy: X };

  const bestAsk = new Decimal(book.asks[0][0]);
  const bestBid = new Decimal(book.bids[0][0]);
  const mid = bestAsk.plus(bestBid).div(2);
  const N = X.div(r.plus(1));

  if (mode === 'maker') {
    const Q = N.div(bestBid);
    return {
      ok: true, mode, amountJpy: X, feeRate: r, notionalJpy: N, feeJpy: X.minus(N),
      quantity: Q, vwap: bestBid, bestAsk, bestBid, mid, levelsUsed: 0, slippage: bestBid.div(bestAsk).minus(1),
    };
  }

  let remaining = N;
  let Q = new Decimal(0);
  let levels = 0;
  for (const [p, a] of book.asks) {
    const price = new Decimal(p);
    const amount = new Decimal(a);
    const cost = price.mul(amount);
    levels++;
    if (cost.gte(remaining)) {
      Q = Q.plus(remaining.div(price));
      remaining = new Decimal(0);
      break;
    }
    Q = Q.plus(amount);
    remaining = remaining.minus(cost);
  }
  if (remaining.gt(0)) {
    return { ok: false, error: 'insufficient_liquidity', amountJpy: X, filledJpy: N.minus(remaining), filledQuantity: Q };
  }
  const vwap = N.div(Q);
  return {
    ok: true, mode, amountJpy: X, feeRate: r, notionalJpy: N, feeJpy: X.minus(N),
    quantity: Q, vwap, bestAsk, bestBid, mid, levelsUsed: levels, slippage: vwap.div(bestAsk).minus(1),
  };
}

/** Q' = Q − W。負なら 0（出金できない） */
export function netAfterWithdraw(quantity: Decimal.Value, withdrawFee: Decimal.Value): Decimal {
  return Decimal.max(new Decimal(quantity).minus(withdrawFee), 0);
}

export interface DexInput {
  /** DEXで受け取れるUSDC（DEX手数料・スリッページ込み、ガス代は含まない）= R0 */
  amountOut: Decimal.Value;
  /** スリッページなしのDEX単価（USDC/トークン）。不明なら null → DEXコストは価格乖離に含めて表示 */
  refPriceUsdc: Decimal.Value | null;
  /** ガス代（USDC換算） */
  gasUsdc: Decimal.Value;
}

export interface Breakdown {
  spreadSlippage: Decimal; // N − Q × mid
  tradingFee: Decimal; // X − N
  withdrawFee: Decimal; // W × mid
  priceGap: Decimal; // Q' × mid − Q' × P × USDJPY（国内外の価格乖離）
  dexCost: Decimal; // (Q' × P − R0) × USDJPY
  gas: Decimal; // (R0 − R) × USDJPY
}

export interface LossResult {
  amountJpy: Decimal;
  quantity: Decimal; // Q
  netQuantity: Decimal; // Q'
  amountOutBeforeGas: Decimal; // R0
  received: Decimal; // R（最終的に受け取るUSDC）
  receivedJpy: Decimal; // R × USDJPY
  lossJpy: Decimal; // X − R × USDJPY
  lossRate: Decimal; // lossJpy / X
  priceGapRate: Decimal | null; // VWAP / (P × USDJPY) − 1
  dexUnitPrice: Decimal | null; // P
  breakdown: Breakdown;
  withdrawExceedsQuantity: boolean;
  gasExceedsOutput: boolean;
}

/**
 * 損失と内訳を計算する。内訳の合計は必ず損失額と一致する：
 *   (X−N) + (N−QM) + WM + (Q'M − Q'P·FX) + (Q'P − R0)·FX + (R0 − R)·FX = X − R·FX
 * （Q' = Q − W > 0 のとき。Q' = 0 なら出金手数料が Q·M 全部を食い、以降は 0）
 * dex が null でよいのは Q' = 0 のときだけ。
 */
export function computeLoss(buy: Extract<BuyResult, { ok: true }>, withdrawFee: Decimal.Value, dex: DexInput | null, usdJpy: Decimal.Value): LossResult {
  const X = buy.amountJpy;
  const M = buy.mid;
  const fx = new Decimal(usdJpy);
  const W = new Decimal(withdrawFee);
  const Q = buy.quantity;
  const Qn = netAfterWithdraw(Q, W);
  const zero = new Decimal(0);

  const spreadSlippage = buy.notionalJpy.minus(Q.mul(M));
  const tradingFee = buy.feeJpy;

  if (Qn.isZero()) {
    const breakdown: Breakdown = { spreadSlippage, tradingFee, withdrawFee: Q.mul(M), priceGap: zero, dexCost: zero, gas: zero };
    return {
      amountJpy: X, quantity: Q, netQuantity: Qn, amountOutBeforeGas: zero, received: zero, receivedJpy: zero,
      lossJpy: X, lossRate: new Decimal(1), priceGapRate: null, dexUnitPrice: null, breakdown,
      withdrawExceedsQuantity: true, gasExceedsOutput: false,
    };
  }
  if (!dex) throw new Error('DEX見積りがありません');

  const R0 = new Decimal(dex.amountOut);
  const G = new Decimal(dex.gasUsdc);
  const R = Decimal.max(R0.minus(G), 0);
  // 単価が分からないときは「実際に約定した単価」を基準にする（= DEXコスト 0、全部を価格乖離に寄せる）
  const P = dex.refPriceUsdc != null ? new Decimal(dex.refPriceUsdc) : R0.div(Qn);

  const breakdown: Breakdown = {
    spreadSlippage,
    tradingFee,
    withdrawFee: W.mul(M),
    priceGap: Qn.mul(M).minus(Qn.mul(P).mul(fx)),
    dexCost: Qn.mul(P).minus(R0).mul(fx),
    gas: R0.minus(R).mul(fx),
  };
  const receivedJpy = R.mul(fx);
  const lossJpy = X.minus(receivedJpy);
  return {
    amountJpy: X, quantity: Q, netQuantity: Qn, amountOutBeforeGas: R0, received: R, receivedJpy,
    lossJpy, lossRate: lossJpy.div(X),
    priceGapRate: P.isZero() ? null : buy.vwap.div(P.mul(fx)).minus(1),
    dexUnitPrice: P, breakdown,
    withdrawExceedsQuantity: false, gasExceedsOutput: G.gt(R0),
  };
}

export function sumBreakdown(b: Breakdown): Decimal {
  return b.spreadSlippage.plus(b.tradingFee).plus(b.withdrawFee).plus(b.priceGap).plus(b.dexCost).plus(b.gas);
}
