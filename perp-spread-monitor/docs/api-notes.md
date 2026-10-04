# API確認メモ

## 確認方法について（重要）

このアプリを作った環境（クラウド上の開発コンテナ）からは、5つのDEXのAPIホストすべてへの通信がネットワーク制限でブロックされていました（`HTTP 403 Host not in allowlist`）。
そのため、**実際のレスポンスはまだ取得できていません**。下の内容は各DEXの公式ドキュメント・公開情報をもとにしたもので、アダプタはその形に合わせて実装しています。

手元のPCで次を実行すると、実際のレスポンスの形と BTC/ETH の値（1h換算・8h換算）が表示されます。

```
node scripts/check-apis.js
```

表示された値を各DEXの公式画面のFR表示と見比べて、`config.json` の `intervalHours` を確定させてください。

---

## Hyperliquid

- `POST https://api.hyperliquid.xyz/info` `{"type":"metaAndAssetCtxs"}` → `[meta, ctxs]`
- `meta.universe[i]`（`name`, `szDecimals`, `maxLeverage`, `isDelisted?`）と `ctxs[i]`（`markPx`, `oraclePx`, `midPx`, `funding`, `dayNtlVlm`, `openInterest` …）が位置で対応
- 数値はすべて文字列
- **FR間隔: 1時間**（`funding` は1時間あたりの値）
- 1000倍銘柄は `kPEPE`, `kBONK`, `kSHIB` などの表記
- レート制限: IPあたり 1200 weight/分。`metaAndAssetCtxs` は weight 20 → 30秒ごと（2回/分）は問題なし

## dYdX v4

- `GET https://indexer.dydx.trade/v4/perpetualMarkets` → `{ markets: { "BTC-USD": {...} } }`
- 使用フィールド: `ticker`, `status`（`ACTIVE` のみ）, `oraclePrice`, `nextFundingRate`, `volume24H`（USD）
- **FR間隔: 1時間**。公式ドキュメントでは「資金調達は毎時、直近60分のプレミアム平均から計算」とされており、`nextFundingRate` は1時間あたりの予測値
- dYdX はマーク価格ではなくオラクル価格を使う（仕様どおり）
- レート制限: 公開インデクサは IP あたり数百リクエスト/分程度。30秒ごとの1リクエストは問題なし

## Aster

- Binance 互換 API
- `GET /fapi/v1/premiumIndex` → 配列 `{symbol, markPrice, indexPrice, lastFundingRate, nextFundingTime, ...}`
- `GET /fapi/v1/fundingInfo` → **存在する**（公式 API ドキュメントに記載あり）。配列 `{symbol, interestRate, time, fundingIntervalHours, fundingFeeCap, fundingFeeFloor}`
  - Binance と同様、**FRパラメータが調整された銘柄だけ**が載る想定。載っていない銘柄は 8 時間（`config.json` の `intervalHours`）として扱う
  - 例として ZORAUSDT は 4 時間
- `GET /fapi/v1/ticker/24hr` → `quoteVolume`（USDT建て出来高）
- USDT 建て（`symbol` が `USDT` で終わる）のみ使用
- レート制限: 2400 weight/分。3本合計で weight 50 程度 → 30秒ごとは問題なし

## Lighter

- ベース `https://mainnet.zklighter.elliot.ai/api/v1`
- `GET /funding-rates` → `{ code, funding_rates: [{ market_id, exchange, symbol, rate }] }`
  - `exchange` に `binance`, `bybit`, `hyperliquid`, `lighter` などが混ざる → `lighter` のみ使用
- `GET /orderBookDetails?filter=perp` → `{ code, order_book_details: [{ market_id, symbol, status, last_trade_price, daily_quote_token_volume, ... }] }`
  - 価格は `mark_price` があればそれ、なければ `last_trade_price`
  - 出来高は `daily_quote_token_volume`（USDC建て）
- **FR間隔: 支払いは1時間ごと**（公式ドキュメント）。ただし `/funding-rates` の `rate` は、他取引所と並べて比較するための値で、**8時間あたりに正規化されている**という情報が複数ある（funding-rates に Binance 等の 8h FR と並べて返している点とも整合）。
  - → 暫定で `intervalHours: 8` のまま。**要確認**：`check-apis.js` の BTC の「8h換算」が Lighter 公式画面の FR と一致するか、「1h換算」が一致するかで判定
- 銘柄表記: `1000PEPE` 形式か `PEPE` 形式かは**未確認**（`check-apis.js` が PEPE/SHIB/BONK 系の表記を一覧表示する）
- レート制限: 公開エンドポイントは IP あたり 60 リクエスト/分程度とされる。30秒ごとに2本なので問題なし

## Paradex

- `GET https://api.prod.paradex.trade/v1/markets/summary?market=ALL` → `{ results: [{ symbol, mark_price, last_traded_price, funding_rate, volume_24h, open_interest, ... }] }`
  - `-USD-PERP` で終わるものだけ使用（オプション `BTC-USD-70000-C` などを除外）
- `GET /v1/markets` → `{ results: [{ symbol, funding_period_hours, ... }] }`
  - `funding_period_hours` があれば銘柄ごとにそれを使う（無ければ `config.json` の値）
- **FR間隔: 8時間**。公式ドキュメント「Funding Premium は8時間あたりの額」「Funding Interval は全銘柄 8h」。
  - 2026年6月の Funding V2 で、支払いは毎秒の連続計算に変わったが、表示上の `funding_rate` は引き続き 8 時間あたりの値とされている
- `volume_24h` は USD 建てとして扱う（**要確認**）
- レート制限: 公開 API は IP あたり 1500 リクエスト/分。問題なし

## CORS

すべて Node（サーバー側）から取得し、ブラウザは `localhost` の `/api/snapshot` しか叩かないため、CORS は関係しない。

## 仕様（SPEC §3）との食い違い・補足

| 項目 | SPEC | 実装 |
|---|---|---|
| Lighter FR | 暫定 8h | 支払いは毎時だが、API の `rate` は 8h 正規化の可能性が高いので 8h のまま。要実機確認 |
| Paradex FR | 暫定 8h | ドキュメント上 8h で確定。加えて `/v1/markets` の `funding_period_hours` があれば銘柄ごとに優先 |
| dYdX FR | 1h（要確認） | ドキュメント上 1h で確定 |
| Aster fundingInfo | 要確認 | 存在する（ドキュメント記載）。取得に失敗しても全体は止めず、全銘柄 `intervalHours` 扱いにする |
| 間隔の優先順位 | config で上書き | Aster / Paradex は「API が返す銘柄ごとの間隔」→「config の intervalHours」の順。それ以外は config の値 |
