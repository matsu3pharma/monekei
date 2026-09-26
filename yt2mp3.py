#!/usr/bin/env python3
"""YouTube の動画 URL から音声を取り出して MP3 に変換する小さなツール。

使い方:
    python yt2mp3.py <URL> [<URL> ...] [-o 出力フォルダ] [-q 音質kbps] [-y]

ダウンロード前に動画のタイトル・投稿者・ライセンス情報を表示し、
確認してから保存します（-y で確認を省略）。
ご自身の動画、クリエイティブ・コモンズ等で再利用が許可された動画など、
権利上問題のないものだけに使ってください。
"""

import argparse
import shutil
import sys
from pathlib import Path

try:
    import yt_dlp
except ImportError:
    sys.exit("yt-dlp が見つかりません。`pip install -r requirements.txt` を実行してください。")


def check_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        sys.exit(
            "ffmpeg が見つかりません。MP3 変換に必要なのでインストールしてください。\n"
            "  Windows: winget install ffmpeg\n"
            "  macOS:   brew install ffmpeg\n"
            "  Linux:   sudo apt install ffmpeg"
        )


def fetch_info(url: str) -> dict:
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        return ydl.extract_info(url, download=False)


def show_info(info: dict) -> None:
    print(f"  タイトル  : {info.get('title', '不明')}")
    print(f"  投稿者    : {info.get('uploader', '不明')}")
    print(f"  長さ      : {info.get('duration_string', '不明')}")
    print(f"  ライセンス: {info.get('license') or '表示なし（標準の YouTube ライセンスの可能性があります）'}")


def confirm(prompt: str) -> bool:
    return input(f"{prompt} [y/N]: ").strip().lower() in ("y", "yes")


def download_mp3(url: str, out_dir: Path, quality: str, progress_hook=None) -> None:
    opts = {
        "quiet": progress_hook is not None,
        "noprogress": progress_hook is not None,
        "progress_hooks": [progress_hook] if progress_hook else [],
        "format": "bestaudio/best",
        "noplaylist": True,
        "outtmpl": str(out_dir / "%(title)s.%(ext)s"),
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": quality},
            {"key": "FFmpegMetadata"},
        ],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])


def main() -> int:
    parser = argparse.ArgumentParser(description="YouTube の URL から MP3 を作成します。")
    parser.add_argument("urls", nargs="+", help="動画の URL（複数可）")
    parser.add_argument("-o", "--output", default="mp3", help="保存先フォルダ（既定: ./mp3）")
    parser.add_argument("-q", "--quality", default="192", help="MP3 のビットレート kbps（既定: 192）")
    parser.add_argument("-y", "--yes", action="store_true", help="確認を省略する")
    args = parser.parse_args()

    check_ffmpeg()
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    failed = 0
    for url in args.urls:
        print(f"\n{url}")
        try:
            info = fetch_info(url)
            show_info(info)
            if not args.yes and not confirm("権利上問題のない動画であることを確認しました。保存しますか？"):
                print("  スキップしました。")
                continue
            download_mp3(url, out_dir, args.quality)
            print(f"  完了 → {out_dir.resolve()}")
        except yt_dlp.utils.DownloadError as e:
            print(f"  エラー: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
