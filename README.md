# monekei

## yt2mp3 — YouTube の URL から MP3 を作るツール

URL を渡すと、動画の音声を MP3 に変換して保存します。
保存前にタイトル・投稿者・ライセンスを表示し、確認してからダウンロードします。

> ⚠️ 自分の動画や、クリエイティブ・コモンズなどで再利用が許可されている動画など、
> 権利上問題のないものだけに使ってください。YouTube の利用規約もご確認ください。

### 準備

1. Python 3.9 以上をインストール
2. ffmpeg をインストール
   - Windows: `winget install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
3. 依存ライブラリをインストール
   ```
   pip install -r requirements.txt
   ```

### 使い方

```
python yt2mp3.py https://www.youtube.com/watch?v=XXXXXXXXXXX
```

| オプション | 説明 |
| --- | --- |
| `-o フォルダ` | 保存先（既定: `./mp3`） |
| `-q 320` | ビットレート kbps（既定: 192） |
| `-y` | 確認を省略 |

URL は複数まとめて指定できます。
