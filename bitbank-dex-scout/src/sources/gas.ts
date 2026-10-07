// アグリゲーターがガス見積りを返さなかったときの予備：公開RPCの eth_gasPrice から自前で計算する
import Decimal from 'decimal.js';
import type { ChainConfig } from '../config.js';
import { fetchJson, TtlCache } from '../http.js';

const cache = new TtlCache<Decimal>(30_000);

/** ガス価格（ネイティブトークン建て / ガス1単位） */
export function getGasPrice(chain: ChainConfig): Promise<Decimal> {
  if (!chain.rpc) return Promise.reject(new Error(`${chain.label} の rpc が未設定です`));
  return cache.get(chain.id, async () => {
    const r = await fetchJson<{ result?: string; error?: { message: string } }>(chain.rpc!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    });
    if (!r.result) throw new Error(`RPC eth_gasPrice 失敗: ${r.error?.message ?? 'no result'}`);
    return new Decimal(BigInt(r.result).toString()).div(1e18);
  });
}
