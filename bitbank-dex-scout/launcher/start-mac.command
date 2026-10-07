#!/bin/bash
# bitbank DEX Scout を起動してブラウザで開く（Mac）。このウィンドウを閉じると終了します。
cd "$(dirname "$0")/.." || exit 1

# Finder から起動すると PATH が最小限なので、よくある Node.js の場所を足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org から LTS 版をインストールしてから、もう一度開いてください。"
  read -r -p "Enter キーで閉じます"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "初回のみ準備しています（npm install）..."
  npm install || { read -r -p "npm install に失敗しました。Enter キーで閉じます"; exit 1; }
fi

npm start --silent -- --open
