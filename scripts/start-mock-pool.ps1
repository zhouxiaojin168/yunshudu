# start-mock-pool.ps1 -- start local mock upstream pool in background (9921 healthy / 9922 quota-dead)
$ErrorActionPreference='Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'runtime\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\node-v\node.exe' }
$p = Start-Process -FilePath $node -ArgumentList (Join-Path $Root 'scripts\mock-pool.js') -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $LogDir 'mock-pool.out.log') -RedirectStandardError (Join-Path $LogDir 'mock-pool.err.log') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $LogDir 'mock-pool.pid') -Value $p.Id -Encoding ASCII
Start-Sleep -Seconds 2
Write-Host ("started mock-pool pid=" + $p.Id)
