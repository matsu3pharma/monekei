# API確認メモ

## 確認方法

2026-10-04 に `node scripts/check-apis.js` で全DEXの実レスポンスを取得して確認しました（以前の版では開発環境のネットワーク制限で取得できず、ドキュメントだけを根拠にしていました）。

FR の単位は、**どのDEXでも「金利だけでプレミアムが無いときの基準値」= 8時間あたり 0.01%（1時間あたり 0.00125%、年率 10.95%）** になることを利用して確定させています。BTC・ETH・SOL・DOGE など多くの銘柄がこの基準値ちょうどになっているので、生の値がその何倍になっているかで「何時間あたりの値か」が分かります。

手元で再確認するときは：

```
node scripts/check-apis.js
```

「8h換算」がどのDEXでも 0.01% 前後になっていれば、`intervalHours` は正しく設定されています。

## 一覧

| DEX | 取得元 | 生のFRの単位 | `intervalHours` | 価格 | 出来高 |
|---|---|---|---|---|---|
| Hyperliquid | `POST /info metaAndAssetCtxs` | 1時間あたり | 1 | markPx | dayNtlVlm (USD) |
| dYdX | `/v4/perpetualMarkets` | 1時間あたり | 1 | oraclePrice | volume24H (USD) |
| Aster | `/fapi/v1/premiumIndex` 他 | 1回の支払いあたり（銘柄ごとに 1/2/4/8h） | 8（fundingInfo に無い銘柄だけ） | markPrice | quoteVolume (USDT) |
| Lighter | `/funding-rates` + `/orderBookDetails` | **8時間あたり（確定）** | 8 | mark_price | daily_quote_token_volume (USDC) |
| Paradex | `/markets/summary` + `/markets` | **8時間あたり（確定）** | 8 | mark_price | volume_24h (USD) |
| Variational | `/metadata/stats` | **年率** | 8760 | mark_price | volume_24h (USD) |
| Nado | `/archive/v2/contracts` | 24時間あたり | 24 | mark_price | quote_volume (USDT0) |
| Arcus | `/v1/markets` | 1時間あたり | 1 | markPrice | volume24hNotional (USD) |
| BULK | `/api/v1/stats` | 1時間あたり | 1 | markPrice | quoteVolume (USD) |
| Ondo Perps | `/v1/perps/contracts` | 1時間あたり | 1 | 板の仲値 | usdVolume (USD) |
| SoDEX | `/perps/markets/tickers` + `/symbols` | 1回の支払いあたり（現状全銘柄1h） | 1（symbols が取れないときだけ） | markPrice | quoteVolume (USDC) |
| PopDEX | `/public/market/tickers` + `/market/funding-rate` | 1回の支払いあたり（現状全銘柄1h） | 1（funding-rate が取れないときだけ） | markPrice | turnover24h (USDT) |
| Decibel | `/api/v1/prices` 他（**APIキー必須**） | 1時間あたり（bps） | 1 | mark_px | volume_24h |

---

## Hyperliquid

- `POST https://api.hyperliquid.xyz/info` `{"type":"metaAndAssetCtxs"}` → `[meta, ctxs]`
- `meta.universe[i]` と `ctxs[i]` が位置で対応。数値はすべて文字列
- **FR: 1時間あたり**。実測 BTC `funding=0.0000125`（= 基準値）
- 1000倍銘柄は `kPEPE` 形式 → `1000PEPE` に正規化
- レート制限: IPあたり 1200 weight/分。`metaAndAssetCtxs` は weight 20

## dYdX v4

- `GET https://indexer.dydx.trade/v4/perpetualMarkets` → `{ markets: { "BTC-USD": {...} } }`
- `nextFundingRate` は1時間あたりの予測値（実測 BTC `-0.0000040`）
- 出来高がかなり小さい（BTC でも 24h 約 84 万ドル）。出来高フィルタで弾かれやすい
- レート制限ヘッダ: `ratelimit-limit=100`

## Aster

- `premiumIndex` / `fundingInfo` / `ticker/24hr`（Binance 互換）
- `fundingInfo` は**全銘柄（770）**が載っていた。`fundingIntervalHours` の分布: 1h=95, 2h=3, 4h=359, 8h=313
  - そのため `config.json` の `intervalHours` は、fundingInfo の取得に失敗したときだけ使われる
- レート制限ヘッダ: `x-mbx-used-weight-1m`

## Lighter

- `GET /api/v1/funding-rates` → `{ funding_rates: [{ market_id, exchange, symbol, rate }] }`（`exchange` は binance / bybit / hyperliquid / lighter）
- **`rate` は 8時間あたりに正規化された値（確定）**。根拠：
  1. 同じレスポンスの `exchange: "hyperliquid"` の BTC が `0.0001`。Hyperliquid 自身の値は 1時間あたり `0.0000125` で、その 8 倍と一致
  2. Lighter 自身の `GET /api/v1/fundings?market_id=1&resolution=1h` は、毎時の支払いレートを **% 表記**で `"rate":"0.0012"`（= 0.000012/時）と返しており、`funding-rates` の lighter BTC `0.000096` = 0.000012 × 8 と一致
- 支払いは毎時。`intervalHours: 8` で正しい
- 銘柄表記は `1000PEPE`, `1000SHIB`, `1000BONK`, `1000FLOKI` 形式（Hyperliquid の `kPEPE` 正規化後と一致）
- 価格は `mark_price`（文字列）がある

## Paradex

- `GET /v1/markets/summary?market=ALL` の `funding_rate` は **8時間あたり（確定）**
  - `GET /v1/funding/data?market=BTC-USD-PERP` が `funding_rate` と `funding_rate_8h` を並べて返し、`funding_period_hours: 8` のとき両者が一致
  - BTC `0.000093`（8h）は他DEXの BTC と同じ水準。1時間あたりだとすると年率 80% 超になり不自然
- `/v1/markets` の `funding_period_hours` は全 63 銘柄 8
- `funding_multiplier` が 0.5 の銘柄（株・商品・指数の 21 銘柄）があるが、`funding_rate` は適用後の値（`funding_premium / 価格` と一致）なので追加の補正は不要
- **`volume_24h` は USD 建て（確定）**。BTC で `660108` → BTC 建てなら 66 万 BTC になってしまい不可能。`total_volume`（累計）も USD
- レート制限ヘッダ: `x-ratelimit-limit=50`（1秒窓）

## Variational Omni

- `GET https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats` → `{ listings: [...] }`（約 560 銘柄）
- **`funding_rate` は年率の小数**。公式ドキュメントには単位の記載が無いが、SOL・DOGE・ZRO などが `0.1095` = 年 10.95% = 基準値ちょうど。BTC `0.0772` は 8h 換算 0.0071% で他DEXと同水準
- `funding_interval_s` は支払い間隔（3600 / 14400 / 28800）で、レートの単位には関係しない
- `funding_interval_s = 0` の銘柄（`US100S`, `XAUS` など休止中の RWA、FR=0）は除外
- **価格は `quotes.base` の bid/ask の中間値を使う**（2026-10-05 実測）
  - `mark_price` は数分に1回しか変わらない（6分間の計測で1回だけ更新。同じ間に Hyperliquid の BTC は ±50 ドル動いていた）
  - `quotes` は約1分ごとに更新され、`quotes.updated_at` で古さが分かる（取得時点で 15〜115 秒前）
  - レスポンスは Cloudflare のキャッシュ経由（`cache-control: public, s-maxage=60, max-age=30`、`cf-cache-status: HIT`）。公式ドキュメントにも「bid/ask は最大 600 秒キャッシュされることがある」とある
  - キャッシュを避ける工夫（URL に毎回違うパラメータを付けるなど）はしない。提供側が意図したキャッシュを迂回することになるため
  - 古さは `priceAgeMs` として持ち、`alert.maxPriceAgeSeconds`（既定 90 秒）より古い価格は価格乖離の判定から外す
- レート制限: IP あたり 10 リクエスト / 10 秒（30 秒ごと 1 回なので問題なし）

## Nado

- `GET https://api.prod.nado.xyz/archive/v2/contracts` → `{ "BTC-PERP_USDT0": {...} }`（82 銘柄、すべて perpetual）
- **`funding_rate` は 24時間あたり**（公式: "Current 24hr funding rate. Can compute hourly funding rate dividing by 24."）。実測 ETH `0.0003` = 0.0000125 × 24
- 支払いは毎時
- 銘柄は `base_currency`（`BTC-PERP`, `kPEPE-PERP`）から正規化
- `gateway` 系エンドポイントは `Accept-Encoding: gzip` 必須（Node の fetch は自動で付ける）

## Arcus

- `GET https://api.arcus.xyz/v1/markets` → `{ markets: [...] }`（認証不要）
- `fundingRate`（直近確定）・`nextFundingRate`（今の時間の予測）とも **1時間あたり**。実測 ETH `0.0000125`。予測値の方を使う
- `status: "ONLINE"` のみ使用。株・指数・商品も多い（`category`）
- 注意: `QNT-USD` は株（Quantinuum、$46）で、他DEXの仮想通貨 QNT（$260）とは別物。後述の「別物の除外」で自動的に比較から外れる

## BULK

- `GET https://mainnet-api1.bulk.trade/api/v1/stats` → `{ markets: [{ symbol, fundingRate, fundingRateAnnualized, markPrice, quoteVolume }] }`
- **`fundingRate` は 1時間あたり**（`fundingRateAnnualized` = ×8760 と一致、公式「毎時」）
- `GET /exchangeInfo` の `status` が `TRADING` の銘柄だけ使う（2026-10 時点で 22 銘柄中 8 銘柄、残りは `SUSPENDED`）
- `stats`（銘柄指定なし）は 600 秒キャッシュ。FR・価格は最大 10 分遅れることがある

## Ondo Perps

- `GET https://api.ondoperps.xyz/v1/perps/contracts`（認証不要）→ `{ result: [...] }`
- **FR は毎時**（公式「Funding is paid every hour」）。`fundingRate`（直近確定）と `nextFundingRate`（予測）。実測 BTC `0.0000125`
- マーク価格のフィールドが無いので、`bid`/`ask` の仲値 → `lastPrice` → `indexPrice` の順で使う
- 銘柄は `BTC-USD.P` 形式。株・ETF・商品が中心

## SoDEX

- `GET https://mainnet-gw.sodex.dev/api/v1/perps/markets/tickers`（認証不要）
- `fundingRate` は 1回の支払いあたり。`/perps/markets/symbols` の `fundingInterval`（秒）が全 99 銘柄 3600 → **1時間あたり**。実測 XLM `0.0000125`
- `symbols` の `status` が `TRADING` のものだけ（`HALT` を除外）
- 銘柄は `BTC-USD`、`1000PEPE-USD` 形式
- レート制限ヘッダ: `x-ratelimit-limit=6000`

## PopDEX

- REST は `https://api.popdex.xyz`（DefiLlama のアダプタにある `api.popdex.ai` はこの環境から Cloudflare で拒否された）
- `GET /api/v1/public/market/tickers?category=Futures`（ページング: `limit` 最大 100・`cursor`）
- `GET /api/v1/market/funding-rate`（パスに `public` が付かない点に注意）→ `fundingRate` と `fundingRateInterval`（時間）
  - tickers の `fundingRate` は小数 6 桁に丸められているので、こちらを優先
  - 公式: FR は `Clamp(8h率) × (fundingInterval / 8)` で、**1回の支払いあたり**。現状は全 66 銘柄 1h
- 出来高は `turnover24h`（USDT 建て）
- レート制限: IP あたり 1200 weight/分、tickers / funding-rate は各 weight 2

## Decibel（APIキー必須・既定で無効）

- REST `https://api.mainnet.aptoslabs.com/decibel/api/v1/...` は**すべて Bearer トークン必須**（キー無しは `401 anonymous requests are not allowed`）
  - トークンは Geomi（https://geomi.dev）で発行。手順は https://docs.decibel.trade/quickstart/node-api-key
- `GET /prices` → `[{ market(アドレス), mark_px, funding_rate_bps, is_funding_positive, funding_period_s }]`
  - **`funding_rate_bps` は 1時間あたり・bps**（公式スキーマ: "Hourly funding rate in basis points"）。符号は `is_funding_positive`
- `GET /markets` で `market_addr` → `market_name`（`BTC/USD` 形式）、`GET /asset_contexts` で `volume_24h`
- **実データでは未確認**（キーが無いため）。使う場合は `config.json` の `exchanges.decibel` に `apiKey` を入れ、`enabled` を `true` にして `node scripts/check-apis.js` で確認する

## 追加しなかったDEX

| DEX | 理由 |
|---|---|
| JTX（Jito Labs） | 2026-10 時点で現物のみ。Perp は Phoenix との連携で「今後」とされており、公開の Perp API が無い |

---

## 同名の別物の除外（core.js）

DEX が増えると、株のティッカーと仮想通貨のティッカーがぶつかることがある（例: Arcus の `QNT` = Quantinuum 株 $46、他DEXの `QNT` = Quant $260。Aster の `BB` も他DEXの `BB` と価格が 1000 倍違う）。

- 3 つ以上のDEXに同名銘柄があるとき、価格が中央値から `maxPriceRatioSanity` 倍（既定 1.2 倍）以上離れたDEXは「別物」として FR・価格・出来高の比較から外す（詳細表示には「別物？除外」と出る）
- 2 つのDEXしか無い、または 2 対 2 に割れていてどちらが本物か決められないときは、従来どおり銘柄全体を ⚠（suspicious）にして通知対象から外す

## CORS

すべて Node（サーバー側）から取得し、ブラウザは `localhost` の `/api/snapshot` しか叩かないため、CORS は関係しない。
