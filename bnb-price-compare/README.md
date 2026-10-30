# BNB価格比較（国内CEX × Perp DEX）

bitbank・バイナンスジャパンの **BNB/JPY** と、主要Perp DEXの **BNB無期限先物** の価格を、
リアルタイムの **USD/JPY** で円・ドルに揃えて比較する読み取り専用ツールです。
APIキー・秘密鍵は不要で、注文・出金などは一切行いません。

| 区分 | 取引所 | 取得データ |
| --- | --- | --- |
| 国内CEX（現物・JPY） | bitbank, Binance Japan | 板 |
| Perp DEX（USD/USDC/USDT） | Hyperliquid, Aster, Lighter, dYdX, Paradex, Extended | 板・マーク価格・資金調達率 |
| 為替 | GMOコイン 外国為替FX 公開API（リアルタイムBid/Ask） | 失敗時は open.er-api.com（日次）に切替 |

## 使い方

Node.js 20以上が必要です。

```bash
cd bnb-price-compare
npm install
npm start          # → http://localhost:3000 をブラウザで開く（5秒ごとに自動更新）
```

ターミナルで見るだけなら:

```bash
npm run scan -- --amount 100000          # 表で表示
npm run scan -- --amount 100000 --json   # JSONで出力
```

## 画面の見かた

- **基準価格**：取得できたPerp DEXの仲値（USD）の中央値。1つの取引所の異常値に引っ張られにくくしています。
- **国内プレミアム／基準からの乖離**：各取引所の仲値（円換算）÷ 基準価格（円換算）− 1。プラスなら基準より割高。
- **買い実効／売り実効**：「比較金額」ぶん板を成行で食べたときの平均価格に、テイカー手数料を足し引きした円換算価格。板が薄いほど不利になります。各列で一番有利な取引所に ★。
- **最安買い → 最高売り**：手数料込みで一番安く買える所と一番高く売れる所の差。送金・入出金・為替手数料、Perpの証拠金・資金調達コストは含みません。
- **FR（8h換算）**：資金調達率を8時間あたりに換算した値（Hyperliquid・dYdX・Extendedは1時間ごと、Aster・Paradexは8時間ごとの率を換算）。
- 1つのAPIが落ちても全体は止まらず、その行に「取得失敗」と理由が出ます。

## 設定（`config/venues.yaml`）

コードを触らずに、取引所の有効/無効、テイカー手数料、比較金額のプリセット、更新間隔、為替の取得元を変えられます。

**テイカー手数料は初期値が目安です。** 各取引所の公式の手数料ページで自分のランクの値を確認して `taker_fee` に書き、
`fee_checked_at` を確認日に更新してください。30日以上前の日付だと画面に警告が出ます。

## 注意

- **バイナンスジャパン**のJPYペア（BNBJPY）は `api.binance.com` から取得します。日本以外のIPからは HTTP 451 で拒否されるため、
  海外サーバーやVPN経由では「取得失敗」になります。日本の自宅PCなどで動かしてください。
- USDT・USDCは1ドルとみなして換算しています。デペッグ時は実際と差が出ます。
- 為替は土日など市場が閉まっている間、最後のレートのまま「市場クローズ中」と表示されます。
- 表示は目安です。実際の約定価格は数秒で変わります。

## 開発

```bash
npm test         # 計算ロジックの単体テスト
npm run typecheck
```

```
src/
├── sources/venues.ts   # 取引所アダプター（板・マーク価格・資金調達率）
├── sources/fx.ts       # USD/JPY（GMOコインFX → open.er-api の順に試す）
├── calc/compare.ts     # 比較計算（純粋関数）
├── snapshot.ts         # 全ソースを並列取得・短時間キャッシュ
├── server.ts           # ダッシュボード（http://localhost:3000）
└── cli.ts              # npm run scan
public/index.html       # 画面
config/venues.yaml      # 設定
```

取引所を足すときは `src/sources/venues.ts` に `Venue`（`fetch()` で板などを返す）を1つ書いて `VENUES` に加え、
`config/venues.yaml` に行を追加します。
