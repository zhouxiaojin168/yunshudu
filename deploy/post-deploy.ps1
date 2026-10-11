<#
  post-deploy.ps1 -- 部署后钩子（由 deploy-agent.ps1 在服务器上调用）
    职责: 确保 new-api 在跑 + 健康检查 + 失败重启；预留 Node 服务拉起入口
#>
param(
  [string]$Root = 'C:\yunshudu',
  [string]$Sha  = ''
)
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
Write-Output ('post-deploy start sha=' + $Sha + ' root=' + $Root)

$taskName = 'yunshudu-new-api'
$st = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
Write-Output ('  task ' + $taskName + ' state=' + $st)

if (-not (Get-Process new-api -ErrorAction SilentlyContinue)) {
  Write-Output '  new-api not running -> Start-ScheduledTask'
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 8
}

$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/status' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
Write-Output ('  new-api healthy=' + $ok)

if (-not $ok) {
  Write-Output '  !! health check failed -> hard restart'
  Get-Process new-api -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 10
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/status' -UseBasicParsing -TimeoutSec 5
    Write-Output ('  after restart healthy=' + ($r.StatusCode -eq 200))
  } catch { Write-Output '  after restart still failing' }
}

# Node 侧服务（如果仓库里放了 services.json，就按它拉起）
$svcFile = Join-Path $Root 'app\services.json'
if (Test-Path $svcFile) {
  Write-Output ('  services.json found (' + (Get-Item $svcFile).Length + 'B)')
  try {
    $svcs = Get-Content -LiteralPath $svcFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($s in $svcs) {
      Write-Output ('  node service: ' + $s.name + ' -> ' + $s.script)
    }
  } catch { Write-Output ('  services.json parse FAIL ' + $_.Exception.Message) }
}

Write-Output 'post-deploy done'
