@echo off
chcp 65001 > nul
cd /d "%~dp0"
where node > nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。README の「1. 準備」を見てインストールしてください。
  pause
  exit /b 1
)
start "" http://localhost:3939
node server.js
pause
