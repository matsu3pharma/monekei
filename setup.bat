@echo off
cd /d "%~dp0"
echo ========================================
echo   YouTube to MP3  じゅんび
echo ========================================
echo.
echo とちゅうで「はい／いいえ」の画面が出たら「はい」を押してください。
echo.

set "PY="
call :findpy
if not defined PY (
  echo [1/5] Python を入れています…　しばらく待ってね
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  call :findpy
)
if not defined PY (
  echo.
  echo Python が見つかりませんでした。
  echo パソコンを再起動してから、もう一度 setup.bat をダブルクリックしてください。
  pause
  exit /b 1
)
echo [1/5] Python … OK

set "FF="
where ffmpeg >nul 2>&1 && set "FF=1"
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" set "FF=1"
if not defined FF (
  echo [2/5] ffmpeg を入れています…　しばらく待ってね
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
)
echo [2/5] ffmpeg … OK

set "DN="
where deno >nul 2>&1 && set "DN=1"
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\deno.exe" set "DN=1"
if not defined DN (
  echo [3/5] Deno を入れています…　しばらく待ってね
  winget install -e --id DenoLand.Deno --accept-source-agreements --accept-package-agreements
)
echo [3/5] Deno … OK

echo [4/5] ライブラリを入れています…
"%PY%" -m pip install --upgrade -r requirements.txt
if errorlevel 1 goto fail
echo [4/5] ライブラリ … OK

echo [5/5] デスクトップにショートカットを作っています…
"%PY%" create_shortcut.py
if errorlevel 1 goto fail

echo.
echo ========================================
echo   おわり！
echo   デスクトップの「YouTube to MP3」を
echo   ダブルクリックしてね。
echo ========================================
pause
exit /b 0

:fail
echo.
echo うまくいきませんでした。
echo この黒い画面の写真をとって、送ってください。
pause
exit /b 1

:findpy
for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Launcher\py.exe"
if not defined PY if exist "%WINDIR%\py.exe" set "PY=%WINDIR%\py.exe"
exit /b 0
