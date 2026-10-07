# bitbank-dex-scout

bitbank で日本円を暗号資産に替え → 自分のウォレットへ出金 → 各チェーンの DEX で USDC に替えるとき、
**どの銘柄×どのチェーンなら損失が最小か** を一覧にする読み取り専用ツール。

- 注文・出金・スワップ・署名は一切しない。APIキーや秘密鍵も扱わない（入力欄もない）
- 損失の基準：同じ日本円を USD/JPY でそのまま USD にした場合との差
- 表示は `config/routes.yaml` の出金手数料に基づく **試算**。DEX見積りは数秒で変わる目安なので、実際に送る前は少額でテストすること

## 使い方

Node.js 20 以上。

```bash
npm install
npm start            # ダッシュボード → http://localhost:3000
```

CLI:

```bash
npm run scan -- --amount 100000 --chain polygon          # 10万円・Polygon のルートだけ
npm run scan -- --amount 10000,100000 --detail           # 複数金額・内訳つき
npm run scan -- --amount 100000 --maker                  # メイカー（指値）想定
npm run scan -- --amount 100000 --json > result.json     # JSON出力（通知ボットなどに流用可）
npm test                                                 # 計算ロジックの単体テスト
```

## デスクトップのアイコンから起動する

ターミナルを使わずに、デスクトップのアイコンをダブルクリックで起動できるようにする。
事前に Node.js（<https://nodejs.org> の LTS 版）をインストールしておくこと。

**Mac**

1. Finder で `bitbank-dex-scout/launcher/` を開き、`make-desktop-icon-mac.command` をダブルクリック（最初の1回だけ）
   - 「開発元を検証できません」と出たら、右クリック →「開く」
2. デスクトップに「bitbank DEX Scout」ができる。以後はこれをダブルクリック
3. ターミナルの窓が開いてサーバーが起動し、ブラウザでダッシュボードが開く（初回だけ `npm install` に1〜2分かかる）
4. 終わるときはターミナルの窓を閉じる

**Windows**

1. エクスプローラーで `bitbank-dex-scout\launcher\` を開き、`make-desktop-icon-windows.bat` をダブルクリック（最初の1回だけ）
   - 「WindowsによってPCが保護されました」と出たら「詳細情報」→「実行」
2. デスクトップに「bitbank DEX Scout」ができる。以後はこれをダブルクリック
3. 黒い窓が開いてサーバーが起動し、ブラウザでダッシュボードが開く
4. 終わるときは黒い窓を閉じる

すでに起動中にもう一度ダブルクリックした場合は、ブラウザで開き直すだけになる。
フォルダを移動したら、アイコン作成をもう一度やり直すこと（アイコンはフォルダの場所を覚えているため）。

## ダッシュボード

- 上部：投入額（プリセット＋自由入力）、欲しいチェーンの絞り込み、テイカー／メイカー切り替え、USD/JPY と更新時刻
- メイン表：損失率の小さい順。行クリックで内訳（スプレッド・スリッページ／取引手数料／出金手数料／国内外の価格乖離／DEXコスト／ガス代）を円で展開
- 各チェーンの最安ルートを強調。ブリッジ版USDC（USDC.e）はバッジで区別
- 注意欄：板が薄い、手数料確認が古い、見積り失敗、取引停止中、出金手数料が数量を上回る など
- 「金額別の最安ルート」で、金額によって最安ルートが変わる様子を表示
- 「未設定の銘柄」：bitbank にあるが routes.yaml に無い銘柄と、その出金ネットワーク
- 60秒ごとに自動更新（サーバー側は同じ条件の結果を30秒キャッシュ）

## 計算方法

投入額 X 円、1ルートについて：

1. bitbank の板（asks）を上から食べて、手数料込みで X 円に収まる数量 Q と VWAP を出す（約定代金 N = X ÷ (1 + 手数料率)）。
   メイカー想定では最良買値で全量約定したと仮定する（楽観的な見積り）
2. 取引手数料は bitbank `/spot/pairs` の `taker_fee_rate_quote` / `maker_fee_rate_quote`（取れなければ routes.yaml の値）
3. Q' = Q − 出金手数料 W
4. KyberSwap Aggregator で「Q' 数量のトークン → USDC」を実数量で見積もり、R0 を得る
5. ガス代（アグリゲーターの gasUsd。ERC-20 なら approve 分も加算。取れなければ公開RPCの gasPrice から自前計算）を USDC に換算して引き、R を得る
6. 損失額 = X − R × USDJPY、損失率 = 損失額 ÷ X

内訳（円）は次のように分け、**合計が必ず損失額と一致する**（M = bitbank の仲値、P = DEX の基準単価）：

| 内訳 | 式 |
| --- | --- |
| 取引手数料 | X − N |
| スプレッド・スリッページ | N − Q × M |
| 出金手数料 | W × M |
| 国内外の価格乖離 | Q' × M − Q' × P × USDJPY |
| DEXコスト | (Q' × P − R0) × USDJPY |
| ガス代 | (R0 − R) × USDJPY |

- DEX の基準単価 P は「約5,000円分の少額で見積もった単価」。DEXコストは主に **金額が大きいことによる価格インパクト** を表し、プールの手数料（0.05%前後）は価格乖離側に入る。
  少額見積りが失敗したときはアグリゲーターの参照価格を使い、それもなければ DEXコストを 0 として価格乖離に含める
- 価格乖離率（表の列）＝ bitbank の約定VWAP ÷（P × USDJPY）− 1
- USD/JPY の既定は Frankfurter（ECB の日次レート）。日中の為替変動は反映されないので、厳密に見たいときは `fx.provider` を変えるか `manual` で上書きする

## 設定ファイル

- `config/routes.yaml` … 1行＝「bitbankのペア × 出金チェーン」。出金手数料・確認日・トークンアドレス・受け取りUSDCの種類・無効化フラグ
- `config/chains.yaml` … チェーンごとの USDC アドレス、KyberSwap のチェーン名、公開RPC、ガス量の仮定

設定はリクエストごとに読み直すので、ダッシュボードを動かしたまま編集しても次の更新で反映される。

### 出金手数料を公式ページから設定ファイルへ写す手順

bitbank の出金手数料・対応ネットワーク・出金停止状態は、公開API（キー不要）では取得できない（APIキーが要る `/user/assets` にしかない）。そのため手で管理する。

1. bitbank 公式の手数料ページ <https://bitbank.cc/guide/fee> を開き、「入出金手数料」の表までスクロールする
2. 対象銘柄の行で **ネットワーク** と **出金手数料** を確認する（例：`POL / Polygon / 1.4 POL`、`ETH / Arbitrum / 0.00042 ETH`）
3. `config/routes.yaml` の該当ルート（`pair` と `chain` が一致する行）の `withdraw_fee` に数値だけを書く（例：`withdraw_fee: 1.4`）
4. `fee_checked_at` を確認した日付（`"YYYY-MM-DD"`）に更新する。30日以上前だと画面に「手数料の確認が古い」と出る
5. 新しい銘柄・ネットワークを足すときはルートを1行追加する。ネットワークがチェーン名と違う場合の対応：
   `Ethereum → ethereum`、`Polygon → polygon`、`Arbitrum → arbitrum`、`OP Mainnet → optimism`
   - ネイティブトークン（ETH、POL）は `token: native`
   - ERC-20 は `token: { address: "0x...", decimals: 18 }`。アドレスが分からなければ `token: { coingecko: <CoinGeckoのコインID> }` と書けば自動で引いて `.cache/tokens.json` にキャッシュする
6. メンテナンス等で出金が止まっているときは、そのルートに `disabled: true` と `disabled_reason: "出金停止中"` を書く
7. `npm run scan -- --detail` で、内訳の出金手数料が変わったことを確認する

現在の値は 2026-10-07 に公式ページから写したもの。

## 対象範囲

MVP：Ethereum、Polygon PoS、Arbitrum One（＋同じ仕組みで動く OP Mainnet）。対象は bitbank で売買でき、これらのチェーンへ直接出金できる銘柄。

| チェーン | 銘柄 |
| --- | --- |
| Polygon | POL, SAND（受け取りは USDC / USDC.e） |
| Ethereum | ETH, LINK, DAI, BAT, OMG, BOBA, ENJ, AXS, SAND, APE, GALA, CHZ, MANA, GRT, IMX, MASK, LPT, SKY |
| Arbitrum | ETH（USDC / USDC.e）, ARB, DAI |
| OP Mainnet | ETH, OP, DAI, CYBER |

## 構成

```
config/routes.yaml, chains.yaml
src/calc/route.ts        損失計算（純粋関数。simulateBuy / computeLoss）
src/scan.ts              データ取得と計算のまとめ役。1つのAPIが落ちてもその行だけ「見積り失敗」
src/sources/bitbank.ts   ペア一覧・板（板は5秒キャッシュ）
src/sources/fx.ts        USD/JPY（frankfurter / open-er-api / manual。第一候補が落ちたら予備を使う）
src/sources/dex/         DEXアダプター。getQuote(chain, tokenIn, amountIn, tokenOut) の共通インターフェース
src/sources/gas.ts       予備のガス価格（公開RPC）
src/sources/tokens.ts    CoinGecko でのトークンアドレス解決（長期キャッシュ）
src/http.ts              ホストごとのリクエスト間隔制御・TTLキャッシュ
src/server.ts, public/index.html   ダッシュボード
src/cli.ts               CLI
launcher/                デスクトップ起動用（Mac: .command / Windows: .bat）とアイコン
test/                    単体テスト
```

レート制限対策として、ホストごとに最小リクエスト間隔（bitbank 150ms、KyberSwap 120ms、CoinGecko 3秒）を空け、
板5秒・DEX見積り20秒・為替10分・ペア一覧5分・トークンアドレスは無期限でキャッシュしている。

## 今後の拡張（未実装）

- 非EVMチェーンのアダプター：Flare（SparkDEX）、Solana（Jupiter）、XRPL DEX。`src/sources/dex/` に `DexAdapter` を実装して `adapters` に足す
- 「出金先チェーン ≠ 欲しいチェーン」のブリッジ費用込みルート比較
- 「SBI VCトレードでUSDCを買って出庫」ルートの固定コストを並べて表示
