import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { computeLoss, netAfterWithdraw, simulateBuy, sumBreakdown, type OrderBook } from '../src/calc/route.js';

// 手計算できる板：売り 100円×10枚, 110円×10枚 ／ 買い 90円×5枚 → mid = 95
const book: OrderBook = {
  asks: [['100', '10'], ['110', '10']],
  bids: [['90', '5']],
};
const n = (d: Decimal | null) => (d == null ? null : d.toNumber());

function okBuy(...args: Parameters<typeof simulateBuy>) {
  const r = simulateBuy(...args);
  if (!r.ok) throw new Error(`buy failed: ${r.error}`);
  return r;
}

describe('simulateBuy', () => {
  it('1段目だけで足りる（手数料0）', () => {
    const b = okBuy(book, 1000, 0);
    expect(n(b.quantity)).toBe(10);
    expect(n(b.vwap)).toBe(100);
    expect(n(b.slippage)).toBe(0);
    expect(n(b.mid)).toBe(95);
    expect(b.levelsUsed).toBe(1);
  });

  it('2段目まで食べると VWAP が悪化する', () => {
    const b = okBuy(book, 1550, 0);
    // 1000円で10枚 + 550円/110円 = 5枚
    expect(n(b.quantity)).toBe(15);
    expect(b.vwap.toFixed(6)).toBe(new Decimal(1550).div(15).toFixed(6));
    expect(b.levelsUsed).toBe(2);
    expect(b.slippage.gt(0)).toBe(true);
  });

  it('テイカー手数料は円建てで差し引かれる（N × 1.0012 = X）', () => {
    const b = okBuy(book, 1001.2, 0.0012);
    expect(n(b.notionalJpy)).toBe(1000);
    expect(n(b.feeJpy)).toBeCloseTo(1.2, 12);
    expect(n(b.quantity)).toBe(10);
  });

  it('メイカー想定は最良買値で全量約定し、リベート分だけ多く買える', () => {
    const b = okBuy(book, 900, -0.0002, 'maker');
    expect(n(b.vwap)).toBe(90);
    expect(b.feeJpy.lt(0)).toBe(true);
    expect(b.quantity.toFixed(10)).toBe(new Decimal(900).div(0.9998).div(90).toFixed(10));
  });

  it('板が足りないケースは失敗として返し、約定できた分を報告する', () => {
    const b = simulateBuy(book, 5000, 0);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error).toBe('insufficient_liquidity');
    expect(n(b.filledJpy!)).toBe(2100);
    expect(n(b.filledQuantity!)).toBe(20);
  });

  it('板が空なら empty_book', () => {
    const b = simulateBuy({ asks: [], bids: [] }, 1000, 0);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toBe('empty_book');
  });
});

describe('computeLoss', () => {
  // X = 1001.2円, 手数料率 0.12% → N = 1000円, Q = 10枚
  // W = 1枚 → Q' = 9枚。DEX単価 P = 0.64 USDC, R0 = 5.7 USDC, ガス 0.1 USDC → R = 5.6 USDC
  // USDJPY = 150 → 受取 840円、損失 161.2円
  const buy = okBuy(book, 1001.2, 0.0012);
  const res = computeLoss(buy, 1, { amountOut: 5.7, refPriceUsdc: 0.64, gasUsdc: 0.1 }, 150);

  it('最終受取と損失額', () => {
    expect(n(res.netQuantity)).toBe(9);
    expect(n(res.received)).toBe(5.6);
    expect(n(res.receivedJpy)).toBe(840);
    expect(n(res.lossJpy)).toBeCloseTo(161.2, 10);
    expect(n(res.lossRate)).toBeCloseTo(161.2 / 1001.2, 12);
  });

  it('内訳（手計算）', () => {
    const b = res.breakdown;
    expect(n(b.tradingFee)).toBeCloseTo(1.2, 10); // X − N
    expect(n(b.spreadSlippage)).toBe(50); // 1000 − 10×95
    expect(n(b.withdrawFee)).toBe(95); // 1×95
    expect(n(b.priceGap)).toBe(-9); // 9×95 − 9×0.64×150 = 855 − 864
    expect(n(b.dexCost)).toBeCloseTo(9, 10); // (5.76 − 5.7)×150
    expect(n(b.gas)).toBeCloseTo(15, 10); // 0.1×150
  });

  it('内訳の合計が損失額と一致する', () => {
    expect(sumBreakdown(res.breakdown).minus(res.lossJpy).abs().lt(1e-20)).toBe(true);
  });

  it('価格乖離率 = VWAP / (P × USDJPY) − 1', () => {
    expect(n(res.priceGapRate)).toBeCloseTo(100 / 96 - 1, 12);
  });

  it('出金手数料が数量を上回るケース：受取0、損失=投入額、内訳の合計も一致', () => {
    const r = computeLoss(buy, 20, null, 150);
    expect(r.withdrawExceedsQuantity).toBe(true);
    expect(n(r.netQuantity)).toBe(0);
    expect(n(r.received)).toBe(0);
    expect(n(r.lossJpy)).toBeCloseTo(1001.2, 10);
    expect(n(r.lossRate)).toBe(1);
    expect(sumBreakdown(r.breakdown).minus(r.lossJpy).abs().lt(1e-20)).toBe(true);
  });

  it('出金手数料がちょうど数量と同じでも受取0', () => {
    expect(n(netAfterWithdraw(10, 10))).toBe(0);
    expect(n(netAfterWithdraw(10, 12))).toBe(0);
  });

  it('ガス代が受取を上回るケース：受取0、内訳の合計も一致', () => {
    const r = computeLoss(buy, 1, { amountOut: 0.05, refPriceUsdc: 0.64, gasUsdc: 0.1 }, 150);
    expect(r.gasExceedsOutput).toBe(true);
    expect(n(r.received)).toBe(0);
    expect(n(r.lossJpy)).toBeCloseTo(1001.2, 10);
    expect(sumBreakdown(r.breakdown).minus(r.lossJpy).abs().lt(1e-20)).toBe(true);
  });

  it('DEX単価が不明ならDEXコストは0として価格乖離に含める', () => {
    const r = computeLoss(buy, 1, { amountOut: 5.7, refPriceUsdc: null, gasUsdc: 0 }, 150);
    expect(n(r.breakdown.dexCost)).toBe(0);
    expect(sumBreakdown(r.breakdown).minus(r.lossJpy).abs().lt(1e-20)).toBe(true);
  });

  it('対象トークンがUSDCそのもの（スワップなし）なら R0 = Q\'、DEXコスト0', () => {
    const r = computeLoss(buy, 1, { amountOut: 9, refPriceUsdc: 1, gasUsdc: 0 }, 150);
    expect(n(r.received)).toBe(9);
    expect(n(r.breakdown.dexCost)).toBe(0);
    expect(n(r.lossJpy)).toBeCloseTo(1001.2 - 1350, 10);
  });

  it('DEX見積りなしで Q\' > 0 なら例外', () => {
    expect(() => computeLoss(buy, 1, null, 150)).toThrow();
  });
});
