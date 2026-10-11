<#
  run-service.ps1 -- 通用服务启动器（services.json 驱动）
    由计划任务以 SYSTEM 身份调用；前台阻塞，任务保持 Running，进程就被 Task Scheduler 托管。
    用法:  powershell -NoProfile -ExecutionPolicy Bypass -File run-service.ps1 -Name edge-proxy [-Root C:\yunshudu]
    行为:  读 <Root>\app\services.json 里的同名条目 -> 设 env -> 启动 node/exe -> 日志重定向 -> 等进程退出
#>
param(
  [Parameter(Mandatory=$true)][string]$Name,
  [string]$Root = 'C:\yunshudu'
)
$ErrorActionPreference = 'Stop'

$svcFile = Join-Path $Root 'app\services.json'
if (-not (Test-Path $svcFile)) { Write-Error ('services.json not found: ' + $svcFile); exit 1 }
$cfg = Get-Content -LiteralPath $svcFile -Raw -Encoding UTF8 | ConvertFrom-Json
$svc = @($cfg.services | Where-Object { $_.name -eq $Name })[0]
if (-not $svc) { Write-Error ('service not found: ' + $Name); exit 1 }

$logd = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logd | Out-Null

if ($svc.env) {
  foreach ($p in $svc.env.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Process')
    Write-Host ('env ' + $p.Name + '=' + [string]$p.Value)
  }
}

$outLog = Join-Path $logd ($Name + '.out.log')
$errLog = Join-Path $logd ($Name + '.err.log')
$pidF   = Join-Path $logd ($Name + '.pid')

$file = $null; $argList = @()

if ($svc.type -eq 'node') {
  $node = Join-Path $Root $svc.node
  if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
  if (-not $node) { Write-Error 'node not found'; exit 1 }
  $script = Join-Path $Root $svc.script
  if (-not (Test-Path $script)) { Write-Error ('script not found: ' + $script); exit 1 }
  $file = $node
  $argList = @($script)
  if ($svc.scriptArgs) { $argList += @($svc.scriptArgs) }
}
elseif ($svc.type -eq 'exe') {
  $file = Join-Path $Root $svc.script
  if (-not (Test-Path $file)) { Write-Error ('exe not found: ' + $file); exit 1 }
  if ($svc.scriptArgs) { $argList = @($svc.scriptArgs) }
}
else { Write-Error ('unknown type: ' + $svc.type); exit 1 }

Write-Host ('starting ' + $Name + ' :: ' + $file + ' ' + ($argList -join ' '))

# 被 Start-Process 重定向的日志文件是追加还是覆盖取决于系统版本，这里先备份旧的，方便排查
foreach ($f in @($outLog, $errLog)) {
  if (Test-Path $f) {
    try { Move-Item -LiteralPath $f -Destination ($f + '.prev') -Force } catch {}
  }
}

$p = Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory $Root `
     -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
     -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidF -Value $p.Id -Encoding ASCII
$p.WaitForExit()
Write-Host ($Name + ' exited with code ' + $p.ExitCode)
exit $p.ExitCode

