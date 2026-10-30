#!/bin/bash
# デスクトップに「BNB価格比較」アイコンを作る（macOS）
here="$(cd "$(dirname "$0")" && pwd)"
target="$HOME/Desktop/BNB価格比較.command"

cat > "$target" <<SCRIPT
#!/bin/bash
exec "$here/start-mac.command"
SCRIPT
chmod +x "$target" "$here/start-mac.command"

# アイコン画像を付ける（失敗しても起動には影響しない）
osascript > /dev/null 2>&1 <<APPLESCRIPT
use framework "AppKit"
set img to current application's NSImage's alloc()'s initWithContentsOfFile:"$here/launcher/icon.ico"
current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:"$target" options:0
APPLESCRIPT

echo "デスクトップにアイコンを作りました: $target"
echo "これからはデスクトップの「BNB価格比較」をダブルクリックすると起動します。"
read -n 1 -s -r -p "何かキーを押すと閉じます"
