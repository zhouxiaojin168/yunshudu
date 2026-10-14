<#
  install-h3-pool-task.ps1 -- 给「海外海螺(hailuoai.video) 邮箱号池」装一个计划任务(cron 等价)
  默认：每 30 分钟跑一轮「巡检 + 补号到目标数量」；
        -Mode Loop 则改为常驻(启动时拉起，内部每 interval 秒一轮)。

  用法（本地）:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-h3-pool-task.ps1 `
      -MailKey mfa-xxxx -Target 200 -IntervalMinutes 30
  用法（服务器，键从 secrets.txt 取）:
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\app\scripts\install-h3-pool-task.ps1 `
      -Secrets C:\yunshudu\secrets.txt -StateDir C:\yunshudu\state\h3 -TaskName yunshudu-h3-pool-cron

  说明: MF_KEY 会写进 <StateDir>\..\h3-pool.env.ps1（本机私有，不要提交）。-Uninstall 卸载任务。
#>
param(
  [string]$TaskName = 'h3-pool-daemon',
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$Node = '',
  [string]$MailBase = '',
  [string]$MailKey = '',
  [string]$Secrets = '',
  [string]$SecretsKey = 'MAILFARM_API_KEY',
  [string]$Host2 = 'hailuoai.video',
  [string]$Lang = 'en',
  [int]$Target = 200,
  [int]$Concurrency = 6,
  [int]$IntervalMinutes = 30,
  [int]$LoopIntervalSec = 600,
  [ValidateSet('Cron', 'Loop')][string]$Mode = 'Cron',
  [string]$StateDir = '',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ('uninstalled task ' + $TaskName)
  } else { Write-Host ('task not found: ' + $TaskName) }
  return
}

if (-not $StateDir) { $StateDir = Join-Path $Root 'runtime\h3' }
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$envFile = Join-Path $StateDir 'h3-pool.env.ps1'
$runFile = Join-Path $StateDir 'h3-pool-run.ps1'
$poolFile = Join-Path $StateDir 'h3-accounts.jsonl'
$stateFile = Join-Path $StateDir 'h3-pool-state.json'
$deadFile = Join-Path $StateDir 'h3-accounts.dead.jsonl'

if (-not $MailKey -and $Secrets -and (Test-Path -LiteralPath $Secrets)) {
  foreach ($line in (Get-Content -LiteralPath $Secrets -Encoding UTF8)) {
    $t = $line.Trim(); if (-not $t -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -gt 0 -and $t.Substring(0, $i).Trim() -eq $SecretsKey) { $MailKey = $t.Substring($i + 1).Trim() }
  }
}
if (-not $MailKey -and (Test-Path -LiteralPath $envFile)) {
  $old = Get-Content -LiteralPath $envFile -Raw
  $m = [regex]::Match($old, "MF_KEY\s*=\s*'([^']*)'")
  if ($m.Success) { $MailKey = $m.Groups[1].Value }
}
if (-not $MailKey) { throw 'MF_KEY 缺失：请传 -MailKey 或 -Secrets <secrets.txt>' }

$envBody = @(
  "# 自动生成，含密钥，勿提交/勿外传  ($(Get-Date -Format s))",
  "`$env:MF_KEY = '$MailKey'",
  ($(if ($MailBase) { "`$env:MF_BASE = '$MailBase'" } else { '' })),
  "`$env:H3_HOST = '$Host2'",
  "`$env:H3_LANG = '$Lang'",
  "`$env:OUT = '$poolFile'"
) | Where-Object { $_ }
[System.IO.File]::WriteAllText($envFile, ($envBody -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($true)))

if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source } else { $Node = 'node' }
}
$daemon = Join-Path $Root 'scripts\h3-pool-daemon.js'
$daemonArgs = @('--pool', $poolFile, '--state', $stateFile, '--dead', $deadFile,
          '--target', $Target, '--concurrency', $Concurrency)
if ($Mode -eq 'Loop') { $daemonArgs += @('--loop', '--interval', $LoopIntervalSec) } else { $daemonArgs += @('--once') }
$argStr = ($daemonArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }) -join ' '

$runBody = @(
  "# 自动生成：计划任务入口 ($(Get-Date -Format s))",
  "`$ErrorActionPreference = 'Continue'",
  ". '$envFile'",
  "& '$Node' '$daemon' $argStr",
  "exit `$LASTEXITCODE"
)
[System.IO.File]::WriteAllText($runFile, ($runBody -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($true)))

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $runFile + '"')
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
if ($Mode -eq 'Loop') {
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
} else {
  $t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
       -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
  $triggers = @($t, (New-ScheduledTaskTrigger -AtStartup))
}
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Write-Host ('registered: ' + $TaskName)
Write-Host ('  mode=' + $Mode + ($(if ($Mode -eq 'Cron') { ' every ' + $IntervalMinutes + 'min' } else { ' loop ' + $LoopIntervalSec + 's' })))
Write-Host ('  pool=' + $poolFile)
Write-Host ('  state=' + $stateFile)
Write-Host ('  node=' + $Node)
Write-Host ('  entry=' + $runFile + '   (env/密钥在 ' + $envFile + ')')
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host ('started once for verification: ' + (Get-ScheduledTask -TaskName $TaskName).State)