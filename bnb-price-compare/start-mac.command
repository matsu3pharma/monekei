#!/bin/bash
# ダブルクリックで起動（macOS）。このウィンドウを閉じると終了する。
cd "$(dirname "$0")" || exit 1
printf '\033]0;BNB価格比較\007'

# Finder から開いたときに Homebrew などの node が PATH に入っていない場合に備える
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" > /dev/null

if ! command -v node > /dev/null; then
  echo "Node.js が見つかりません。開いたページから「LTS」版をインストールしてから、もう一度ダブルクリックしてください。"
  open "https://nodejs.org/ja/download"
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "初回セットアップ中です（1〜2分かかります）..."
  if ! npm install --no-audit --no-fund; then
    echo "セットアップに失敗しました。インターネット接続を確認してください。"
    read -n 1 -s -r -p "何かキーを押すと閉じます"
    exit 1
  fi
fi

echo
echo "BNB価格比較を起動しています。このウィンドウを閉じると終了します。"
echo
exec npm start --silent -- --open
