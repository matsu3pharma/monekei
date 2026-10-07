// config/routes.yaml と config/chains.yaml の読み込み
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { FxConfig } from './sources/fx.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface UsdcConfig {
  address: string;
  decimals: number;
  native: boolean;
}

export interface ChainConfig {
  id: string;
  label: string;
  aggregator_chain: string;
  native_symbol: string;
  native_pair: string;
  rpc?: string;
  swap_gas: number;
  approve_gas: number;
  usdc: Record<string, UsdcConfig>;
}

export type TokenSpec = 'native' | { address: string; decimals: number } | { coingecko: string };

export interface RouteConfig {
  pair: string;
  asset: string;
  chain: string;
  withdraw_fee: number;
  fee_checked_at: string;
  token: TokenSpec;
  targets: string[];
  disabled?: boolean;
  disabled_reason?: string;
}

export interface AppConfig {
  fx: FxConfig;
  trading_fee: { taker: number; maker: number };
  amounts_jpy: number[];
  thresholds: { fee_stale_days: number; thin_book_slippage: number };
  routes: RouteConfig[];
  other_networks: Record<string, string[]>;
  chains: Record<string, ChainConfig>;
}

export function loadConfig(dir = join(ROOT, 'config')): AppConfig {
  const routesDoc = YAML.parse(readFileSync(join(dir, 'routes.yaml'), 'utf8')) ?? {};
  const chainsDoc = YAML.parse(readFileSync(join(dir, 'chains.yaml'), 'utf8')) ?? {};

  const chains: Record<string, ChainConfig> = {};
  for (const [id, c] of Object.entries<any>(chainsDoc.chains ?? {})) chains[id] = { id, ...c };

  const routes: RouteConfig[] = (routesDoc.routes ?? []).map((r: any, i: number) => {
    const where = `routes.yaml の routes[${i}] (${r?.pair} → ${r?.chain})`;
    for (const k of ['pair', 'asset', 'chain', 'withdraw_fee', 'token']) {
      if (r?.[k] == null) throw new Error(`${where}: ${k} がありません`);
    }
    const chain = chains[r.chain];
    if (!chain) throw new Error(`${where}: chains.yaml に ${r.chain} がありません`);
    const targets: string[] = r.targets ?? ['USDC'];
    for (const t of targets) if (!chain.usdc[t]) throw new Error(`${where}: ${r.chain} の usdc に ${t} がありません`);
    return { ...r, asset: String(r.asset).toUpperCase(), withdraw_fee: Number(r.withdraw_fee), fee_checked_at: String(r.fee_checked_at ?? ''), targets };
  });

  return {
    fx: routesDoc.fx ?? { provider: 'frankfurter' },
    trading_fee: { taker: 0.0012, maker: -0.0002, ...(routesDoc.trading_fee ?? {}) },
    amounts_jpy: routesDoc.amounts_jpy ?? [10000, 50000, 100000, 500000],
    thresholds: { fee_stale_days: 30, thin_book_slippage: 0.005, ...(routesDoc.thresholds ?? {}) },
    routes,
    other_networks: routesDoc.other_networks ?? {},
    chains,
  };
}
