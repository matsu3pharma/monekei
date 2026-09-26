@echo off
rem Double-click once to put "Bitget Scan" and "Bitget Monitor" shortcuts on the desktop.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell; foreach($p in @(@('Bitget Scan','scan.bat','23'),@('Bitget Monitor','monitor.bat','13'))){ $s=$w.CreateShortcut((Join-Path $d ($p[0]+'.lnk'))); $s.TargetPath=(Join-Path '%~dp0' $p[1]); $s.WorkingDirectory='%~dp0'; $s.IconLocation=$env:SystemRoot+'\System32\shell32.dll,'+$p[2]; $s.Save(); Write-Host ('OK: '+$p[0]) }"
echo.
echo Done. Check your desktop.
pause
