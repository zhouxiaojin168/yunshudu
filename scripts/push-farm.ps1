<#
  push-farm.ps1 -- 本地一键「灌号」：把农场文件推到服务器并直接入池

  为什么需要它：服务器上的补给守护会自动读 C:\yunshudu\data\farm-accounts.jsonl，
  但那份文件在服务器上（不能进 Git）。这个脚本负责把它送过去 + 立刻触发一次批量入池。

  用法（本地跑）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-farm.ps1 -File state\farm-accounts.jsonl
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-farm.ps1 -File my-accounts.txt -Mode replace -NoImport

  文件格式：每行一个账号
    {"label":"farm-01","token":"<上游token>"}        # 推荐：不给 credits，入池时自动探真实余额
    <上游token>                                      # 也支持：整行就是一个 token
  以 # 开头的行和空行会被忽略。

  参数：
    -File      本地文件（必填）
    -Mode      append（默认，追加去重）| replace（整份覆盖）
    -NoImport  只上传文件，不立刻入池（交给守护下一轮自己读）
    -CredFile  WinRM 凭据文件，默认 %USERPROFILE%\.yunshudu\srv-225.json
#>
param(
  [Parameter(Mandatory = $true)][string]$File,
  [ValidateSet('append','replace')][string]$Mode = 'append',
  [switch]$NoImport,
  [string]$CredFile = (Join-Path $env:USERPROFILE ".yunshudu\srv-225.json")
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $File)) { Write-Output ("PUSH_FARM_FAIL: 找不到文件 " + $File); exit 1 }
if (-not (Test-Path -LiteralPath $CredFile)) { Write-Output ("PUSH_FARM_FAIL: 找不到凭据 " + $CredFile); exit 1 }

# ---- 1) 解析 ----
$rows = @()
$bad = 0
foreach ($raw in (Get-Content -LiteralPath $File -Encoding UTF8)) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#")) { continue }
  if ($line.StartsWith("{")) {
    try { $o = $line | ConvertFrom-Json } catch { $bad++; continue }
    if (-not $o.token) { $bad++; continue }
    $e = @{ label = ([string]$o.label); token = ([string]$o.token) }
    if ($null -ne $o.credits) { $e.credits = [double]$o.credits }
    $rows += $e
  } else {
    $rows += @{ label = ("farm-" + ($rows.Count + 1)); token = $line }
  }
}
if ($rows.Count -eq 0) { Write-Output ("PUSH_FARM_FAIL: 没解析到任何账号（坏行 " + $bad + "）"); exit 2 }
Write-Output ("parsed " + $rows.Count + " accounts from " + $File + " (bad=" + $bad + ")")

# ---- 2) 连服务器 ----
$j = Get-Content -LiteralPath $CredFile -Raw -Encoding UTF8 | ConvertFrom-Json
$sec = ConvertTo-SecureString $j.pass -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($j.user, $sec)
$opt = @{ ComputerName = $j.host; Authentication = "Basic"; Credential = $cred }

$lines = @($rows | ForEach-Object { if ($null -ne $_.credits) { ($_ | ConvertTo-Json -Compress) } else { (@{ label = $_.label; token = $_.token } | ConvertTo-Json -Compress) } })
$blob = ($lines -join [char]10)

Invoke-Command @opt -ArgumentList $blob, $Mode -ScriptBlock {
  param($blob, $mode)
  $dir = "C:\yunshudu\data"
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $f = Join-Path $dir "farm-accounts.jsonl"
  if ($mode -eq "replace" -or -not (Test-Path $f)) {
    Set-Content -LiteralPath $f -Value $blob -Encoding UTF8
  } else {
    Add-Content -LiteralPath $f -Value $blob -Encoding UTF8
  }
  $n = (@(Get-Content -LiteralPath $f -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") })).Count
  Write-Output ("server farm file: " + $f + " rows=" + $n + " mode=" + $mode)
}

# ---- 3) 立刻入池（可选）----
if (-not $NoImport) {
  Invoke-Command @opt -ArgumentList $blob -ScriptBlock {
    param($blob)
    $f = "C:\yunshudu\secrets.txt"
    $key = ""
    if (Test-Path $f) { foreach ($l in (Get-Content -LiteralPath $f -Encoding UTF8)) { if ($l -match "^\s*H3P_ADMIN_KEY\s*=") { $key = ($l -split "=",2)[1].Trim() } } }
    if (-not $key) { Write-Output "IMPORT_SKIP: 服务器 secrets.txt 里没有 H3P_ADMIN_KEY"; return }
    $accts = @()
    foreach ($l in ($blob -split [char]10)) { $t = $l.Trim(); if ($t) { $accts += ($t | ConvertFrom-Json) } }
    $body = @{ accounts = $accts } | ConvertTo-Json -Compress -Depth 6
    $h = @{ "Content-Type" = "application/json"; "x-admin-key" = $key }
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:9950/supply/import" -Method Post -Headers $h -Body $body -TimeoutSec 60
      Write-Output ("import -> imported=" + $r.imported + " total=" + $r.total)
    } catch { Write-Output ("IMPORT_FAIL: " + $_.Exception.Message) }
    try {
      $st = Invoke-RestMethod -Uri "http://127.0.0.1:9940/pool/stats" -Headers $h -TimeoutSec 20
      $sum = ($st.accounts | Measure-Object -Property credits -Sum).Sum
      Write-Output ("pool -> accounts=" + @($st.accounts).Count + " credits_sum=" + $sum)
    } catch { Write-Output ("stats warn: " + $_.Exception.Message) }
  }
}
Write-Output "PUSH_FARM_DONE"
