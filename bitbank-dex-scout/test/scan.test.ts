// 外部APIをモックして、1つのAPIが落ちても全体が止まらないことを確かめる
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { scan } from '../src/scan.js';

const USDC = { address: '0xUSDC', decimals: 6, native: true };
const chain = (id: string, native_pair: string) => ({
  id, label: id, aggregator_chain: id, native_symbol: 'X', native_pair, swap_gas: 1, approve_gas: 1, usdc: { USDC },
});
const config: AppConfig = {
  fx: { provider: 'manual', manual_rate: 150 },
  trading_fee: { taker: 0.0012, maker: -0.0002 },
  amounts_jpy: [10000],
  thresholds: { fee_stale_days: 30, thin_book_slippage: 0.005 },
  other_networks: {},
  chains: { polygon: chain('polygon', 'pol_jpy'), arbitrum: chain('arbitrum', 'eth_jpy') },
  routes: [
    { pair: 'pol_jpy', asset: 'POL', chain: 'polygon', withdraw_fee: 1, fee_checked_at: new Date().toISOString().slice(0, 10), token: 'native', targets: ['USDC'] },
    { pair: 'eth_jpy', asset: 'ETH', chain: 'arbitrum', withdraw_fee: 0.001, fee_checked_at: '2020-01-01', token: 'native', targets: ['USDC'] },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const depth = (ask: string, bid: string) => json({ success: 1, data: { asks: [[ask, '1000000']], bids: [[bid, '1000000']], timestamp: 0 } });

afterEach(() => vi.unstubAllGlobals());

describe('scan（APIの一部が落ちたとき）', () => {
  it('アグリゲーターが落ちたチェーンの行だけ「見積り失敗」になり、他の行は計算される', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/spot/pairs')) return json({ success: 1, data: { pairs: [] } });
      if (url.includes('/spot/status')) return json({ success: 1, data: { statuses: [] } });
      if (url.includes('pol_jpy/depth')) return depth('20', '19.9');
      if (url.includes('eth_jpy/depth')) return depth('400000', '399900');
      if (url.includes('/arbitrum/')) return new Response('down', { status: 503 });
      if (url.includes('/polygon/')) {
        const amountIn = Number(new URL(url).searchParams.get('amountIn')) / 1e18;
        return json({
          code: 0, message: 'ok',
          data: { routeSummary: { amountIn: '', amountInUsd: '', amountOut: String(Math.floor(amountIn * 0.13 * 1e6)), amountOutUsd: '', gas: '100000', gasPrice: '1', gasUsd: '0.01' } },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const r = await scan({ config });
    const pol = r.rows.find((x) => x.pair === 'pol_jpy')!;
    const eth = r.rows.find((x) => x.pair === 'eth_jpy')!;

    expect(pol.status).toBe('ok');
    expect(pol.lossJpy).toBeGreaterThan(0);
    const sum = Object.values(pol.breakdown!).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(pol.lossJpy!, 6);

    expect(eth.status).toBe('error');
    expect(eth.error).toMatch(/見積り失敗/);
    expect(eth.warnings.join()).toMatch(/手数料の確認が古い/);
    expect(r.rows[0].pair).toBe('pol_jpy'); // 成功した行が上
  });
});
