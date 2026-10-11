# start-web.ps1 -- 后台拉起网页门户（8899）
$ErrorActionPreference='Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'runtime\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\node-v\node.exe' }
$p = Start-Process -FilePath $node -ArgumentList (Join-Path $Root 'scripts\serve-web.js') -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $LogDir 'web.out.log') -RedirectStandardError (Join-Path $LogDir 'web.err.log') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $LogDir 'web.pid') -Value $p.Id -Encoding ASCII
Start-Sleep -Seconds 2
Write-Host ('started web portal pid=' + $p.Id + ' -> http://127.0.0.1:8899')