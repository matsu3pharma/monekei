#!/bin/bash
# デスクトップに「bitbank DEX Scout」アプリのアイコンを作る（Mac）。最初に1回だけ実行してください。
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
START="$HERE/start-mac.command"
APP="$HOME/Desktop/bitbank DEX Scout.app"
chmod +x "$START"

# ダブルクリックで start-mac.command をターミナルで開くだけの小さなアプリ
rm -rf "$APP"
ESCAPED="${START//\\/\\\\}"; ESCAPED="${ESCAPED//\"/\\\"}"
osacompile -o "$APP" -e "do shell script \"open \" & quoted form of \"$ESCAPED\""

# アイコンを差し替え（PNG → icns は macOS 標準の sips / iconutil で作る）
TMP="$(mktemp -d)"; SET="$TMP/icon.iconset"; mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$HERE/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/applet.icns"
rm -rf "$TMP"
touch "$APP"

echo "デスクトップに「bitbank DEX Scout」を作りました。ダブルクリックで起動します。"
echo "（初回は「開発元を検証できません」と出ることがあります。その場合はアイコンを右クリック →「開く」）"
read -r -p "Enter キーで閉じます"
