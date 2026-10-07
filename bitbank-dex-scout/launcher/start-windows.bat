@echo off
rem bitbank DEX Scout - start and open in browser (Windows). Close this window to stop.
cd /d "%~dp0.."
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start --silent -- --open
pause
