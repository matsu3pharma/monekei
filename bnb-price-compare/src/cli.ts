import { parseArgs } from 'node:util';
import { buildComparison, type Comparison } from './calc/compare.ts';
import { loadConfig } from './config.ts';
import { takeSnapshot } from './snapshot.ts';

const { values } = parseArgs({
  options: {
    amount: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const cfg = loadConfig();
const amount = Number(values.amount ?? cfg.amounts_jpy[0]);
const snap = await takeSnapshot(cfg);
const cmp = buildComparison(snap.results, snap.fx, amount, snap.ts);

if (values.json) {
  console.log(JSON.stringify(cmp, null, 2));
} else {
  print(cmp);
}

function print(c: Comparison) {
  const yen = (n?: number) => (n === undefined ? '-' : `¥${Math.round(n).toLocaleString('ja-JP')}`);
  const usd = (n?: number) => (n === undefined ? '-' : `$${n.toFixed(2)}`);
  const pct = (n?: number, d = 2) => (n === undefined ? '-' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(d)}%`);
  const fx = c.fx;
  console.log(
    `USD/JPY ${fx.mid.toFixed(3)}（${fx.source}${fx.marketClosed ? '・市場クローズ中' : ''}） ` +
      `基準(Perp中央値) ${usd(c.refUsd)} = ${yen(c.refJpy)}  比較金額 ${yen(c.amountJpy)}\n`,
  );
  console.table(
    c.rows.map((r) =>
      r.ok
        ? {
            取引所: r.name,
            種別: r.kind === 'cex' ? '国内CEX' : 'Perp',
            '仲値(円)': yen(r.midJpy),
            '仲値($)': usd(r.midUsd),
            乖離: pct(r.deviationPct),
            スプレッド: r.spreadPct === undefined ? '-' : `${(r.spreadPct * 100).toFixed(3)}%`,
            '買い実効(手数料込)': yen(r.buyJpyNet),
            '売り実効(手数料込)': yen(r.sellJpyNet),
            'FR(8h)': pct(r.funding8h, 4),
            注意: r.warnings.join(' / '),
          }
        : { 取引所: r.name, 種別: r.kind === 'cex' ? '国内CEX' : 'Perp', 注意: `取得失敗: ${r.error}` },
    ),
  );
  if (c.bestBuy && c.bestSell) {
    console.log(
      `最安の買い: ${c.bestBuy.name} ${yen(c.bestBuy.priceJpy)} / 最高の売り: ${c.bestSell.name} ${yen(c.bestSell.priceJpy)}` +
        (c.gapPct !== undefined ? `  差 ${pct(c.gapPct)}（送金・為替コスト別）` : ''),
    );
  }
}
