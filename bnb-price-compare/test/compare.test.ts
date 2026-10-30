import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComparison, fillNotional, median } from '../src/calc/compare.ts';
import { sortBook } from '../src/sources/venues.ts';
import type { Fx, Venue, VenueConfig, VenueData, VenueResult } from '../src/types.ts';

const close = (a: number | undefined, b: number, eps = 1e-6) =>
  assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('fillNotional: 1段目で足りる', () => {
  const f = fillNotional([[100, 10]], 500)!;
  close(f.avgPrice, 100);
  close(f.base, 5);
  assert.equal(f.complete, true);
});

test('fillNotional: 複数段をまたぐと平均価格が悪化する', () => {
  // 100×1 = 100円、残り 200円を 200で 1枚 → 平均 300/2 = 150
  const f = fillNotional([[100, 1], [200, 5]], 300)!;
  close(f.base, 2);
  close(f.avgPrice, 150);
  assert.equal(f.complete, true);
});

test('fillNotional: 板が足りないと complete=false', () => {
  const f = fillNotional([[100, 1]], 1000)!;
  close(f.notional, 100);
  assert.equal(f.complete, false);
});

test('fillNotional: 空の板は undefined', () => {
  assert.equal(fillNotional([], 100), undefined);
});

test('median', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('sortBook は最良価格を先頭にする', () => {
  const b = sortBook({ bids: [[1, 1], [3, 1], [2, 1]], asks: [[6, 1], [4, 1], [5, 1]] });
  assert.deepEqual(b.bids.map((l) => l[0]), [3, 2, 1]);
  assert.deepEqual(b.asks.map((l) => l[0]), [4, 5, 6]);
});

const fx: Fx = { mid: 150, source: 'test', realtime: true, ts: 0 };
const venue = (id: string, kind: 'cex' | 'perp', quote: Venue['quote']): Venue => ({
  id, name: id, kind, quote, fetch: async () => { throw new Error('unused'); },
});
const cfg = (id: string, taker_fee: number, fee_checked_at = '2026-10-30'): VenueConfig => ({
  id, enabled: true, taker_fee, fee_checked_at, base_url: '',
});
const ok = (v: Venue, c: VenueConfig, data: VenueData): VenueResult => ({ venue: v, cfg: c, ok: true, data, ts: 0, latencyMs: 1 });
const now = Date.parse('2026-10-30T00:00:00Z');

test('buildComparison: 円換算・乖離・手数料込み実効価格・最良ルート', () => {
  const results: VenueResult[] = [
    // 国内CEX：仲値 105,000円
    ok(venue('jp', 'cex', 'JPY'), cfg('jp', 0.001), { book: { bids: [[104_000, 10]], asks: [[106_000, 10]] } }),
    // Perp：仲値 $699 / $701 → 中央値 $700 = 105,000円
    ok(venue('p1', 'perp', 'USD'), cfg('p1', 0), { book: { bids: [[698, 100]], asks: [[700, 100]] }, fundingRate: 0.0001, fundingIntervalH: 1 }),
    ok(venue('p2', 'perp', 'USDC'), cfg('p2', 0), { book: { bids: [[700, 100]], asks: [[702, 100]] } }),
    { venue: venue('bad', 'perp', 'USD'), cfg: cfg('bad', 0), ok: false, error: 'boom', ts: 0 },
  ];
  const c = buildComparison(results, fx, 100_000, now);

  close(c.refUsd, 700);
  close(c.refJpy, 105_000);
  const [jp, p1, p2, bad] = c.rows;
  close(jp.midJpy, 105_000);
  close(jp.midUsd, 700);
  close(jp.deviationPct, 0);
  close(jp.buyJpyNet, 106_000 * 1.001);
  close(jp.sellJpyNet, 104_000 * 0.999);
  close(p1.midJpy, 699 * 150);
  close(p1.buyJpy, 700 * 150);
  close(p1.funding8h, 0.0008);
  close(p2.sellJpy, 700 * 150);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'boom');

  assert.equal(c.bestBuy?.id, 'p1');
  assert.equal(c.bestSell?.id, 'p2');
  close(c.gapPct, 0);
});

test('buildComparison: 板不足・古い手数料・広いスプレッドに警告を出す', () => {
  const results = [
    ok(venue('thin', 'perp', 'USD'), cfg('thin', 0, '2026-08-01'), { book: { bids: [[690, 0.01]], asks: [[710, 0.01]] } }),
  ];
  const c = buildComparison(results, fx, 100_000, now);
  const r = c.rows[0];
  assert.ok(r.warnings.some((w) => w.includes('手数料の確認')));
  assert.ok(r.warnings.includes('スプレッドが広い'));
  assert.ok(r.warnings.includes('買い板が金額に足りない'));
  assert.equal(c.bestBuy, undefined, '埋めきれない取引所は最良候補にしない');
});

test('buildComparison: 板が空なら失敗扱い', () => {
  const c = buildComparison([ok(venue('e', 'perp', 'USD'), cfg('e', 0), { book: { bids: [], asks: [] } })], fx, 1000, now);
  assert.equal(c.rows[0].ok, false);
});
