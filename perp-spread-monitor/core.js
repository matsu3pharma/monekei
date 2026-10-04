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
    const entries = [...g].map(([dex, r]) => ({
      dex,
      raw: r.raw,
      price: r.price,
      fundingHourly: r.fundingHourly,
      fundingRaw: r.fundingRaw ?? null,
      intervalHours: r.intervalHours ?? null,
      volume24h: r.volume24h ?? null,
    }));

    // FR乖離
    let fr = null;
    const frs = entries.filter((e) => isNum(e.fundingHourly));
    if (frs.length >= 2) {
      let hi = frs[0], lo = frs[0];
      for (const e of frs) {
        if (e.fundingHourly > hi.fundingHourly) hi = e;
        if (e.fundingHourly < lo.fundingHourly) lo = e;
      }
      const diff = hi.fundingHourly - lo.fundingHourly;
      fr = {
        hourlyPct: diff * 100,
        aprPct: diff * HOURS_PER_YEAR * 100,
        shortOn: hi.dex, // FRが一番高い = ショートでFRを受け取る側
        longOn: lo.dex,
      };
    }

    // 価格乖離
    let price = null;
    const ps = entries.filter((e) => isNum(e.price) && e.price > 0);
    if (ps.length >= 2) {
      let hi = ps[0], lo = ps[0];
      for (const e of ps) {
        if (e.price > hi.price) hi = e;
        if (e.price < lo.price) lo = e;
      }
      const ratio = hi.price / lo.price;
      price = {
        pct: (ratio - 1) * 100,
        highOn: hi.dex,
        lowOn: lo.dex,
        suspicious: ratio >= sanity,
      };
    }

    // 出来高: 薄い方が実際の制約になるので最小値
    const vols = entries.map((e) => e.volume24h).filter(isNum);
    const minVolume24h = vols.length ? Math.min(...vols) : null;

    const result = {
      symbol,
      dexCount: entries.length,
      entries,
      fr,
      price,
      suspicious: !!(price && price.suspicious),
      minVolume24h,
    };
    result.alert = opts.alert ? evaluateAlert(result, opts.alert) : { fr: false, price: false };
    results.push(result);
  }

  results.sort((a, b) => (b.fr ? b.fr.aprPct : -Infinity) - (a.fr ? a.fr.aprPct : -Infinity));
  return results;
}

function volumeOk(result, minVolume) {
  if (!(minVolume > 0)) return true;
  return isNum(result.minVolume24h) && result.minVolume24h >= minVolume;
}

function evaluateAlert(result, alert) {
  const vol = volumeOk(result, alert.minVolume24hUsd);
  const ok = vol && !result.suspicious;
  return {
    fr: !!(ok && result.fr && result.fr.aprPct >= alert.frSpreadAprPct),
    price: !!(ok && result.price && result.price.pct >= alert.priceSpreadPct),
  };
}

// アラート判定済みの結果から通知候補を作る
function alertCandidates(results) {
  const out = [];
  for (const r of results) {
    if (r.alert && r.alert.fr) {
      out.push({
        key: `fr|${r.symbol}|${r.fr.shortOn}|${r.fr.longOn}`,
        type: 'fr',
        symbol: r.symbol,
        aprPct: r.fr.aprPct,
        hourlyPct: r.fr.hourlyPct,
        shortOn: r.fr.shortOn,
        longOn: r.fr.longOn,
        pricePct: r.price ? r.price.pct : null,
        minVolume24h: r.minVolume24h,
      });
    }
    if (r.alert && r.alert.price) {
      out.push({
        key: `price|${r.symbol}|${r.price.highOn}|${r.price.lowOn}`,
        type: 'price',
        symbol: r.symbol,
        pricePct: r.price.pct,
        highOn: r.price.highOn,
        lowOn: r.price.lowOn,
        aprPct: r.fr ? r.fr.aprPct : null,
        minVolume24h: r.minVolume24h,
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

module.exports = { toHourly, compare, evaluateAlert, alertCandidates, applyCooldown, HOURS_PER_YEAR };
