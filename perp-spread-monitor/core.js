'use strict';
// 比較ロジック。純粋関数のみ（I/Oなし）。

const HOURS_PER_YEAR = 24 * 365;

function toHourly(rate, intervalHours) {
  if (rate == null || !(intervalHours > 0)) return null;
  return rate / intervalHours;
}

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// byDex: { [dex]: Row[] }
// opts: { watchlist: string[](正規化済み), maxPriceRatioSanity, alert: {...} }
// 戻り値: 銘柄ごとの比較結果（FR差年率の降順）
function compare(byDex, opts = {}) {
  const sanity = opts.maxPriceRatioSanity > 1 ? opts.maxPriceRatioSanity : 1.2;
  const watch = Array.isArray(opts.watchlist) && opts.watchlist.length ? new Set(opts.watchlist) : null;

  // 銘柄 -> dex -> row（同じDEXに同名が複数あれば出来高の大きい方）
  const groups = new Map();
  for (const [dex, rows] of Object.entries(byDex || {})) {
    for (const row of rows || []) {
      if (!row || !row.symbol) continue;
      if (watch && !watch.has(row.symbol)) continue;
      let g = groups.get(row.symbol);
      if (!g) groups.set(row.symbol, (g = new Map()));
      const prev = g.get(dex);
      if (!prev || (row.volume24h || 0) > (prev.volume24h || 0)) g.set(dex, row);
    }
  }

  const results = [];
  for (const [symbol, g] of groups) {
    if (g.size < 2) continue; // 2つ以上のDEXに上場している銘柄だけ
    let entries = [...g].map(([dex, r]) => ({
      dex,
      raw: r.raw,
      price: r.price,
      fundingHourly: r.fundingHourly,
      fundingRaw: r.fundingRaw ?? null,
      intervalHours: r.intervalHours ?? null,
      volume24h: r.volume24h ?? null,
      priceAgeMs: r.priceAgeMs ?? null,
      outlier: false,
    }));

    // 3つ以上のDEXに同名銘柄があるとき、価格が中央値から sanity 倍以上離れたものは
    // 「同じ名前の別物」（株の QNT と仮想通貨の QNT など）として比較から外す
    markOutliers(entries, sanity);
    const all = entries;
    entries = all.filter((e) => !e.outlier);
    if (entries.length < 2) {
      for (const e of all) e.outlier = false;
      entries = all;
    }

    const minVol = opts.alert && opts.alert.minVolume24hUsd > 0 ? opts.alert.minVolume24hUsd : 0;
    const maxAge = opts.alert && opts.alert.maxPriceAgeSeconds > 0 ? opts.alert.maxPriceAgeSeconds * 1000 : 0;
    const { fr, price } = pickPairs(entries, sanity, maxAge);

    // 出来高: 全DEXのうち一番薄いもの（参考値）
    const vols = entries.map((e) => e.volume24h).filter(isNum);
    const minVolume24h = vols.length ? Math.min(...vols) : null;

    // 出来高が minVolume24hUsd 以上のDEXだけで比べ直したもの。
    // 薄いDEXが1つ混ざっているだけで銘柄ごと消えないよう、画面の「出来高フィルタ」と通知はこちらを使う
    let liquid = null;
    if (minVol > 0) {
      const ok = entries.filter((e) => isNum(e.volume24h) && e.volume24h >= minVol);
      if (ok.length >= 2) liquid = { dexCount: ok.length, dexes: ok.map((e) => e.dex), ...pickPairs(ok, sanity, maxAge) };
    }

    const result = {
      symbol,
      dexCount: entries.length,
      entries: all,
      fr,
      price,
      suspicious: !!(price && price.suspicious),
      minVolume24h,
      liquid,
    };
    result.alert = opts.alert ? evaluateAlert(result, opts.alert) : { fr: false, price: false };
    results.push(result);
  }

  results.sort((a, b) => (b.fr ? b.fr.aprPct : -Infinity) - (a.fr ? a.fr.aprPct : -Infinity));
  return results;
}

function legVolume(a, b) {
  const v = [a.volume24h, b.volume24h].filter(isNum);
  return v.length === 2 ? Math.min(...v) : null;
}

// FR が一番高いDEX（ショート先）と一番低いDEX（ロング先）、価格が一番高い/安いDEXを選ぶ。
// 並べ替えて両端を取るので、全DEXが同じ値でも同じDEXが両側に来ることはない。
function pickPairs(entries, sanity, maxPriceAgeMs) {
  let fr = null;
  const frs = entries.filter((e) => isNum(e.fundingHourly)).sort((a, b) => a.fundingHourly - b.fundingHourly);
  if (frs.length >= 2) {
    const lo = frs[0];
    const hi = frs[frs.length - 1];
    const diff = hi.fundingHourly - lo.fundingHourly;
    const pricesOk = isNum(hi.price) && hi.price > 0 && isNum(lo.price) && lo.price > 0;
    fr = {
      hourlyPct: diff * 100,
      aprPct: diff * HOURS_PER_YEAR * 100,
      shortOn: hi.dex, // FRが一番高い = ショートでFRを受け取る側
      longOn: lo.dex,
      shortPrice: hi.price,
      longPrice: lo.price,
      shortPriceAgeMs: hi.priceAgeMs ?? null,
      longPriceAgeMs: lo.priceAgeMs ?? null,
      shortHourlyPct: hi.fundingHourly * 100,
      longHourlyPct: lo.fundingHourly * 100,
      // この2つのDEX間の価格差（実際に両建てするときに効く差）
      pricePct: pricesOk ? (Math.max(hi.price, lo.price) / Math.min(hi.price, lo.price) - 1) * 100 : null,
      minVolume24h: legVolume(hi, lo),
    };
  }

  // 価格が古すぎるDEX（キャッシュ等で遅れている）は、価格乖離の判定に使わない
  let price = null;
  const ps = entries
    .filter((e) => isNum(e.price) && e.price > 0 && !(maxPriceAgeMs > 0 && isNum(e.priceAgeMs) && e.priceAgeMs > maxPriceAgeMs))
    .sort((a, b) => a.price - b.price);
  if (ps.length >= 2) {
    const lo = ps[0];
    const hi = ps[ps.length - 1];
    const ratio = hi.price / lo.price;
    price = {
      pct: (ratio - 1) * 100,
      highOn: hi.dex,
      lowOn: lo.dex,
      highPrice: hi.price,
      lowPrice: lo.price,
      highPriceAgeMs: hi.priceAgeMs ?? null,
      lowPriceAgeMs: lo.priceAgeMs ?? null,
      suspicious: ratio >= sanity,
      minVolume24h: legVolume(hi, lo),
    };
  }
  return { fr, price };
}

function markOutliers(entries, sanity) {
  const ps = entries.map((e) => e.price).filter((p) => isNum(p) && p > 0).sort((a, b) => a - b);
  if (ps.length < 3) return;
  const mid = ps.length >> 1;
  const median = ps.length % 2 ? ps[mid] : Math.sqrt(ps[mid - 1] * ps[mid]);
  for (const e of entries) {
    if (!(isNum(e.price) && e.price > 0)) continue;
    const ratio = e.price > median ? e.price / median : median / e.price;
    if (ratio >= sanity) e.outlier = true;
  }
}

// 通知の判定に使う比較結果。出来高の下限があるときは「出来高が足りているDEXだけ」の比較を使う
function alertView(result, alert) {
  return alert && alert.minVolume24hUsd > 0 ? result.liquid : result;
}

function evaluateAlert(result, alert) {
  const v = alertView(result, alert);
  const ok = !!v && !result.suspicious;
  return {
    fr: !!(ok && v.fr && v.fr.aprPct >= alert.frSpreadAprPct),
    price: !!(ok && v.price && v.price.pct >= alert.priceSpreadPct),
    useLiquid: !!(alert && alert.minVolume24hUsd > 0),
  };
}

// アラート判定済みの結果から通知候補を作る
function alertCandidates(results) {
  const out = [];
  for (const r of results) {
    if (!r.alert) continue;
    const v = r.alert.useLiquid ? r.liquid : r;
    if (r.alert.fr && v && v.fr) {
      const f = v.fr;
      out.push({
        key: `fr|${r.symbol}|${f.shortOn}|${f.longOn}`,
        type: 'fr',
        symbol: r.symbol,
        aprPct: f.aprPct,
        hourlyPct: f.hourlyPct,
        shortOn: f.shortOn,
        longOn: f.longOn,
        shortPrice: f.shortPrice,
        longPrice: f.longPrice,
        pricePct: f.pricePct,
        minVolume24h: f.minVolume24h,
        durationMs: f.streak ? f.streak.durationMs : null,
      });
    }
    if (r.alert.price && v && v.price) {
      const p = v.price;
      out.push({
        key: `price|${r.symbol}|${p.highOn}|${p.lowOn}`,
        type: 'price',
        symbol: r.symbol,
        pricePct: p.pct,
        highOn: p.highOn,
        lowOn: p.lowOn,
        highPrice: p.highPrice,
        lowPrice: p.lowPrice,
        aprPct: v.fr ? v.fr.aprPct : null,
        minVolume24h: p.minVolume24h,
        durationMs: p.streak ? p.streak.durationMs : null,
      });
    }
  }
  return out;
}

// lastSent: { [key]: 最終通知時刻(ms) }。この関数が更新する。
// 戻り値: クールダウンを抜けて今回通知すべき候補
function applyCooldown(candidates, lastSent, now, cooldownMinutes) {
  const cooldownMs = Math.max(0, Number(cooldownMinutes) || 0) * 60000;
  const fresh = [];
  for (const c of candidates) {
    const t = lastSent[c.key];
    if (t != null && now - t < cooldownMs) continue;
    lastSent[c.key] = now;
    fresh.push(c);
  }
  // 古い記録を掃除
  for (const k of Object.keys(lastSent)) {
    if (now - lastSent[k] >= cooldownMs) {
      if (!fresh.some((c) => c.key === k)) delete lastSent[k];
    }
  }
  return fresh;
}

// ---------- 差が続いている時間 ----------
// state: { [key]: { pair, since, lastSeen, sum, n, fromStart } }。この関数が更新する（ファイルに保存して再起動後も引き継げる）。
// 「同じDEXの組み合わせのまま、差がしきい値以上」が途切れずに続いている間を1つの連続とみなす。
// opts: { alert, maxGapMs: これより長く観測が空いたら連続とみなさない, firstRound: 起動して最初の取得か }
// 結果の各 fr / price（と liquid.fr / liquid.price）に streak = { since, durationMs, avg, samples, fromStart } を付ける。
function updateStreaks(results, state, now, opts = {}) {
  const alert = opts.alert || {};
  const maxGapMs = opts.maxGapMs > 0 ? opts.maxGapMs : 120000;
  const kinds = [
    ['fr', alert.frSpreadAprPct, (x) => x.aprPct, (x) => `${x.shortOn}>${x.longOn}`],
    ['price', alert.priceSpreadPct, (x) => x.pct, (x) => `${x.highOn}>${x.lowOn}`],
  ];
  for (const r of results) {
    for (const [viewName, v] of [['all', r], ['liquid', r.liquid]]) {
      if (!v) continue;
      for (const [kind, threshold, value, pairOf] of kinds) {
        const key = `${viewName}|${kind}|${r.symbol}`;
        const x = v[kind];
        if (!x || r.suspicious || !(isNum(threshold) && value(x) >= threshold)) {
          delete state[key];
          continue;
        }
        const pair = pairOf(x);
        let st = state[key];
        if (!st || st.pair !== pair || now - st.lastSeen > maxGapMs) {
          st = state[key] = { pair, since: now, lastSeen: now, sum: 0, n: 0, fromStart: !!opts.firstRound };
        }
        st.lastSeen = now;
        st.sum += value(x);
        st.n += 1;
        x.streak = { since: st.since, durationMs: now - st.since, avg: st.sum / st.n, samples: st.n, fromStart: st.fromStart };
      }
    }
  }
  // DEX の取得失敗などで見えなくなったものは、maxGapMs を過ぎたら捨てる
  for (const k of Object.keys(state)) {
    if (now - state[k].lastSeen > maxGapMs) delete state[k];
  }

  // 通知を「差が minDurationMinutes 分以上続いたもの」に限る（0 なら制限なし）
  const minMs = Math.max(0, Number(alert.minDurationMinutes) || 0) * 60000;
  if (minMs > 0) {
    for (const r of results) {
      if (!r.alert) continue;
      const v = r.alert.useLiquid ? r.liquid : r;
      const long = (x) => !!(x && x.streak && x.streak.durationMs >= minMs);
      r.alert.fr = r.alert.fr && long(v && v.fr);
      r.alert.price = r.alert.price && long(v && v.price);
    }
  }
  return state;
}

module.exports = { toHourly, compare, evaluateAlert, alertCandidates, applyCooldown, updateStreaks, HOURS_PER_YEAR };
