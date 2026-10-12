<#
  server-health.ps1 -- 服务器自身体检（在服务器上直接跑，不需要 WinRM）

  用法（服务器上）：
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\app\deploy\server-health.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\app\deploy\server-health.ps1 -Root C:\yunshudu -SkipSelftest

  本地远程跑：
    powershell -NoProfile -ExecutionPolicy Bypass -File E:\中转站测试\_ops\srv.ps1 -Script <本文件路径>
#>
param(
  [string]$Root = "C:\yunshudu",
  [switch]$SkipSelftest
)
$ErrorActionPreference = "Continue"
function Line($s) { Write-Output $s }

Line "===== 1) 计划任务 ====="
Get-ScheduledTask | Where-Object { $_.TaskName -like "yunshudu*" } | ForEach-Object {
  $i = Get-ScheduledTaskInfo -TaskName $_.TaskName -ErrorAction SilentlyContinue
  Line ("  " + $_.TaskName + " state=" + $_.State + " lastRun=" + $i.LastRunTime + " result=" + $i.LastTaskResult)
}

Line "===== 2) 端口监听 ====="
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 25,80,3000,8080,8099,8899,9940,9950,29731 } | ForEach-Object { Line ("  " + $_.LocalAddress + ":" + $_.LocalPort + " pid=" + $_.OwningProcess) }

Line "===== 3) HTTP 健康 ====="
foreach ($u in @("http://127.0.0.1:3000/api/status","http://127.0.0.1:8080/__edge/health","http://127.0.0.1:8080/mailfarm/healthz","http://127.0.0.1:8099/healthz","http://127.0.0.1:8899/","http://127.0.0.1:9940/healthz","http://127.0.0.1:9950/supply/healthz","http://127.0.0.1:29731/ready")) {
  try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 6; Line ("  [v] " + $u + " -> " + $r.StatusCode) }
  catch { Line ("  [x] " + $u + " -> " + $_.Exception.Message.Split([char]10)[0]) }
}

Line "===== 4) 隧道 ====="
$u2 = ""; try { $u2 = (Get-Content (Join-Path $Root "state\tunnel-url.txt") -Raw).Trim() } catch {}
Line ("  tunnel = " + $u2)
if ($u2) { try { $r = Invoke-WebRequest -Uri ($u2 + "/mailfarm/healthz") -UseBasicParsing -TimeoutSec 12; Line ("  [v] 隧道 /mailfarm/healthz -> " + $r.StatusCode) } catch { Line ("  [x] 隧道 -> " + $_.Exception.Message.Split([char]10)[0]) } }

Line "===== 5) 池子 ====="
try {
  $key = ""; foreach ($l in (Get-Content (Join-Path $Root "secrets.txt"))) { if ($l -match "^\s*H3P_ADMIN_KEY\s*=") { $key = ($l -split "=",2)[1].Trim() } }
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:9940/pool/stats" -Headers @{ "x-admin-key" = $key } -TimeoutSec 10
  Line ("  accounts=" + @($st.accounts).Count + " healthy=" + @($st.accounts | Where-Object { $_.healthy -eq 1 }).Count)
} catch { Line ("  [x] " + $_.Exception.Message.Split([char]10)[0]) }

Line "===== 6) 版本/磁盘 ====="
Line ("  deployed-sha = " + ((Get-Content (Join-Path $Root "state\deployed-sha.txt") -Raw -ErrorAction SilentlyContinue).Trim()))
Get-PSDrive C | ForEach-Object { Line ("  C: used=" + [math]::Round($_.Used/1GB,1) + "GB free=" + [math]::Round($_.Free/1GB,1) + "GB") }

if (-not $SkipSelftest) {
  Line "===== 7) mailfarm 自测（18199/10025，不碰常驻 8099）====="
  $node = Join-Path $Root "node-v22.23.3\node.exe"
  if (-not (Test-Path $node)) { $node = "node" }
  Push-Location (Join-Path $Root "app")
  $env:MF_DOMAINS = "selftest.local"
  & $node "scripts\mailfarm-selftest.js" 2>&1 | Select-Object -Last 2
  Pop-Location
}
Line "===== DONE ====="
