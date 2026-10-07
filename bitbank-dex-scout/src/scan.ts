// 全ルートの計算（データ取得 → 純粋関数で計算 → 表示用の行にまとめる）
// どこか1つのAPIが落ちても、その行だけ「見積り失敗」にして全体は止めない。
import Decimal from 'decimal.js';
import { computeLoss, netAfterWithdraw, simulateBuy, type Breakdown, type FeeMode } from './calc/route.js';
import { loadConfig, type AppConfig, type ChainConfig, type RouteConfig } from './config.js';
import { errMessage, mapLimit } from './http.js';
import { getDepth, getPairs, type PairInfo } from './sources/bitbank.js';
import { getQuote, type Token } from './sources/dex/index.js';
import { getUsdJpy, type FxRate } from './sources/fx.js';
import { getGasPrice } from './sources/gas.js';
import { resolveToken } from './sources/tokens.js';

export interface ScanOptions {
  amounts?: number[];
  chains?: string[]; // 欲しいチェーンで絞り込み（未指定なら全部）
  mode?: FeeMode;
  config?: AppConfig;
}

export type BreakdownNumbers = Record<keyof Breakdown, number>;

export interface RouteRow {
  id: string;
  pair: string;
  asset: string;
  chain: string;
  chainLabel: string;
  target: string; // USDC / USDC.e
  targetIsNative: boolean;
  amountJpy: number;
  status: 'ok' | 'error' | 'disabled';
  error?: string;
  received?: number; // R（USDC）
  receivedJpy?: number;
  lossJpy?: number;
  lossRate?: number;
  priceGapRate?: number | null;
  breakdown?: BreakdownNumbers;
  quantity?: number; // Q
  netQuantity?: number; // Q'
  vwap?: number;
  bestAsk?: number;
  slippage?: number;
  dexUnitPrice?: number | null; // USDC/トークン
  gasUsdc?: number;
  feeRate?: number;
  withdrawFee: number;
  feeCheckedAt: string;
  dexSource?: string;
  warnings: string[];
  bestInChain?: boolean;
  bestOverall?: boolean;
}

export interface Unconfigured {
  pair: string;
  asset: string;
  networks: string[];
}

export interface ScanResult {
  generatedAt: string;
  mode: FeeMode;
  amounts: number[];
  chains: { id: string; label: string }[];
  fx: { rate: number; provider: string; asOf: string } | null;
  rows: RouteRow[];
  unconfigured: Unconfigured[];
  errors: string[];
  notice: string;
}

/** DEXの基準単価を測るときの少額見積りの大きさ（円） */
const REF_JPY = 5000;

const NOTICE =
  '出金手数料は config/routes.yaml の値（公式ページから手で写したもの）に基づく試算です。DEXの見積りは数秒で変わる目安で、実際に送る前には少額でテストしてください。このツールは読み取り専用で、注文・出金・スワップは行いません。';

function daysSince(date: string): number | null {
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
}

function toNumbers(b: Breakdown): BreakdownNumbers {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toNumber()])) as BreakdownNumbers;
}

function pairWarnings(p: PairInfo | undefined): string[] {
  if (!p) return ['bitbankのペア一覧に見つからない'];
  const w: string[] = [];
  if (!p.isEnabled) w.push('bitbankで取引停止中');
  else if (p.stopBuy) w.push('bitbankで買い注文停止中');
  if (p.status && p.status !== 'NORMAL') w.push(`bitbankの状態: ${p.status}`);
  return w;
}

/** ガス代（USD）。アグリゲーターの値を優先し、なければ RPC の gasPrice × 仮定ガス量 × ネイティブ価格 */
async function gasUsdFor(
  chain: ChainConfig,
  token: Token,
  quote: { gasUsd: Decimal | null; usdPerGasUnit: Decimal | null },
  nativeUsd: () => Promise<Decimal>,
): Promise<Decimal> {
  let perUnit = quote.usdPerGasUnit;
  let swap = quote.gasUsd;
  if (!swap || !perUnit) {
    perUnit = (await getGasPrice(chain)).mul(await nativeUsd());
    swap = swap ?? perUnit.mul(chain.swap_gas);
  }
  // ERC-20 を売るときは先に approve が必要（ネイティブトークンなら不要）
  return token.native ? swap : swap.plus(perUnit.mul(chain.approve_gas));
}

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const cfg = opts.config ?? loadConfig();
  const mode: FeeMode = opts.mode ?? 'taker';
  const amounts = [...new Set((opts.amounts?.length ? opts.amounts : cfg.amounts_jpy).filter((a) => a > 0))].sort((a, b) => a - b);
  const chainFilter = opts.chains?.length ? new Set(opts.chains) : null;
  const errors: string[] = [];

  const [fxRes, pairsRes] = await Promise.allSettled([getUsdJpy(cfg.fx), getPairs()]);
  const fx: FxRate | null = fxRes.status === 'fulfilled' ? fxRes.value : null;
  if (!fx) errors.push(`為替レート取得失敗: ${errMessage((fxRes as PromiseRejectedResult).reason)}`);
  const pairs = new Map<string, PairInfo>();
  if (pairsRes.status === 'fulfilled') for (const p of pairsRes.value) pairs.set(p.name, p);
  else errors.push(`bitbankのペア一覧取得失敗（手数料率は設定ファイルの値を使用）: ${errMessage(pairsRes.reason)}`);

  const routes = cfg.routes.filter((r) => !chainFilter || chainFilter.has(r.chain));
  const nativeUsdCache = new Map<string, Promise<Decimal>>();
  const nativeUsd = (chain: ChainConfig) => () => {
    if (!nativeUsdCache.has(chain.id)) {
      nativeUsdCache.set(
        chain.id,
        getDepth(chain.native_pair).then((d) => {
          if (!fx) throw new Error('為替レートがありません');
          return new Decimal(d.asks[0][0]).plus(d.bids[0][0]).div(2).div(fx.rate);
        }),
      );
    }
    return nativeUsdCache.get(chain.id)!;
  };

  // 少額見積りの単価（USDC/トークン）は金額によらないので、ルート×受け取りUSDCごとに1回だけ取る
  const refCache = new Map<string, Promise<Decimal | null>>();
  const refPrice = (key: string, amountIn: Decimal, quote: (amountIn: Decimal) => Promise<{ amountOut: Decimal }>) => {
    if (!refCache.has(key)) refCache.set(key, quote(amountIn).then((q) => (q.amountOut.gt(0) ? q.amountOut.div(amountIn) : null), () => null));
    return refCache.get(key)!;
  };

  // ルート×金額ごとにタスクを作る（受け取りUSDCの種類ごとに1行）
  const tasks: { route: RouteConfig; amount: number }[] = [];
  for (const route of routes) for (const amount of amounts) tasks.push({ route, amount });

  const rowGroups = await mapLimit(tasks, 6, async ({ route, amount }): Promise<RouteRow[]> => {
    const chain = cfg.chains[route.chain];
    const pair = pairs.get(route.pair);
    const base = (target: string): RouteRow => ({
      id: `${route.pair}:${route.chain}:${target}:${amount}`,
      pair: route.pair,
      asset: route.asset,
      chain: route.chain,
      chainLabel: chain.label,
      target,
      targetIsNative: chain.usdc[target].native,
      amountJpy: amount,
      status: 'ok',
      withdrawFee: route.withdraw_fee,
      feeCheckedAt: route.fee_checked_at,
      warnings: [],
    });
    const fail = (msg: string, extra: string[] = []) => route.targets.map((t) => ({ ...base(t), status: 'error' as const, error: msg, warnings: extra }));

    const common: string[] = [];
    const age = daysSince(route.fee_checked_at);
    if (age == null || age >= cfg.thresholds.fee_stale_days) common.push(`手数料の確認が古い（${route.fee_checked_at || '日付なし'}）`);
    common.push(...(pairsRes.status === 'fulfilled' ? pairWarnings(pair) : []));

    if (route.disabled) {
      return route.targets.map((t) => ({ ...base(t), status: 'disabled' as const, error: route.disabled_reason ?? '設定で無効化（出金停止中など）', warnings: common }));
    }
    if (!fx) return fail('見積り失敗（為替レートなし）', common);

    const feeRate = new Decimal(
      mode === 'taker' ? (pair?.takerFee ?? cfg.trading_fee.taker) : (pair?.makerFee ?? cfg.trading_fee.maker),
    );

    let book;
    try {
      book = await getDepth(route.pair);
    } catch (e) {
      return fail(`見積り失敗（bitbankの板）: ${errMessage(e)}`, common);
    }
    const buy = simulateBuy(book, amount, feeRate, mode);
    if (!buy.ok) {
      const msg = buy.error === 'empty_book' ? '板が空' : `板が足りない（約定できるのは ${buy.filledJpy?.toFixed(0)} 円分まで）`;
      return fail(msg, common);
    }
    const warnBuy = [...common];
    if (mode === 'taker' && buy.slippage.gt(cfg.thresholds.thin_book_slippage)) {
      warnBuy.push(`板が薄い（VWAPが最良売値より +${buy.slippage.mul(100).toFixed(2)}%）`);
    }
    if (pair?.minAmount && buy.quantity.lt(pair.minAmount)) warnBuy.push(`最小注文数量 ${pair.minAmount} 未満`);

    const Qn = netAfterWithdraw(buy.quantity, route.withdraw_fee);
    let token: Token | null = null;
    if (Qn.gt(0)) {
      try {
        token = await resolveToken(route, chain);
      } catch (e) {
        return fail(`見積り失敗（トークン情報）: ${errMessage(e)}`, warnBuy);
      }
    }

    return Promise.all(
      route.targets.map(async (target): Promise<RouteRow> => {
        const row = base(target);
        row.warnings = [...warnBuy];
        row.feeRate = feeRate.toNumber();
        const usdc = chain.usdc[target];
        try {
          let dex = null;
          let gasUsdc = new Decimal(0);
          if (Qn.gt(0) && token) {
            const usdcToken: Token = { symbol: target, address: usdc.address, decimals: usdc.decimals };
            const [q, small] = await Promise.all([
              getQuote(chain, token, Qn, usdcToken),
              refPrice(`${route.pair}:${chain.id}:${target}`, new Decimal(REF_JPY).div(buy.mid).toSignificantDigits(2), (a) => getQuote(chain, token!, a, usdcToken)),
            ]);
            const usdcUsd = q.tokenOutUsd ?? new Decimal(1);
            gasUsdc = (await gasUsdFor(chain, token, q, nativeUsd(chain))).div(usdcUsd);
            // DEXの基準単価：少額（約 REF_JPY 円分）で見積もった単価。取れなければアグリゲーターの参照価格
            const unitPrice = small ?? (q.tokenInUsd ? q.tokenInUsd.div(usdcUsd) : null);
            if (!unitPrice) row.warnings.push('DEXの基準単価なし（DEXコストを価格乖離に含めて表示）');
            dex = { amountOut: q.amountOut, refPriceUsdc: unitPrice, gasUsdc };
            row.dexSource = q.source;
          }
          const res = computeLoss(buy, route.withdraw_fee, dex, fx.rate);
          if (res.withdrawExceedsQuantity) row.warnings.push('出金手数料が購入数量を上回る');
          if (res.gasExceedsOutput) row.warnings.push('ガス代が受取額を上回る');
          Object.assign(row, {
            received: res.received.toNumber(),
            receivedJpy: res.receivedJpy.toNumber(),
            lossJpy: res.lossJpy.toNumber(),
            lossRate: res.lossRate.toNumber(),
            priceGapRate: res.priceGapRate?.toNumber() ?? null,
            breakdown: toNumbers(res.breakdown),
            quantity: res.quantity.toNumber(),
            netQuantity: res.netQuantity.toNumber(),
            vwap: buy.vwap.toNumber(),
            bestAsk: buy.bestAsk.toNumber(),
            slippage: buy.slippage.toNumber(),
            dexUnitPrice: res.dexUnitPrice?.toNumber() ?? null,
            gasUsdc: gasUsdc.toNumber(),
          });
        } catch (e) {
          row.status = 'error';
          row.error = `見積り失敗（DEX）: ${errMessage(e)}`;
        }
        return row;
      }),
    );
  });

  const rows = rowGroups.flat();
  markBest(rows);
  rows.sort(compareRows);

  return {
    generatedAt: new Date().toISOString(),
    mode,
    amounts,
    chains: Object.values(cfg.chains).map((c) => ({ id: c.id, label: c.label })),
    fx: fx ? { rate: fx.rate.toNumber(), provider: fx.provider, asOf: fx.asOf } : null,
    rows,
    unconfigured: findUnconfigured(cfg, [...pairs.values()]),
    errors,
    notice: NOTICE,
  };
}

/** 金額ごとに、各チェーンで一番安いルートと全体で一番安いルートに印を付ける */
function markBest(rows: RouteRow[]) {
  const bestChain = new Map<string, RouteRow>();
  const bestAll = new Map<number, RouteRow>();
  for (const r of rows) {
    if (r.status !== 'ok' || r.lossJpy == null) continue;
    const k = `${r.amountJpy}:${r.chain}`;
    if (!bestChain.has(k) || r.lossJpy < bestChain.get(k)!.lossJpy!) bestChain.set(k, r);
    if (!bestAll.has(r.amountJpy) || r.lossJpy < bestAll.get(r.amountJpy)!.lossJpy!) bestAll.set(r.amountJpy, r);
  }
  for (const r of bestChain.values()) r.bestInChain = true;
  for (const r of bestAll.values()) r.bestOverall = true;
}

/** 金額ごとに、損失率の小さい順。失敗・無効の行は下へ */
export function compareRows(a: RouteRow, b: RouteRow): number {
  if (a.amountJpy !== b.amountJpy) return a.amountJpy - b.amountJpy;
  const ra = a.status === 'ok' ? a.lossRate! : Infinity;
  const rb = b.status === 'ok' ? b.lossRate! : Infinity;
  if (ra !== rb) return ra - rb;
  return a.id.localeCompare(b.id);
}

function findUnconfigured(cfg: AppConfig, pairs: PairInfo[]): Unconfigured[] {
  const configured = new Set(cfg.routes.map((r) => r.pair));
  return pairs
    .filter((p) => p.quote === 'jpy' && p.isEnabled && !p.stopBuy && !configured.has(p.name))
    .map((p) => {
      const asset = p.base.toUpperCase();
      return { pair: p.name, asset, networks: cfg.other_networks[asset] ?? ['不明（公式の手数料ページで出金ネットワークを確認）'] };
    });
}
