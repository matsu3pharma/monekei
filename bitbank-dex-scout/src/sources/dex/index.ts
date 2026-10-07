// DEXアダプターの共通インターフェース。
// 新しいDEX（SparkDEX/Flare、Jupiter/Solana など）は DexAdapter を実装して adapters に足す。
import Decimal from 'decimal.js';
import type { ChainConfig } from '../../config.js';
import { kyberswap } from './kyberswap.js';

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
  supports(chain: ChainConfig): boolean;
  getQuote(chain: ChainConfig, tokenIn: Token, amountIn: Decimal, tokenOut: Token): Promise<DexQuote>;
}

export const adapters: DexAdapter[] = [kyberswap];

export function getQuote(chain: ChainConfig, tokenIn: Token, amountIn: Decimal, tokenOut: Token): Promise<DexQuote> {
  const adapter = adapters.find((a) => a.supports(chain));
  if (!adapter) return Promise.reject(new Error(`${chain.label} に対応するDEXアダプターがありません`));
  return adapter.getQuote(chain, tokenIn, amountIn, tokenOut);
}

/** 人間の単位 → 最小単位の整数文字列（切り捨て） */
export function toBaseUnits(amount: Decimal, decimals: number): string {
  return amount.mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
}

export function fromBaseUnits(raw: string, decimals: number): Decimal {
  return new Decimal(raw).div(new Decimal(10).pow(decimals));
}
