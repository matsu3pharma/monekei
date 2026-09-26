@echo off
rem Double-click to start the monitor. Dashboard: http://127.0.0.1:8765/  (Ctrl+C to stop)
cd /d "%~dp0"
where git >nul 2>nul && git pull --ff-only -q >nul 2>nul
where py >nul 2>nul && (set PY=py) || (set PY=python)
start "" http://127.0.0.1:8765/
%PY% -m bitget_divergence monitor --interval 60 --threshold 2 %*
pause
