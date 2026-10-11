<#
  post-deploy.ps1 -- 部署后钩子（由 deploy-agent.ps1 在服务器上调用）
    1) 读 <Root>\app\services.json 拿到服务清单（缺失时退回只保 new-api）
    2) 逐个做健康检查（http 或 tcp），不健康就：确保计划任务存在 -> 拉起 -> 重试 -> 仍不行就杀掉端口占用者再拉起
    3) 打印汇总，关键服务（critical=true）失败会显式报警
    参数: -Root C:\yunshudu  -Sha <commit>
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
  if ($svc.port) { return (Test-Tcp ([int]$svc.port)) }
  return $false
}

function Ensure-Task($svc) {
  $name = [string]$svc.task
  if (-not $name) { Write-Output '    no task name defined'; return $false }
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) { return $true }
  if ([string]$svc.managed -ne 'auto') {
    Write-Output ('    task ' + $name + ' missing and managed=' + [string]$svc.managed + ' (不自动注册)')
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

function Start-SvcTask($svc) {
  $name = [string]$svc.task
  if (-not $name) { return }
  $st = (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue).State
  Write-Output ('    task ' + $name + ' state=' + $st)
  Start-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
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
  Write-Output '  !! services.json 不可用 -> 退回只保 new-api'
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
  if ($hasTask) { Start-SvcTask $s }

  $ok = $false
  for ($i = 0; $i -lt $retries; $i++) {
    Start-Sleep -Seconds $interval
    if (Test-SvcHealth $s) { $ok = $true; break }
  }

  if (-not $ok -and $s.port) {
    Write-Output ('  [' + $nm + '] still down -> kill port owner on ' + [string]$s.port + ' and restart')
    $own = Get-NetTCPConnection -LocalPort ([int]$s.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($own) {
      try { Stop-Process -Id $own.OwningProcess -Force -ErrorAction Stop; Write-Output ('    killed pid ' + $own.OwningProcess) }
      catch { Write-Output ('    kill failed: ' + $_.Exception.Message) }
    }
    Start-Sleep -Seconds 2
    if ($hasTask) { Start-SvcTask $s }
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

