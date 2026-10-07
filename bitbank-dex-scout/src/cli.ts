// CLI:  npm run scan -- --amount 100000 --chain polygon [--maker] [--detail] [--json]
import { parseArgs } from 'node:util';
import { scan, type RouteRow, type ScanResult } from './scan.js';

const HELP = `使い方: npm run scan -- [オプション]
  --amount, -a  投入額（円）。カンマ区切りで複数可。省略時は routes.yaml の amounts_jpy
  --chain,  -c  欲しいチェーン（ethereum, polygon, arbitrum, optimism）。カンマ区切りで複数可
  --maker       メイカー（指値）想定で計算する（既定はテイカー）
  --detail, -d  各行の内訳（円）も表示する
  --json        JSONで出力する
  --help,   -h  このヘルプ`;

const { values } = parseArgs({
  options: {
    amount: { type: 'string', short: 'a', multiple: true },
    chain: { type: 'string', short: 'c', multiple: true },
    maker: { type: 'boolean', default: false },
    detail: { type: 'boolean', short: 'd', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const split = (v?: string[]) => (v ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
const amounts = split(values.amount).map((s) => Number(s.replace(/[_円]/g, '')));
if (amounts.some((a) => !Number.isFinite(a) || a <= 0)) {
  console.error('--amount には正の数を指定してください');
  process.exit(1);
}

const result = await scan({ amounts, chains: split(values.chain), mode: values.maker ? 'maker' : 'taker' });

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  print(result, values.detail);
}

// ---- 表示 ----

/** 全角を2文字分として数える */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s: string, n: number, right = false) {
  const fill = ' '.repeat(Math.max(0, n - width(s)));
  return right ? fill + s : s + fill;
}
function yen(n?: number) {
  return n == null ? '-' : Math.round(n).toLocaleString('ja-JP');
}
function pct(n?: number | null, digits = 2) {
  return n == null ? '-' : `${(n * 100).toFixed(digits)}%`;
}
function usdc(n?: number) {
  return n == null ? '-' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function print(r: ScanResult, detail: boolean) {
  const fx = r.fx ? `USD/JPY ${r.fx.rate}（${r.fx.provider}, ${r.fx.asOf}）` : 'USD/JPY 取得失敗';
  console.log(`bitbank → DEX → USDC 損失比較  ${new Date(r.generatedAt).toLocaleString('ja-JP')}  ${fx}  ${r.mode === 'taker' ? 'テイカー' : 'メイカー'}想定`);
  for (const e of r.errors) console.log(`! ${e}`);

  const cols = [
    { h: '', w: 2 },
    { h: '銘柄', w: 6 },
    { h: '出金チェーン', w: 13 },
    { h: '受取', w: 7 },
    { h: '受取USDC', w: 11, right: true },
    { h: '損失額(円)', w: 11, right: true },
    { h: '損失率', w: 8, right: true },
    { h: '価格乖離', w: 8, right: true },
    { h: '注意', w: 0 },
  ];
  for (const amount of r.amounts) {
    const rows = r.rows.filter((x) => x.amountJpy === amount);
    console.log(`\n■ 投入額 ${amount.toLocaleString('ja-JP')} 円`);
    console.log(cols.map((c) => pad(c.h, c.w, c.right)).join(' '));
    for (const x of rows) {
      const mark = x.bestOverall ? '★' : x.bestInChain ? '☆' : '';
      const note = x.status === 'ok' ? x.warnings.join(' / ') : [x.error, ...x.warnings].join(' / ');
      const cells = [
        mark,
        x.asset,
        x.chainLabel,
        x.target,
        x.status === 'ok' ? usdc(x.received) : '-',
        x.status === 'ok' ? yen(x.lossJpy) : '-',
        x.status === 'ok' ? pct(x.lossRate) : '-',
        x.status === 'ok' ? pct(x.priceGapRate) : '-',
        note,
      ];
      console.log(cells.map((c, i) => pad(c, cols[i].w, cols[i].right)).join(' '));
      if (detail && x.status === 'ok') printDetail(x);
    }
  }

  if (r.unconfigured.length) {
    console.log('\n未設定の銘柄（routes.yaml に無い。出金先が対応チェーンなら追加候補）:');
    console.log('  ' + r.unconfigured.map((u) => `${u.asset}(${u.networks.join('/')})`).join(', '));
  }
  console.log(`\n★=全体で最安 ☆=そのチェーンで最安\n※ ${r.notice}`);
}

function printDetail(x: RouteRow) {
  const b = x.breakdown!;
  const sum = Object.values(b).reduce((s, v) => s + v, 0);
  console.log(
    `      内訳(円): スプレッド・スリッページ ${yen(b.spreadSlippage)} / 取引手数料 ${yen(b.tradingFee)} / 出金手数料 ${yen(b.withdrawFee)}` +
      ` / 価格乖離 ${yen(b.priceGap)} / DEXコスト ${yen(b.dexCost)} / ガス代 ${yen(b.gas)}  = 合計 ${yen(sum)}`,
  );
  console.log(
    `      数量 ${x.quantity} → 出金後 ${x.netQuantity} ${x.asset}、bitbank VWAP ${x.vwap?.toFixed(4)}円、DEX単価 ${x.dexUnitPrice?.toFixed(6) ?? '-'} USDC、ガス ${x.gasUsdc?.toFixed(4)} USDC（${x.dexSource ?? '-'}）`,
  );
}
