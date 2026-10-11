@echo off
rem Double-click to open crypto buzz (Windows)
cd /d "%~dp0"
where py >nul 2>nul && (py -3 buzz.py) || (python buzz.py)
if errorlevel 1 pause
