// ParaSwap（Velora）の見積りAPI（キー不要）
//   https://developers.velora.xyz/api/velora-api/velora-market-api/get-rate-for-a-token-pair
// GET /prices?srcToken=&destToken=&amount=&srcDecimals=&destDecimals=&side=SELL&network=  … 見積りのみ
import Decimal from 'decimal.js';
import { fetchJson } from '../../http.js';
import { fromBaseUnits, NATIVE_ADDRESS, positive, toBaseUnits, type DexAdapter, type DexQuote, type Token } from './index.js';

const HOST = 'api.paraswap.io';

// chains.yaml のチェーンID → ParaSwap の network（チェーンID）
const NETWORK: Record<string, number> = { ethereum: 1, polygon: 137, arbitrum: 42161, optimism: 10 };

interface PricesResponse {
  error?: string;
  priceRoute?: {
    destAmount: string;
    destAmountAfterFee?: string;
    gasCost?: string;
    gasCostUSD?: string;
    srcUSD?: string;
    destUSD?: string;
  };
}

export const paraswap: DexAdapter = {
  name: 'ParaSwap',
  host: HOST,
  supports: (chain) => chain.id in NETWORK,

  async getQuote(chain, tokenIn: Token, amountIn: Decimal, tokenOut: Token): Promise<DexQuote> {
    const raw = toBaseUnits(amountIn, tokenIn.decimals);
    if (raw === '0') throw new Error('見積り数量が0です');
    const p = new URLSearchParams({
      srcToken: tokenIn.native ? NATIVE_ADDRESS : tokenIn.address!,
      destToken: tokenOut.native ? NATIVE_ADDRESS : tokenOut.address!,
      amount: raw,
      srcDecimals: String(tokenIn.decimals),
      destDecimals: String(tokenOut.decimals),
      side: 'SELL',
      network: String(NETWORK[chain.id]),
      version: '6.2',
    });
    const r = await fetchJson<PricesResponse>(`https://${HOST}/prices?${p}`, { minIntervalMs: 300, retries: 1 });
    if (!r.priceRoute) throw new Error(r.error ?? '見積りなし');
    const s = r.priceRoute;
    // 既定ではAPI側の手数料（0.01%程度）が引かれるので、引かれた後の数量を使う
    const amountOut = fromBaseUnits(s.destAmountAfterFee || s.destAmount, tokenOut.decimals);
    const gasUsd = positive(s.gasCostUSD);
    const gasUnits = positive(s.gasCost);
    const inUsd = positive(s.srcUSD);
    const outUsd = positive(s.destUSD);
    return {
      amountOut,
      gasUsd,
      usdPerGasUnit: gasUsd && gasUnits ? gasUsd.div(gasUnits) : null,
      tokenInUsd: inUsd ? inUsd.div(amountIn) : null,
      tokenOutUsd: outUsd ? outUsd.div(fromBaseUnits(s.destAmount, tokenOut.decimals)) : null,
      source: 'ParaSwap',
    };
  },
};
