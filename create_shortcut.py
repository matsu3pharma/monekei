#!/usr/bin/env python3
"""デスクトップに yt2mp3（ウィンドウ版）のショートカットを作ります。

    python create_shortcut.py
"""

import subprocess
import sys
from pathlib import Path

NAME = "YouTube to MP3"
HERE = Path(__file__).resolve().parent
GUI = HERE / "yt2mp3_gui.py"


def windows() -> Path:
    # コンソール画面を出さないように pythonw.exe で起動する
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    exe = pythonw if pythonw.exists() else Path(sys.executable)
    desktop = subprocess.check_output(
        ["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], text=True
    ).strip()
    link = Path(desktop) / f"{NAME}.lnk"

    def ps_quote(value: object) -> str:
        return "'" + str(value).replace("'", "''") + "'"

    script = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + ps_quote(link) + ");"
        "$s.TargetPath = " + ps_quote(exe) + ";"
        "$s.Arguments = " + ps_quote(f'"{GUI}"') + ";"
        "$s.WorkingDirectory = " + ps_quote(HERE) + ";"
        "$s.Save()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True)
    return link


def macos() -> Path:
    # AppleScript のアプリにして、ターミナルを開かずに起動できるようにする
    app = Path.home() / "Desktop" / f"{NAME}.app"
    command = f"'{sys.executable}' '{GUI}' > /dev/null 2>&1 &"
    applescript = 'do shell script "' + command.replace("\\", "\\\\").replace('"', '\\"') + '"'
    subprocess.run(["osacompile", "-o", str(app), "-e", applescript], check=True)
    return app


def linux() -> Path:
    try:
        desktop = Path(subprocess.check_output(["xdg-user-dir", "DESKTOP"], text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        desktop = Path.home() / "Desktop"
    desktop.mkdir(parents=True, exist_ok=True)
    entry = desktop / "yt2mp3.desktop"
    entry.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={NAME}\n"
        f'Exec="{sys.executable}" "{GUI}"\n'
        f"Path={HERE}\n"
        "Icon=audio-x-generic\n"
        "Terminal=false\n",
        encoding="utf-8",
    )
    entry.chmod(0o755)
    return entry


def main() -> None:
    if sys.platform == "win32":
        path = windows()
    elif sys.platform == "darwin":
        path = macos()
    else:
        path = linux()
    print(f"ショートカットを作成しました: {path}")


if __name__ == "__main__":
    main()
