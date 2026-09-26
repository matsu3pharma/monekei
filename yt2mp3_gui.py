#!/usr/bin/env python3
"""yt2mp3 のウィンドウ版。URL を入力して「OK」を押すと MP3 を保存します。"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    import yt_dlp
except ImportError:
    tk.Tk().withdraw()
    messagebox.showerror(
        "yt2mp3", "yt-dlp が見つかりません。\n`pip install -r requirements.txt` を実行してください。"
    )
    sys.exit(1)

from yt2mp3 import download_mp3, explain_error, fetch_info, find_ffmpeg

DEFAULT_DIR = Path.home() / "Music" / "yt2mp3"


def open_folder(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        root.title("YouTube → MP3")
        root.resizable(False, False)

        frame = ttk.Frame(root, padding=16)
        frame.grid()

        ttk.Label(frame, text="動画の URL").grid(row=0, column=0, sticky="w")
        self.url = tk.StringVar()
        url_entry = ttk.Entry(frame, textvariable=self.url, width=56)
        url_entry.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(2, 10))
        url_entry.focus()
        url_entry.bind("<Return>", lambda _: self.start())

        ttk.Label(frame, text="保存先").grid(row=2, column=0, sticky="w")
        self.out_dir = tk.StringVar(value=str(DEFAULT_DIR))
        ttk.Entry(frame, textvariable=self.out_dir, width=46).grid(row=3, column=0, sticky="ew", pady=(2, 10))
        ttk.Button(frame, text="変更…", command=self.choose_dir).grid(row=3, column=1, padx=(6, 0), pady=(2, 10))

        self.status = tk.StringVar(value="URL を貼り付けて OK を押してください。")
        ttk.Label(frame, textvariable=self.status, wraplength=420).grid(row=4, column=0, columnspan=2, sticky="w")
        self.progress = ttk.Progressbar(frame, length=420, maximum=100)
        self.progress.grid(row=5, column=0, columnspan=2, sticky="ew", pady=(6, 12))

        buttons = ttk.Frame(frame)
        buttons.grid(row=6, column=0, columnspan=2, sticky="e")
        ttk.Button(buttons, text="フォルダを開く", command=self.open_output).pack(side="left", padx=(0, 6))
        self.ok_button = ttk.Button(buttons, text="OK", command=self.start)
        self.ok_button.pack(side="left")

    def choose_dir(self) -> None:
        path = filedialog.askdirectory(initialdir=self.out_dir.get())
        if path:
            self.out_dir.set(path)

    def open_output(self) -> None:
        path = Path(self.out_dir.get())
        path.mkdir(parents=True, exist_ok=True)
        open_folder(path)

    def set_status(self, text: str, percent: float | None = None) -> None:
        # ワーカースレッドからも呼べるように、画面更新はメインスレッドで行う
        def update() -> None:
            self.status.set(text)
            if percent is not None:
                self.progress["value"] = percent
        self.root.after(0, update)

    def start(self) -> None:
        url = self.url.get().strip()
        if not url:
            messagebox.showwarning("yt2mp3", "URL を入力してください。")
            return
        if not find_ffmpeg():
            messagebox.showerror("yt2mp3", "ffmpeg が見つかりません。README の手順でインストールしてください。")
            return
        self.ok_button.state(["disabled"])
        self.progress["value"] = 0
        self.set_status("動画の情報を取得しています…")
        threading.Thread(target=self.fetch, args=(url,), daemon=True).start()

    def fetch(self, url: str) -> None:
        try:
            info = fetch_info(url)
        except Exception as e:
            self.root.after(0, self.finish, f"情報を取得できませんでした: {e}")
            return
        self.root.after(0, self.confirm, url, info)

    def confirm(self, url: str, info: dict) -> None:
        license_text = info.get("license") or "表示なし（標準の YouTube ライセンスの可能性があります）"
        ok = messagebox.askyesno(
            "確認",
            f"タイトル: {info.get('title', '不明')}\n"
            f"投稿者: {info.get('uploader', '不明')}\n"
            f"長さ: {info.get('duration_string', '不明')}\n"
            f"ライセンス: {license_text}\n\n"
            "権利上問題のない動画であることを確認しました。保存しますか？",
        )
        if not ok:
            self.finish("キャンセルしました。")
            return
        out_dir = Path(self.out_dir.get())
        out_dir.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self.download, args=(url, out_dir), daemon=True).start()

    def download(self, url: str, out_dir: Path) -> None:
        def hook(d: dict) -> None:
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if total:
                    percent = d["downloaded_bytes"] / total * 100
                    self.set_status(f"ダウンロード中… {percent:.0f}%", percent)
            elif d["status"] == "finished":
                self.set_status("MP3 に変換しています…", 100)

        try:
            download_mp3(url, out_dir, "192", progress_hook=hook)
        except Exception as e:
            self.root.after(0, self.finish, f"エラー: {e}")
            self.root.after(0, messagebox.showerror, "yt2mp3", explain_error(str(e)))
            return
        self.root.after(0, self.finish, f"完了しました → {out_dir}")
        self.root.after(0, self.url.set, "")

    def finish(self, message: str) -> None:
        self.status.set(message)
        self.ok_button.state(["!disabled"])


def main() -> None:
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
