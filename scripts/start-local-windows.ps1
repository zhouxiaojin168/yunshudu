# start-local-windows.ps1 -- 免 Docker 在本机拉起 new-api(Windows 预编译版)
# 用法:  powershell -ExecutionPolicy Bypass -File .\scripts\start-local-windows.ps1
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$Bin    = Join-Path $Root 'runtime\bin\new-api.exe'
$Data   = Join-Path $Root 'runtime\data'
$LogDir = Join-Path $Root 'runtime\logs'
New-Item -ItemType Directory -Force -Path $Data,$LogDir | Out-Null
if (-not (Test-Path $Bin)) { throw "missing $Bin -- run scripts\download-release.ps1 first" }
$env:PORT           = if ($env:PORT) { $env:PORT } else { '3300' }
$env:SESSION_SECRET = if ($env:SESSION_SECRET) { $env:SESSION_SECRET } else { 'change-me-session-secret' }
$env:CRYPTO_SECRET  = if ($env:CRYPTO_SECRET) { $env:CRYPTO_SECRET } else { $env:SESSION_SECRET }
$env:GIN_MODE       = 'release'
$env:TZ             = 'Asia/Shanghai'
$env:NODE_NAME      = 'local-node-1'
$out = Join-Path $LogDir 'new-api.out.log'
$err = Join-Path $LogDir 'new-api.err.log'
$p = Start-Process -FilePath $Bin -WorkingDirectory $Data -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $LogDir 'new-api.pid') -Value $p.Id -Encoding ASCII
Start-Sleep -Seconds 3
Write-Host ("started new-api pid=" + $p.Id + " port=" + $env:PORT + " -> http://127.0.0.1:" + $env:PORT)
