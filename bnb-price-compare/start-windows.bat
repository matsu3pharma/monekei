@echo off
chcp 65001 > nul
title BNB価格比較
cd /d "%~dp0"

where node > nul 2> nul
if errorlevel 1 goto nonode

if exist node_modules goto run
echo 初回セットアップ中です（1〜2分かかります）...
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail

:run
echo.
echo BNB価格比較を起動しています。このウィンドウを閉じると終了します。
echo.
call npm start --silent -- --open
pause
exit /b 0

:nonode
echo Node.js が見つかりません。開いたページから「LTS」版をインストールしてから、もう一度ダブルクリックしてください。
start "" "https://nodejs.org/ja/download"
pause
exit /b 1

:installfail
echo セットアップに失敗しました。インターネット接続を確認してください。
pause
exit /b 1
