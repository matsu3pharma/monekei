@echo off
cd /d "%~dp0"
echo 起動チェック中です。エラーが出たら、この画面の写真をとって送ってください。
echo.
set "PY="
for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Launcher\py.exe"
if not defined PY if exist "%WINDIR%\py.exe" set "PY=%WINDIR%\py.exe"
if not defined PY (
  echo Python が見つかりません。setup.bat をダブルクリックしてください。
  pause
  exit /b 1
)
"%PY%" --version
"%PY%" -c "import yt_dlp; print('yt-dlp', yt_dlp.version.__version__)"
"%PY%" yt2mp3_gui.py
echo.
echo 終了しました。
pause
