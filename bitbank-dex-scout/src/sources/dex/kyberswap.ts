// KyberSwap Aggregator API（キー不要）
//   https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/aggregator-api-specification/evm-swaps
// GET /{chain}/api/v1/routes?tokenIn=&tokenOut=&amountIn=  … 見積りのみ（トランザクションは作らない）
import Decimal from 'decimal.js';
import { fetchJson, TtlCache } from '../../http.js';
import { fromBaseUnits, toBaseUnits, type DexAdapter, type DexQuote, type Token } from './index.js';

const BASE = 'https://aggregator-api.kyberswap.com';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CLIENT_ID = 'bitbank-dex-scout';

interface RoutesResponse {
  code: number;
  message: string;
  data?: {
    routeSummary: {
      amountIn: string;
      amountInUsd: string;
      amountOut: string;
      amountOutUsd: string;
      gas: string;
      gasPrice: string;
      gasUsd: string;
      l1FeeUsd?: string;
    };
  };
}

const cache = new TtlCache<DexQuote>(20_000);

function positive(v: string | undefined): Decimal | null {
  if (v == null || v === '') return null;
  const d = new Decimal(v);
  return d.isFinite() && d.gt(0) ? d : null;
}

export const kyberswap: DexAdapter = {
  name: 'KyberSwap',
  supports: (chain) => Boolean(chain.aggregator_chain),

  getQuote(chain, tokenIn: Token, amountIn: Decimal, tokenOut: Token): Promise<DexQuote> {
    const inAddr = tokenIn.native ? NATIVE : tokenIn.address!;
    const outAddr = tokenOut.native ? NATIVE : tokenOut.address!;
    const raw = toBaseUnits(amountIn, tokenIn.decimals);
    if (raw === '0') return Promise.reject(new Error('見積り数量が0です'));
    const url = `${BASE}/${chain.aggregator_chain}/api/v1/routes?tokenIn=${inAddr}&tokenOut=${outAddr}&amountIn=${raw}`;

    return cache.get(url, async () => {
      const r = await fetchJson<RoutesResponse>(url, { minIntervalMs: 120, headers: { 'x-client-id': CLIENT_ID } });
      if (r.code !== 0 || !r.data) throw new Error(`KyberSwap: ${r.message} (code ${r.code})`);
      const s = r.data.routeSummary;
      const amountOut = fromBaseUnits(s.amountOut, tokenOut.decimals);
      const inUsd = positive(s.amountInUsd);
      const outUsd = positive(s.amountOutUsd);
      const gasUsd = positive(s.gasUsd);
      const l1 = positive(s.l1FeeUsd) ?? new Decimal(0);
      const gasUnits = positive(s.gas);
      return {
        amountOut,
        gasUsd: gasUsd ? gasUsd.plus(l1) : null,
        usdPerGasUnit: gasUsd && gasUnits ? gasUsd.div(gasUnits) : null,
        tokenInUsd: inUsd ? inUsd.div(amountIn) : null,
        tokenOutUsd: outUsd && amountOut.gt(0) ? outUsd.div(amountOut) : null,
        source: 'KyberSwap',
      };
    });
  },
};
