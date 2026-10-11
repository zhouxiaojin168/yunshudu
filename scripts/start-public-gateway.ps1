# start-public-gateway.ps1 -- 起「只读白名单反代」+ cloudflared 快速隧道，拿到公网 https 地址
#   产物: runtime\public-gateway-url.txt  /  日志 runtime\logs\public-gateway.log, cloudflared.log
param([int]$Port = 8898)
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'runtime\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$node       = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\node-v\node.exe' }
$cloudflared = Join-Path $Root 'runtime\bin\cloudflared.exe'
if (-not (Test-Path $cloudflared)) { throw ('缺少 ' + $cloudflared + '，先跑 scripts\download-cloudflared.ps1') }

function Stop-ByPidFile($f, $name) {
  if (Test-Path $f) {
    $old = (Get-Content -LiteralPath $f -Raw).Trim()
    if ($old) { try { Stop-Process -Id ([int]$old) -Force -ErrorAction Stop; Write-Host ('已停止旧 ' + $name + ' pid=' + $old) } catch {} }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
}

# ---------- 1) 只读反代 ----------
$gwPidFile = Join-Path $LogDir 'public-gateway.pid'
Stop-ByPidFile $gwPidFile 'public-gateway'
$gwOut = Join-Path $LogDir 'public-gateway.out.log'
$gwErr = Join-Path $LogDir 'public-gateway.err.log'
$gw = Start-Process -FilePath $node -ArgumentList (Join-Path $Root 'scripts\public-gateway.js') `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $gwOut -RedirectStandardError $gwErr
Set-Content -LiteralPath $gwPidFile -Value $gw.Id -Encoding ASCII
Start-Sleep -Seconds 2
$alive = Get-Process -Id $gw.Id -ErrorAction SilentlyContinue
if ($alive) { Write-Host ('public-gateway 已起 pid=' + $gw.Id + '  http://127.0.0.1:' + $Port) }
else { Write-Host 'public-gateway 启动失败，看 runtime\logs\public-gateway.err.log'; Get-Content -LiteralPath $gwErr -Encoding UTF8 -Tail 20; exit 1 }

# 本机自测
try {
  $h = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec 10
  Write-Host ('本机自测 /healthz -> ok=' + $h.ok + '  allow=' + ($h.allow -join ','))
} catch { Write-Host ('本机自测失败: ' + $_.Exception.Message) }

# ---------- 2) cloudflared 快速隧道 ----------
$cfPidFile = Join-Path $LogDir 'cloudflared.pid'
Stop-ByPidFile $cfPidFile 'cloudflared'
$cfLog = Join-Path $LogDir 'cloudflared.log'
if (Test-Path $cfLog) { Remove-Item -LiteralPath $cfLog -Force }

# --protocol http2: 强制走 TCP:7844（本机实测 TCP 可达；QUIC/UDP 未必通）
$cfArgs = @('tunnel', '--url', ('http://127.0.0.1:' + $Port), '--protocol', 'http2', '--no-autoupdate')
$cf = Start-Process -FilePath $cloudflared -ArgumentList $cfArgs -WorkingDirectory $Root `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput $cfLog -RedirectStandardError ($cfLog + '.err')
Set-Content -LiteralPath $cfPidFile -Value $cf.Id -Encoding ASCII
Write-Host ('cloudflared 已起 pid=' + $cf.Id + '，等待分配地址...')

# ---------- 3) 抓公网地址 ----------
$url = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $txt = ''
  foreach ($lf in @($cfLog, ($cfLog + '.err'))) { if (Test-Path $lf) { $txt += (Get-Content -LiteralPath $lf -Raw -Encoding UTF8) } }
  $m = [regex]::Match($txt, 'https://[a-z0-9][a-z0-9\-]*\.trycloudflare\.com')
  if ($m.Success) { $url = $m.Value; break }
  if (-not (Get-Process -Id $cf.Id -ErrorAction SilentlyContinue)) { Write-Host 'cloudflared 进程已退出'; break }
}
if (-not $url) {
  Write-Host '❌ 未拿到公网地址，cloudflared 日志尾部：'
  if (Test-Path ($cfLog + '.err')) { Get-Content -LiteralPath ($cfLog + '.err') -Encoding UTF8 -Tail 30 }
  exit 1
}

Set-Content -LiteralPath (Join-Path $Root 'runtime\public-gateway-url.txt') -Value $url -Encoding ASCII
Write-Host ''
Write-Host ('✅ 公网网关地址 = ' + $url)
Write-Host ('   验证: Invoke-RestMethod ' + $url + '/api/status')