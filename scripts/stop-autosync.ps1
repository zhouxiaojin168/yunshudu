# stop-autosync.ps1 -- 停掉后台自动同步
$Root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $Root 'runtime\logs\autosync.pid'
if (-not (Test-Path $pidFile)) { Write-Host '没有在跑（找不到 pid 文件）'; exit 0 }
$pid_ = (Get-Content -LiteralPath $pidFile -Raw).Trim()
try { Stop-Process -Id ([int]$pid_) -Force -ErrorAction Stop; Write-Host ('已停止 pid=' + $pid_) }
catch { Write-Host ('进程已不在: ' + $pid_) }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue