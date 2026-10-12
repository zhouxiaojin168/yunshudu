<#
  keep-services.ps1 -- 服务看门狗（每 5 分钟由计划任务 yunshudu-keeper 调用）
    探本地端口，哪个没在 Listen 就 Start-ScheduledTask 把对应计划任务拉起来。
    只做「拉起来」，不做杀进程；幂等，可重复跑。
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File keep-services.ps1 [-Root C:\yunshudu]
#>
param([string]$Root = 'C:\yunshudu')
$ErrorActionPreference = 'Continue'
$logd = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logd | Out-Null
$log = Join-Path $logd 'keeper.log'
function W([string]$m) { $line = ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $m); Add-Content -LiteralPath $log -Value $line -Encoding UTF8 }

# port -> 计划任务（一个服务可能听多个端口）
$map = @{
  '3000'  = 'yunshudu-new-api'
  '8080'  = 'yunshudu-edge'
  '8098'  = 'yunshudu-imap-bridge'
  '8099'  = 'yunshudu-mailfarm'
  '8899'  = 'yunshudu-portal'
  '9940'  = 'yunshudu-h3pool'
  '9950'  = 'yunshudu-pool-supply'
  '29731' = 'yunshudu-tunnel'
}

$fixed = @()
foreach ($p in $map.Keys) {
  $port = [int]$p
  $task = $map[$p]
  $ok = $false
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { $ok = $true }
  } catch {}
  if ($ok) { continue }

  $t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if (-not $t) { W ('MISS port=' + $port + ' task=' + $task + ' (task not found, skip)'); continue }
  try {
    Start-ScheduledTask -TaskName $task -ErrorAction Stop
    W ('FIX  port=' + $port + ' task=' + $task + ' state_before=' + $t.State + ' -> Start-ScheduledTask')
    $fixed += ($task + ':' + $port)
  } catch {
    W ('FAIL port=' + $port + ' task=' + $task + ' :: ' + $_.Exception.Message)
  }
}
if ($fixed.Count -eq 0) { W 'ok (all ports listening)' } else { W ('recovered ' + ($fixed -join ',')) }
