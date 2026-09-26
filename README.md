# monekei

## bitget_divergence — Bitget 価格乖離モニター

Bitget の出金停止（2026-09-24〜）で裁定が効かなくなり、Bitget 上の価格が他の取引所や DEX から乖離している銘柄を見つけて監視するツール。
Python 3.10+ の標準ライブラリだけで動く（`pip install` 不要）。

### 何を比べるか

| 項目 | 意味 |
|---|---|
| `DIV%` | Bitget 仲値 ÷ 参照取引所の仲値の**中央値** − 1。＋なら Bitget が割高、−なら割安 |
| `SELL@BG%` | Bitget の買気配 ÷ 外部の最安売気配 − 1。外部で買って Bitget に**入金**して売る方向 |
| `BUY@BG%` | 外部の最高買気配 ÷ Bitget の売気配 − 1。Bitget で買って**出金**する方向（出金停止中は実行不可） |
| `DEX%` | 乖離が大きい上位 N 銘柄について DexScreener の最大流動性プールと比べた乖離（USDT≒USD 前提） |
| `WD` / `DEP` | Bitget の公開 API から取った銘柄ごとの出金・入金状態 |
| flags | `ref-disagree`: 参照取引所どうしで価格がずれている（同じティッカーで別トークンの可能性）/ `ticker-mismatch`: 乖離が 30% 超で、Bitget が同名の別トークンを扱っている可能性が高い（`--max-div` で変更）/ `wide-spread` / `withdraw-off` / `deposit-off` |

- 参照 CEX: Binance, OKX, Bybit, Gate, MEXC, KuCoin（USDT 建て現物）
- 偽陽性を減らすため、既定では「24h 出来高 5 万 USDT 以上の参照取引所が 2 社以上」ある銘柄だけを対象にする
- `ref-disagree` と `ticker-mismatch` の銘柄は既定で表・通知から除外（`--show-unreliable` で表示）。DEX 価格も参照中央値から 30% 超ずれていれば別トークンとみなして使わない
- 手数料・板の厚さ・送金時間は計算に入っていない。表示される％は理論値

### 使い方

```bash
# 一回だけスキャンして乖離ランキングを表示（CSV/JSON 出力も可）
python3 -m bitget_divergence scan --top 40 -o result.csv

# 常時監視: 60 秒ごとにスキャンし、|乖離| が 2% を超えたらアラート、
# http://127.0.0.1:8765/ でダッシュボード、履歴は divergence.sqlite に保存
python3 -m bitget_divergence monitor --interval 60 --threshold 2

# 通知先（任意、環境変数）
export DISCORD_WEBHOOK_URL=...      # Discord
export SLACK_WEBHOOK_URL=...        # Slack
export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
```

主なオプション: `--venues binance,okx,bybit`、`--min-volume`、`--min-venues`、`--max-dispersion`、`--dex-top 0`（DEX 照合なし）、
`--step`（乖離がさらにこれだけ拡大したら再通知）、`--cooldown`（同じ銘柄の再通知間隔・分）、`--show-unreliable`。
履歴は `GET /api/history?base=XAUT&hours=24` で取れる。

### Windows で使う

- エクスプローラーで `scan.bat` をダブルクリック → 1回スキャンして結果を表示し、`result.csv` にも保存
- `monitor.bat` をダブルクリック → 常時監視を開始し、ブラウザでダッシュボードを開く（止めるときは Ctrl+C）
- PowerShell から実行する場合、Windows PowerShell 5.x は `&&` が使えないので1行ずつ実行する:

```powershell
cd monekei
py -m bitget_divergence scan --top 40
```

`py` が無い場合は `python`。どちらも無ければ https://www.python.org/downloads/ からインストール（"Add python.exe to PATH" にチェック）。

### テスト

```bash
python3 -m unittest discover -s tests
```
