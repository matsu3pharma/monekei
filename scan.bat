@echo off
rem Double-click to run one scan. Result is also saved to result.csv.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% -m bitget_divergence scan --top 40 -o result.csv %*
echo.
pause
