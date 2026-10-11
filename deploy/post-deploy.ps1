<#
  post-deploy.ps1 -- 部署后钩子（由 deploy-agent.ps1 在服务器上调用）
    1) 读 <Root>\app\services.json 拿到服务清单（缺失时退回只保 new-api）
    2) 逐个健康检查（http / tcp）
    3) 不健康时**硬重启**：停计划任务 -> 按 pid 文件杀 -> 按端口占用杀 -> 再拉起 -> 重试
       （只停任务不管旧进程会死锁：任务 Running 但跑的是旧配置，Start-ScheduledTask 是空操作）
    4) 打印汇总；critical=true 的服务失败会显式报警
#>
param(
  [string]$Root = 'C:\yunshudu',
  [string]$Sha  = ''
)
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'
Write-Output ('post-deploy start sha=' + $Sha + ' root=' + $Root)

function Test-Tcp([int]$port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $ok = $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

function Test-SvcHealth($svc) {
  $h = $svc.health
  if (-not $h) {
    if ($svc.port) { return (Test-Tcp ([int]$svc.port)) }
    return $true
  }
  if ($h.kind -eq 'http') {
    $expect = 200
    if ($h.expect) { $expect = [int]$h.expect }
    try {
      $r = Invoke-WebRequest -Uri ([string]$h.url) -UseBasicParsing -TimeoutSec 5
      return ($r.StatusCode -eq $expect)
    } catch { return $false }
  }
  if ($h.kind -eq 'tcp' -and $svc.port) { return (Test-Tcp ([int]$svc.port)) }
  if ($h.kind -eq 'file') {
    $fp = [string]$h.path
    if (-not $fp) { return $false }
    if (-not (Test-Path -LiteralPath $fp)) { return $false }
    $max = 900
    if ($h.maxAgeSec) { $max = [int]$h.maxAgeSec }
    $age = ((Get-Date) - (Get-Item -LiteralPath $fp).LastWriteTime).TotalSeconds
    return ($age -le $max)
  }
  if ($svc.port) { return (Test-Tcp ([int]$svc.port)) }
  return $false
}

function Ensure-Task($svc) {
  $name = [string]$svc.task
  if (-not $name) { Write-Output '    no task name defined'; return $false }
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) { return $true }
  if ([string]$svc.managed -ne 'auto') {
    Write-Output ('    task ' + $name + ' missing and managed=' + [string]$svc.managed)
    return $false
  }
  $launcher = Join-Path $Root ([string]$svc.launcher)
  if (-not (Test-Path $launcher)) { Write-Output ('    launcher missing: ' + $launcher); return $false }
  $q = [char]34
  $argStr = '-NoProfile -ExecutionPolicy Bypass -File ' + $q + $launcher + $q
  if ($svc.launcherArgs) { $argStr += ' ' + (@($svc.launcherArgs) -join ' ') }
  try {
    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argStr
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Output ('    registered task ' + $name + ' -> ' + $argStr)
    return $true
  } catch {
    Write-Output ('    register task FAIL ' + $name + ' :: ' + $_.Exception.Message)
    return $false
  }
}

function Svc-Ports($svc) {
  $list = @()
  if ($svc.ports) { foreach ($x in @($svc.ports)) { $list += [int]$x } }
  if ($svc.port)  { $list += [int]$svc.port }
  return ($list | Select-Object -Unique)
}

function Hard-Restart($svc, $hasTask) {
  $name = [string]$svc.name
  $task = [string]$svc.task
  if ($hasTask -and $task) {
    Write-Output ('    stopping task ' + $task)
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  $pidF = Join-Path $Root ('logs\' + $name + '.pid')
  if (Test-Path $pidF) {
    $old = 0
    try { $old = [int]((Get-Content -LiteralPath $pidF -Raw).Trim()) } catch { $old = 0 }
    if ($old -gt 0) {
      try { Stop-Process -Id $old -Force -ErrorAction Stop; Write-Output ('    killed pid-file ' + $old) }
      catch { Write-Output ('    pid-file ' + $old + ' not alive') }
    }
  }

  foreach ($pt in (Svc-Ports $svc)) {
    $own = Get-NetTCPConnection -LocalPort $pt -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($own) {
      try { Stop-Process -Id $own.OwningProcess -Force -ErrorAction Stop; Write-Output ('    killed port ' + $pt + ' owner pid=' + $own.OwningProcess) }
      catch { Write-Output ('    kill port ' + $pt + ' owner failed: ' + $_.Exception.Message) }
    }
  }

  Start-Sleep -Seconds 3
  if ($hasTask -and $task) {
    $st = (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State
    Write-Output ('    task ' + $task + ' state=' + $st + ' -> start')
    Start-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  }
}

# ---- 读服务清单 ----
$svcFile = Join-Path $Root 'app\services.json'
$svcs = @()
if (Test-Path $svcFile) {
  try {
    $cfg  = Get-Content -LiteralPath $svcFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $svcs = @($cfg.services)
    Write-Output ('  services.json loaded: ' + $svcs.Count + ' service(s)')
  } catch { Write-Output ('  services.json parse FAIL ' + $_.Exception.Message) }
}
if ($svcs.Count -eq 0) {
  Write-Output '  !! services.json unavailable -> fallback to new-api only'
  $svcs = @([pscustomobject]@{ name = 'new-api'; type = 'exe'; task = 'yunshudu-new-api'; port = 3000; managed = 'external'; critical = $true })
}

$results = @()
foreach ($s in $svcs) {
  $nm = [string]$s.name
  $retries = 15; $interval = 2
  if ($s.health) {
    if ($s.health.retries)     { $retries  = [int]$s.health.retries }
    if ($s.health.intervalSec) { $interval = [int]$s.health.intervalSec }
  }

  if (Test-SvcHealth $s) {
    Write-Output ('  [' + $nm + '] healthy')
    $results += ($nm + '=OK')
    continue
  }

  Write-Output ('  [' + $nm + '] down -> ensuring task')
  $hasTask = Ensure-Task $s

  # 第一轮：只拉起（不动进程），适合「进程没在跑」的常见情况
  if ($hasTask) { Start-ScheduledTask -TaskName ([string]$s.task) -ErrorAction SilentlyContinue }
  $ok = $false
  for ($i = 0; $i -lt [Math]::Min($retries, 8); $i++) {
    Start-Sleep -Seconds $interval
    if (Test-SvcHealth $s) { $ok = $true; break }
  }

  # 第二轮：硬重启（停任务 + 杀旧进程 + 再拉起）
  if (-not $ok) {
    Write-Output ('  [' + $nm + '] still down -> hard restart')
    Hard-Restart $s $hasTask
    for ($i = 0; $i -lt $retries; $i++) {
      Start-Sleep -Seconds $interval
      if (Test-SvcHealth $s) { $ok = $true; break }
    }
  }

  if ($ok) {
    Write-Output ('  [' + $nm + '] recovered')
    $results += ($nm + '=RECOVERED')
  } else {
    Write-Output ('  [' + $nm + '] !! STILL DOWN')
    $results += ($nm + '=DOWN')
    if ($s.critical -eq $true) { Write-Output ('  [' + $nm + '] CRITICAL service is down !') }
  }
}

Write-Output ('  summary: ' + ($results -join ' '))
Write-Output 'post-deploy done'

