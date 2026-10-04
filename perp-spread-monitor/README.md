# Perp DEX 乖離モニター

複数の Perp DEX（Hyperliquid / dYdX / Aster / Lighter / Paradex / Variational / Nado / Arcus / BULK / Ondo Perps / SoDEX / PopDEX、APIキーを入れれば Decibel も）の公開データを30秒ごとに取得し、
**同じ銘柄のファンディングレート(FR)の差**と**価格の差**を一覧表示するアプリです。
差が大きくなったら画面・Discord・Telegram でお知らせします。

- 自分のパソコンだけで動きます（外部にデータを送るのは、設定した場合の Discord / Telegram 通知だけ）
- **表示と通知だけ**です。注文や自動売買はしません。ウォレットやAPIキーも不要です
- 表示される FR 差は **手数料・スリッページ・価格差・FR変動を差し引く前の値** です

---

## 1. 準備（最初の1回だけ）

### Node.js を入れる

1. https://nodejs.org/ja を開く
2. 「LTS」と書かれた緑のボタンからダウンロードしてインストール（設定はすべてそのまま「次へ」でOK）
3. 確認：
   - Mac：「ターミナル」アプリを開いて `node -v` と入力して Enter
   - Windows：スタートメニューで「PowerShell」を開いて `node -v` と入力して Enter
   - `v18` 以上の数字（例：`v22.11.0`）が出ればOK

### このフォルダを置く

`perp-spread-monitor` フォルダを、デスクトップなど分かりやすい場所に置きます。

---

## 2. 起動する

### かんたんな方法（ダブルクリック）

- **Windows**：`start-windows.bat` をダブルクリック
- **Mac**：`start-mac.command` をダブルクリック
  - 初回に「開発元を確認できないため開けません」と出たら、ファイルを**右クリック →「開く」→「開く」**

黒い画面（ターミナル）が開き、`Perp DEX 乖離モニターを起動しました → http://localhost:3939` と出たら起動完了です。

### 手で起動する方法

ターミナル（Windows は PowerShell）で：

```
cd （perp-spread-monitor フォルダの場所）
node server.js
```

> ヒント：`cd ` と打ったあと、フォルダをターミナルにドラッグ＆ドロップすると場所が自動で入ります。

### 画面を開く

ブラウザで **http://localhost:3939** を開きます。

### 止める

黒い画面をクリックして `Ctrl` + `C`（Mac も `control` + `C`）を押すか、画面を閉じます。
**黒い画面を閉じるとモニターも止まります。** 監視中は開いたままにしてください。

---

## 3. 画面の見方

- **上部のチップ**：DEXごとの取得状態
  - 緑：取得OK（数字は銘柄数）
  - 赤：取得エラー（マウスを乗せると理由が出ます）。そのDEXだけ除外して、他は表示され続けます
- **FR乖離タブ**：FRの差が大きい順
  - **ショート先**：FRが一番高いDEX（ショートするとFRを受け取る側）
  - **ロング先**：FRが一番低いDEX
  - **FR差年率**：1時間あたりのFR差 × 24 × 365
  - FRの表示単位はDEXごとに違う（1時間・4時間・8時間・24時間あたり、年率など）ので、すべて**1時間あたりに直してから**比べています
- **価格乖離タブ**：価格の差が大きい順
- **出来高(小)**：その銘柄を扱うDEXのうち、一番少ない24時間出来高（薄い方が実際の制約になるため）
- **⚠ マーク**：同じ名前なのに価格が20%以上ずれている銘柄。単位違い（例：PEPE と 1000PEPE）や別物の可能性が高いので、通知の対象から外しています
  - 3つ以上のDEXにある銘柄で、1つのDEXだけ価格が大きく違う場合（例：株の QNT と仮想通貨の QNT）は、そのDEXだけを「別物？除外」として比較から外し、残りで比べます
- 黄色い線の付いた行：しきい値を超えている行
- 行をクリックすると、DEXごとの元の銘柄名・価格・FR（1時間・年率・DEXが表示している生の値）・出来高が見られます
- 「出来高フィルタ」：ONにすると、出来高(小)がしきい値未満の銘柄を隠します
- 「しきい値超えのみ」：ONにすると、通知条件を満たす行だけ表示します

---

## 4. 設定を変える（config.json）

初回起動時に `config.json` が自動で作られます。メモ帳（Mac はテキストエディット）で開いて編集し、保存してください。
**再起動は不要**で、次の取得（最大30秒後）から反映されます（`port` の変更だけは再起動が必要）。

> 書き方を間違えると画面上部に赤字で表示され、直前の正しい設定のまま動き続けます。
> `"` や `,` の消し忘れ・付けすぎに注意してください。

| 項目 | 意味 | 初期値 |
|---|---|---|
| `pollSeconds` | 何秒ごとに取得するか（5以上） | 30 |
| `exchanges.○○.enabled` | そのDEXを使うか（`true` / `false`） | true |
| `exchanges.○○.intervalHours` | そのDEXのFRが何時間あたりの値か | 下表 |
| `alert.frSpreadAprPct` | FR差年率がこの%以上で通知 | 30 |
| `alert.priceSpreadPct` | 価格差がこの%以上で通知 | 0.5 |
| `alert.minVolume24hUsd` | 出来高(小)がこのドル以上の銘柄だけ通知 | 1000000 |
| `alert.cooldownMinutes` | 同じ通知を繰り返さない時間（分） | 30 |
| `alert.maxPriceRatioSanity` | 価格がこの倍率以上ずれていたら ⚠ 扱い | 1.2（=20%） |
| `watchlist` | 見たい銘柄だけに絞る。例：`["BTC", "ETH", "SOL"]`。空 `[]` なら全部 | [] |

`intervalHours` の初期値（2026年10月に実データで確認済み。ふつうは変更不要）：

| DEX | intervalHours | 備考 |
|---|---|---|
| Hyperliquid / dYdX / Arcus / BULK / Ondo Perps / Decibel | 1 | |
| Aster | 8 | 銘柄ごとの間隔をAPIから取るので、取得に失敗したときだけ使われる |
| Lighter | 8 | 支払いは毎時だが、APIの値は8時間あたり |
| Paradex | 8 | 銘柄ごとの間隔をAPIから取る |
| Nado | 24 | APIの値が24時間あたり |
| Variational | 8760 | APIの値が年率（8760時間あたり） |
| SoDEX / PopDEX | 1 | 銘柄ごとの間隔をAPIから取るので、取得に失敗したときだけ使われる |

詳しくは `docs/api-notes.md`。

### Decibel を使う場合（APIキーが必要）

Decibel だけは公開データの取得にもAPIキー（Bearer トークン）が必要なので、初期状態では無効です。

1. https://geomi.dev でAPIキーを発行（手順：https://docs.decibel.trade/quickstart/node-api-key ）
2. `config.json` を次のように変更：
   ```json
   "decibel": { "enabled": true, "intervalHours": 1, "apiKey": "（発行したキー）" }
   ```
3. `node scripts/check-apis.js` で `[Decibel]` に銘柄数と BTC/ETH の値が出ることを確認

---

## 5. 通知を設定する

通知先が空のときは、黒い画面と、ブラウザ画面の「アラート履歴」にだけ表示されます。

### Discord

1. 通知を受けたい Discord サーバーのチャンネルで、歯車（チャンネルの編集）→「連携サービス」→「ウェブフック」→「新しいウェブフック」
2. 「ウェブフックURLをコピー」
3. `config.json` の `discordWebhookUrl` に貼り付け：
   ```json
   "discordWebhookUrl": "https://discord.com/api/webhooks/xxxx/yyyy",
   ```
4. 保存

### Telegram

1. Telegram で **@BotFather** を開き `/newbot` → 名前を決めると **トークン**（`123456:ABC...`）がもらえます
2. 作ったボットとのチャットを開いて、何か1通メッセージを送る
3. ブラウザで `https://api.telegram.org/bot（トークン）/getUpdates` を開き、`"chat":{"id":` の後ろの数字が **チャットID**
4. `config.json` に記入：
   ```json
   "telegramBotToken": "123456:ABC...",
   "telegramChatId": "987654321"
   ```

### 動作テストのしかた

`alert.frSpreadAprPct` を一時的に `1` などの小さい値にして保存すると、30秒以内に通知が来ます。
確認できたら元の値に戻してください（同じ通知は `cooldownMinutes` の間は繰り返されません）。
通知の送信に失敗すると、黒い画面とアラート履歴に赤字で理由が出ます。

> **`config.json` には Webhook URL やトークン（Decibel のAPIキーも）が入ります。人に渡したり、ネットに公開したりしないでください。**

---

## 6. 困ったとき

| 症状 | 対処 |
|---|---|
| `node` が見つからないと言われる | Node.js をインストール後、ターミナルを開き直す |
| 「ポート 3939 は使用中」 | すでに起動していないか確認。別のポートにするなら `config.json` の `port` を変えて再起動し、そのポート番号で開く |
| チップが赤い | マウスを乗せて理由を確認。一時的なDEX側の障害なら次の取得で自動で戻ります |
| 画面に「サーバーに接続できません」 | 黒い画面が閉じていないか確認。閉じていたら起動し直す |
| FRの値が公式画面と合わない | そのDEXの `intervalHours` が違う可能性。`node scripts/check-apis.js` を実行して「1h換算」「8h換算」の値を公式画面と比べる |

---

## 7. 開発者向け

- 依存パッケージなし（Node.js 18 以上の標準機能のみ）
- テスト：`node --test`
- 実API確認：`node scripts/check-apis.js`
- 構成
  - `server.js`：ポーリング・アラート・HTTPサーバー
  - `exchanges.js`：DEXごとのアダプタ（取得と解析を分離）＋銘柄名の正規化。DEXを足すときは `ADAPTERS` に1つ追加し、`config.json` にキーを足す
  - `core.js`：比較ロジック（純粋関数）
  - `notify.js`：通知文の整形と Discord / Telegram 送信
  - `public/index.html`：ダッシュボード
  - `docs/api-notes.md`：API の形・FR間隔の確認メモ
- 画面は `/api/snapshot`（JSON）を10秒ごとに取得
- サーバーは `127.0.0.1`（このPC）だけで待ち受けます
