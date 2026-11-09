// KyberSwap Aggregator API（キー不要）
//   https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/aggregator-api-specification/evm-swaps
// GET /{chain}/api/v1/routes?tokenIn=&tokenOut=&amountIn=  … 見積りのみ（トランザクションは作らない）
// キーなしの利用は約1回/秒までに制限されている（2026年11月時点。超えると 429）
import Decimal from 'decimal.js';
import { fetchJson } from '../../http.js';
import { fromBaseUnits, NATIVE_ADDRESS, positive, toBaseUnits, type DexAdapter, type DexQuote, type Token } from './index.js';

const HOST = 'aggregator-api.kyberswap.com';
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

export const kyberswap: DexAdapter = {
  name: 'KyberSwap',
  host: HOST,
  supports: (chain) => Boolean(chain.aggregator_chain),

  async getQuote(chain, tokenIn: Token, amountIn: Decimal, tokenOut: Token): Promise<DexQuote> {
    const inAddr = tokenIn.native ? NATIVE_ADDRESS : tokenIn.address!;
    const outAddr = tokenOut.native ? NATIVE_ADDRESS : tokenOut.address!;
    const raw = toBaseUnits(amountIn, tokenIn.decimals);
    if (raw === '0') throw new Error('見積り数量が0です');
    const url = `https://${HOST}/${chain.aggregator_chain}/api/v1/routes?tokenIn=${inAddr}&tokenOut=${outAddr}&amountIn=${raw}`;

    const r = await fetchJson<RoutesResponse>(url, { minIntervalMs: 1100, retries: 1, headers: { 'x-client-id': CLIENT_ID } });
    if (r.code !== 0 || !r.data) throw new Error(`${r.message} (code ${r.code})`);
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
  },
};
