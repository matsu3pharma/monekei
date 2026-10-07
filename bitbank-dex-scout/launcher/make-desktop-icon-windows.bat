@echo off
rem Create a "bitbank DEX Scout" shortcut on the desktop (Windows). Run once.
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'bitbank DEX Scout.lnk')); $s.TargetPath='%HERE%start-windows.bat'; $s.WorkingDirectory='%HERE%'; $s.IconLocation='%HERE%icon.ico,0'; $s.Description='bitbank DEX Scout'; $s.Save()"
if errorlevel 1 (
  echo Failed to create the shortcut.
) else (
  echo Created "bitbank DEX Scout" on your desktop. Double-click it to start.
)
pause
