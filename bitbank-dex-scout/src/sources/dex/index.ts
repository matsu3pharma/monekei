// DEXアダプターの共通インターフェース。
// 新しいDEX（SparkDEX/Flare、Jupiter/Solana など）は DexAdapter を実装して adapters に足す。
//
// 見積りは複数のアグリゲーターに振り分ける。各社とも無料APIには回数制限があるので（KyberSwap は約1回/秒）、
// その時点で空いている提供元に送り、失敗したら別の提供元で取り直す。
import Decimal from 'decimal.js';
import type { ChainConfig } from '../../config.js';
import { errMessage, TtlCache, waitTime } from '../../http.js';
import { kyberswap } from './kyberswap.js';
import { paraswap } from './paraswap.js';

export interface Token {
  symbol: string;
  /** ネイティブトークン（ガス代トークン）なら true。address は無視される */
  native?: boolean;
  address?: string;
  decimals: number;
}

export interface DexQuote {
  /** 受け取れる tokenOut の数量（人間が読む単位。DEX手数料・スリッページ込み、ガス代は含まない） */
  amountOut: Decimal;
  /** スワップのガス代（USD）。アグリゲーターが返さなければ null（呼び出し側で自前計算する） */
  gasUsd: Decimal | null;
  /** ガス1単位あたりのUSD（approve のガス代の換算に使う）。不明なら null */
  usdPerGasUnit: Decimal | null;
  /** アグリゲーターが持っている参照価格（スリッページなしの単価、USD）。不明なら null */
  tokenInUsd: Decimal | null;
  tokenOutUsd: Decimal | null;
  source: string;
}

export interface DexAdapter {
  name: string;
  /** 回数制限を管理する単位（APIのホスト名） */
  host: string;
  supports(chain: ChainConfig): boolean;
  getQuote(chain: ChainConfig, tokenIn: Token, amountIn: Decimal, tokenOut: Token): Promise<DexQuote>;
}

export const adapters: DexAdapter[] = [kyberswap, paraswap];

// 見積りは90秒使い回す。数量は有効数字3桁に丸めて問い合わせ、結果を元の数量に比例換算する
// （板が少し動くたびに別の数量になって、自動更新のたびに全部取り直すのを防ぐ。誤差は1%未満の区間の線形近似）
const cache = new TtlCache<DexQuote>(90_000);
const QUOTE_DIGITS = 3;

export interface QuoteOptions {
  /** この提供元を優先する（少額見積りを本見積りと同じ提供元で取るため） */
  prefer?: string;
}

export async function getQuote(chain: ChainConfig, tokenIn: Token, amountIn: Decimal, tokenOut: Token, opts: QuoteOptions = {}): Promise<DexQuote> {
  const usable = adapters.filter((a) => a.supports(chain));
  if (!usable.length) throw new Error(`${chain.label} に対応するDEXアダプターがありません`);
  const rounded = amountIn.toSignificantDigits(QUOTE_DIGITS, Decimal.ROUND_DOWN);
  if (rounded.lte(0)) throw new Error('見積り数量が0です');

  // 空いている順（優先指定があればそれを先頭）に試す
  const order = [...usable].sort((a, b) => {
    if (opts.prefer && a.name !== b.name) {
      if (a.name === opts.prefer) return -1;
      if (b.name === opts.prefer) return 1;
    }
    return waitTime(a.host) - waitTime(b.host);
  });

  const errors: string[] = [];
  for (const a of order) {
    const key = `${a.name}:${chain.id}:${tokenIn.native ? 'native' : tokenIn.address}:${tokenOut.address}:${rounded.toString()}`;
    try {
      const q = await cache.get(key, () => a.getQuote(chain, tokenIn, rounded, tokenOut));
      const scale = amountIn.div(rounded);
      return { ...q, amountOut: q.amountOut.mul(scale) };
    } catch (e) {
      errors.push(`${a.name}: ${errMessage(e)}`);
    }
  }
  throw new Error(errors.join(' / '));
}

/** 人間の単位 → 最小単位の整数文字列（切り捨て） */
export function toBaseUnits(amount: Decimal, decimals: number): string {
  return amount.mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
}

export function fromBaseUnits(raw: string, decimals: number): Decimal {
  return new Decimal(raw).div(new Decimal(10).pow(decimals));
}

export function positive(v: string | number | undefined | null): Decimal | null {
  if (v == null || v === '') return null;
  const d = new Decimal(v);
  return d.isFinite() && d.gt(0) ? d : null;
}

export const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
