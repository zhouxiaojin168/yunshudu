$ErrorActionPreference = 'Continue'
$root = 'C:\yunshudu'
$bin  = Join-Path $root 'new-api.exe'
$data = Join-Path $root 'data'
$logd = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $data, $logd | Out-Null

$runFile = Join-Path $root 'run-new-api.ps1'
$runSrc = @'
$root = 'C:\yunshudu'
$sec = @{}
foreach ($l in (Get-Content -LiteralPath (Join-Path $root 'secrets.txt'))) {
  if ($l -match '^([A-Z_]+)=(.*)$') { $sec[$Matches[1]] = $Matches[2] }
}
$env:PORT = '3000'
$env:SESSION_SECRET = $sec['SESSION_SECRET']
$env:CRYPTO_SECRET  = $sec['CRYPTO_SECRET']
$env:GIN_MODE = 'release'
$env:TZ = 'Asia/Shanghai'
$env:NODE_NAME = 'srv-225'
$data = Join-Path $root 'data'
$logd = Join-Path $root 'logs'
$p = Start-Process -FilePath (Join-Path $root 'new-api.exe') -WorkingDirectory $data -RedirectStandardOutput (Join-Path $logd 'new-api.out.log') -RedirectStandardError (Join-Path $logd 'new-api.err.log') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $logd 'new-api.pid') -Value $p.Id -Encoding ASCII
$p.WaitForExit()
'@
Set-Content -LiteralPath $runFile -Value $runSrc -Encoding UTF8
Write-Output ('launcher written: ' + (Get-Item $runFile).Length + 'B')

Get-Process new-api -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

try { Unregister-ScheduledTask -TaskName 'yunshudu-new-api' -Confirm:$false -ErrorAction Stop; Write-Output 'old task removed' } catch { Write-Output 'no old task' }

$act  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\run-new-api.ps1'
$trg  = New-ScheduledTaskTrigger -AtStartup
$prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$set  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'yunshudu-new-api' -Action $act -Trigger $trg -Principal $prin -Settings $set -Force | Out-Null
Write-Output 'task registered'
Start-ScheduledTask -TaskName 'yunshudu-new-api'
Start-Sleep -Seconds 14

Write-Output '--- task info ---'
Get-ScheduledTask -TaskName 'yunshudu-new-api' | ForEach-Object { Write-Output ('  state=' + $_.State) }
Get-ScheduledTaskInfo -TaskName 'yunshudu-new-api' | ForEach-Object { Write-Output ('  lastRun=' + $_.LastRunTime + ' result=' + $_.LastTaskResult) }
Write-Output '--- listen ---'
& netstat -ano | Select-String ':3000' | ForEach-Object { Write-Output ('  ' + $_.ToString().Trim()) }
Write-Output '--- procs ---'
Get-Process new-api -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  pid=' + $_.Id + ' start=' + $_.StartTime) }
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/status' -UseBasicParsing -TimeoutSec 10; Write-Output ('  local status OK ' + $r.StatusCode) } catch { Write-Output ('  local status ERR ' + $_.Exception.Message) }
Write-Output '--- out tail ---'
Get-Content -LiteralPath (Join-Path $logd 'new-api.out.log') -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('  ' + $_) }
