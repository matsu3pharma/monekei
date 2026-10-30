# デスクトップに「BNB価格比較」のショートカットを作る
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'BNB価格比較.lnk'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = Join-Path $root 'start-windows.bat'
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $root 'launcher\icon.ico') + ',0'
$s.Description = 'bitbank・バイナンスジャパンと Perp DEX の BNB 価格比較'
$s.Save()

Write-Host "デスクトップにアイコンを作りました: $link"
Write-Host 'これからはデスクトップの「BNB価格比較」をダブルクリックすると起動します。'
