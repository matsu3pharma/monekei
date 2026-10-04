'use strict';
// 各DEXのAPIを実際に叩いて、レスポンスの形と BTC/ETH の値を表示する確認用スクリプト。
// 使い方: node scripts/check-apis.js
// 出力の「1h換算」を各DEXの公式画面のFR表示と見比べ、config.json の intervalHours を確定させる。

const { ADAPTERS, makeFetchJson } = require('../exchanges');

const fetchJson = makeFetchJson(20000);
const WATCH = ['BTC', 'ETH'];

function keysOf(x) {
  if (Array.isArray(x)) return `Array(${x.length}) of {${x[0] && typeof x[0] === 'object' ? Object.keys(x[0]).join(', ') : typeof x[0]}}`;
  if (x && typeof x === 'object') return `{${Object.keys(x).join(', ')}}`;
  return typeof x;
}

async function raw(label, url, init) {
  try {
    const started = Date.now();
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    const limitHeaders = [...res.headers].filter(([k]) => /rate|limit|weight|retry/i.test(k));
    const body = await res.json();
    console.log(`\n--- ${label}  HTTP ${res.status}  ${Date.now() - started}ms`);
    console.log(`  形: ${keysOf(body)}`);
    if (limitHeaders.length) console.log(`  レート制限ヘッダ: ${limitHeaders.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    return body;
  } catch (err) {
    console.log(`\n--- ${label}  失敗: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('=== 生のレスポンス ===');
  const hl = await raw('Hyperliquid metaAndAssetCtxs', 'https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (hl) {
    console.log(`  meta: ${keysOf(hl[0])}  universe[0]: ${JSON.stringify(hl[0].universe[0])}`);
    console.log(`  ctxs[0]: ${JSON.stringify(hl[1][0])}`);
  }

  const dydx = await raw('dYdX perpetualMarkets', 'https://indexer.dydx.trade/v4/perpetualMarkets');
  if (dydx) console.log(`  BTC-USD: ${JSON.stringify(dydx.markets['BTC-USD'])}`);

  const ap = await raw('Aster premiumIndex', 'https://fapi.asterdex.com/fapi/v1/premiumIndex');
  if (ap) console.log(`  BTCUSDT: ${JSON.stringify(ap.find((x) => x.symbol === 'BTCUSDT'))}`);
  const af = await raw('Aster fundingInfo', 'https://fapi.asterdex.com/fapi/v1/fundingInfo');
  if (Array.isArray(af)) {
    const hist = {};
    for (const f of af) hist[f.fundingIntervalHours] = (hist[f.fundingIntervalHours] || 0) + 1;
    console.log(`  fundingIntervalHours の分布: ${JSON.stringify(hist)}  例: ${JSON.stringify(af[0])}`);
  }

  const lfr = await raw('Lighter funding-rates', 'https://mainnet.zklighter.elliot.ai/api/v1/funding-rates');
  if (lfr && lfr.funding_rates) {
    const exs = [...new Set(lfr.funding_rates.map((r) => r.exchange))];
    console.log(`  exchange の種類: ${exs.join(', ')}`);
    for (const r of lfr.funding_rates.filter((r) => r.symbol === 'BTC')) console.log(`  BTC: ${JSON.stringify(r)}`);
  }
  const lob = await raw('Lighter orderBookDetails', 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp');
  if (lob) {
    const d = lob.order_book_details || [];
    console.log(`  BTC: ${JSON.stringify(d.find((x) => x.symbol === 'BTC'))}`);
    console.log(`  PEPE/SHIB/BONK系の表記: ${d.map((x) => x.symbol).filter((s) => /PEPE|SHIB|BONK|FLOKI/i.test(s)).join(', ')}`);
  }

  const ps = await raw('Paradex markets/summary', 'https://api.prod.paradex.trade/v1/markets/summary?market=ALL');
  if (ps && ps.results) console.log(`  BTC-USD-PERP: ${JSON.stringify(ps.results.find((x) => x.symbol === 'BTC-USD-PERP'))}`);
  const pm = await raw('Paradex markets', 'https://api.prod.paradex.trade/v1/markets');
  if (pm && pm.results) {
    const m = pm.results.find((x) => x.symbol === 'BTC-USD-PERP') || {};
    console.log(`  BTC-USD-PERP funding_period_hours: ${m.funding_period_hours}`);
  }

  console.log('\n=== アダプタ経由（このアプリが実際に使う値） ===');
  for (const [id, a] of Object.entries(ADAPTERS)) {
    try {
      const rows = await a.fetch({ fetchJson, intervalHours: a.defaultIntervalHours });
      console.log(`\n[${a.label}] ${rows.length} 銘柄`);
      for (const r of rows.filter((r) => WATCH.includes(r.symbol))) {
        const h = r.fundingHourly;
        console.log(
          `  ${r.symbol.padEnd(4)} raw=${r.raw.padEnd(13)} price=${r.price}  DEXのFR=${r.fundingRaw}（${r.intervalHours}h扱い）` +
            `  1h換算=${h == null ? '—' : (h * 100).toFixed(5) + '%'}  8h換算=${h == null ? '—' : (h * 800).toFixed(4) + '%'}` +
            `  出来高=${r.volume24h}`
        );
      }
    } catch (err) {
      console.log(`\n[${a.label}] 失敗: ${err.message}`);
    }
  }
}

main();
