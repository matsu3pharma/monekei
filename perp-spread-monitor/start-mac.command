#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。README の「1. 準備」を見てインストールしてください。"
  read -r -p "Enter で閉じます"
  exit 1
fi
(sleep 2; open http://localhost:3939) &
node server.js
