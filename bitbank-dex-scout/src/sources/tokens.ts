// トークンのコントラクトアドレス解決。
// routes.yaml で { coingecko: <id> } と書かれたものだけ CoinGecko の公開API（キー不要）で引き、
// 結果を .cache/tokens.json に長期キャッシュする。手動で上書きしたいときは routes.yaml に address/decimals を直接書く。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, type ChainConfig, type RouteConfig } from '../config.js';
import { fetchJson } from '../http.js';
import type { Token } from './dex/index.js';

const CACHE_FILE = join(ROOT, '.cache', 'tokens.json');

// chains.yaml のチェーンID → CoinGecko の asset platform ID
const PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
};

type Cache = Record<string, { address: string; decimals: number; fetched_at: string }>;

function readCache(): Cache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(c: Cache) {
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
}

const NATIVE_DECIMALS = 18; // ETH, POL とも 18

export async function resolveToken(route: RouteConfig, chain: ChainConfig): Promise<Token> {
  const spec = route.token;
  if (spec === 'native') return { symbol: route.asset, native: true, decimals: NATIVE_DECIMALS };
  if ('address' in spec) return { symbol: route.asset, address: spec.address, decimals: Number(spec.decimals) };

  const platform = PLATFORM[chain.id];
  if (!platform) throw new Error(`CoinGecko のプラットフォームIDが不明なチェーン: ${chain.id}`);
  const key = `${spec.coingecko}@${platform}`;
  const cache = existsSync(CACHE_FILE) ? readCache() : {};
  if (cache[key]) return { symbol: route.asset, address: cache[key].address, decimals: cache[key].decimals };

  const coin = await fetchJson<any>(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(spec.coingecko)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
    { minIntervalMs: 3000 }, // 無料枠は1分あたり数回〜数十回程度なので間隔を広めに
  );
  const p = coin?.detail_platforms?.[platform];
  if (!p?.contract_address) throw new Error(`CoinGecko に ${spec.coingecko} の ${platform} アドレスがありません`);
  const entry = { address: p.contract_address, decimals: Number(p.decimal_place ?? 18), fetched_at: new Date().toISOString() };
  writeCache({ ...readCache(), [key]: entry });
  return { symbol: route.asset, address: entry.address, decimals: entry.decimals };
}
