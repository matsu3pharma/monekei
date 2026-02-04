# monekei - sFLR価格差アラート

sFLR/FLRの価格差を監視し、設定したしきい値を超えたらGmailで通知するアプリケーションです。

## 機能

- **DexScreener API**: DEX上のsFLR/WFLR価格を取得
- **Sceptre.fi コントラクト**: 公式のsFLR→FLR交換レートを取得
- **価格差監視**: 両者の差額が0.15 FLR以上になったらアラート
- **Gmail通知**: 価格差を検出したらメールで通知

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、Gmail設定を入力してください。

```bash
cp .env.example .env
```

**Gmailアプリパスワードの取得方法:**
1. https://myaccount.google.com/apppasswords にアクセス
2. 2段階認証を有効にしている必要があります
3. 「アプリ パスワード」を生成
4. 生成された16桁のパスワードを `.env` に設定

### 3. 実行

```bash
npm start
```

## 設定項目

`.env` ファイルで以下の設定が可能です:

| 項目 | 説明 | デフォルト |
|------|------|-----------|
| `GMAIL_USER` | Gmailアドレス | - |
| `GMAIL_APP_PASSWORD` | Gmailアプリパスワード | - |
| `NOTIFY_EMAIL` | 通知先メールアドレス | - |
| `PRICE_DIFF_THRESHOLD` | アラートしきい値（FLR） | 0.15 |
| `CHECK_INTERVAL` | 監視間隔（ミリ秒） | 60000 |

## 使用API・コントラクト

- **DexScreener API**: `https://api.dexscreener.com/`
- **sFLR/WFLR ペア (BlazeSwap)**: `0x3f50f880041521738fa88c46cdf7e0d8eeb11aa2`
- **sFLR コントラクト**: `0x12e605bc104e93b45e1ad99f9e555f659051c2bb`
- **Flare RPC**: `https://flare-api.flare.network/ext/C/rpc`