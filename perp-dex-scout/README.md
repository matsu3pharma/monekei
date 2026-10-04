# Perp DEX スカウト

開いた瞬間に複数の情報源を調べて、前回開いたとき以降に出てきた Perp DEX（無期限先物DEX）を一覧表示する個人用アプリです。

## 使い方（デスクトップでダブルクリック）

1. `perp-dex-scout.html` をダウンロードして、デスクトップに置く
2. ダブルクリックするとブラウザ（Chrome 推奨）で開き、自動でチェックが始まる
3. もう一度調べたいときは「再チェック」

インストールは不要です。ファイル1つで動きます。
前回チェック日時・既知リスト・注目・興味なしは、そのブラウザの中に保存されます（ファイルを別の場所に移すと記録はリセットされます）。

## 調べる情報源

| 情報源 | 内容 |
| --- | --- |
| DefiLlama プロトコル一覧 | `Derivatives` などのカテゴリで、最近掲載されたもの |
| DefiLlama 資金調達 | デリバティブ／perp 系の調達 |
| DefiLlama-Adapters (GitHub) | 掲載申請の Pull Request（perp / derivatives を含むもの） |
| Hyperliquid HIP-3 | `perpDexs` で取得し、前回との差分を新着にする |
| ニュース RSS | The Block、CoinDesk、Cointelegraph、Decrypt、The Defiant |

ニュースの RSS はブラウザから直接読めないため、公開の中継サービス（allorigins、corsproxy.io、rss2json）を順に試します。混み合って失敗した情報源は画面下に表示されます。

## 設定

「設定」ボタンから、キーワード・RSS の URL・除外リスト・対象期間・「興味なし」の解除を編集できます（コードを触る必要はありません）。

## テスト

```
node --test perp-dex-scout/tests/core.test.js
```
