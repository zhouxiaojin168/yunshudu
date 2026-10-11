<#
  deploy-agent.ps1 -- 服务器侧「GitHub -> 本机」自动部署代理（由计划任务 yunshudu-deploy 定时调用）
    流程: 取远端 main SHA -> 与状态比对 -> 下载 zip(多源回退) -> 解包到 releases\<sha>
          -> robocopy /MIR 同步到 app\ -> 跑 app\deploy\post-deploy.ps1 -> 记录 SHA -> 清理旧版本
    参数: -Force 强制重部署；-Quiet 不写控制台（只写日志）
#>
param(
  [switch]$Force,
  [switch]$Quiet
)
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'

$Root   = 'C:\yunshudu'
$Repo   = 'zhouxiaojin168/yunshudu'
$Branch = 'main'
$StateD = Join-Path $Root 'state'
$RelD   = Join-Path $Root 'releases'
$AppD   = Join-Path $Root 'app'
$LogD   = Join-Path $Root 'logs'
$TmpD   = Join-Path $Root 'tmp'
$Log    = Join-Path $LogD 'deploy.log'
$ShaF   = Join-Path $StateD 'deployed-sha.txt'
$Lock   = Join-Path $StateD 'deploy.lock'

foreach ($d in @($StateD, $RelD, $AppD, $LogD, $TmpD)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

function L($m) {
  $s = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  Add-Content -LiteralPath $Log -Value $s
  if (-not $Quiet) { Write-Output $s }
}

# 防重入
if (Test-Path $Lock) {
  $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
  if ($age.TotalMinutes -lt 10) { exit 0 }
}
Set-Content -LiteralPath $Lock -Value (Get-Date -Format o) -Encoding ASCII
try {

L '=== deploy-agent run ==='

# 1) 远端最新 SHA
$sha = $null; $msg = ''
try {
  $c = Invoke-RestMethod ('https://api.github.com/repos/' + $Repo + '/commits/' + $Branch) -TimeoutSec 20 -UseBasicParsing -Headers @{ 'User-Agent' = 'yunshudu-agent' }
  $sha = $c.sha
  if ($c.commit) { $msg = [string]$c.commit.message }
  L ('remote sha = ' + $sha + ' :: ' + $msg)
} catch { L ('remote sha FAIL ' + $_.Exception.Message) }

if (-not $sha) { L 'no sha -> abort'; exit 1 }
$cur = ''
if (Test-Path $ShaF) { $cur = (Get-Content -LiteralPath $ShaF -Raw).Trim() }
if ($sha -eq $cur -and -not $Force) { L ('up-to-date (' + $cur.Substring(0,7) + ')'); exit 0 }
L ('deploy ' + $(if ($cur) { $cur.Substring(0,7) } else { 'none' }) + ' -> ' + $sha.Substring(0,7))

# 2) 下载 zip（多源回退）
$zip  = Join-Path $TmpD ($sha + '.zip')
$srcs = New-Object System.Collections.ArrayList
[void]$srcs.Add('https://codeload.github.com/' + $Repo + '/zip/refs/heads/' + $Branch)
[void]$srcs.Add('https://github.com/' + $Repo + '/archive/refs/heads/' + $Branch + '.zip')
[void]$srcs.Add('https://ghproxy.net/https://github.com/' + $Repo + '/archive/refs/heads/' + $Branch + '.zip')
[void]$srcs.Add('https://gh-proxy.com/https://github.com/' + $Repo + '/archive/refs/heads/' + $Branch + '.zip')
$got = $false
foreach ($u in $srcs) {
  try {
    $t0 = Get-Date
    Invoke-WebRequest -Uri $u -OutFile $zip -TimeoutSec 120 -UseBasicParsing
    L ('downloaded ' + (Get-Item $zip).Length + 'B in ' + [math]::Round(((Get-Date)-$t0).TotalSeconds,1) + 's from ' + $u)
    $got = $true
    break
  } catch { L ('download FAIL ' + $u + ' :: ' + $_.Exception.Message) }
}
if (-not $got) { L 'all sources failed -> abort'; exit 2 }

# 3) 解包到 releases\<sha>
$rel   = Join-Path $RelD $sha
$tmpEx = Join-Path $TmpD ('ex-' + $sha)
if (Test-Path $tmpEx) { Remove-Item -LiteralPath $tmpEx -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $tmpEx -Force
$inner = Get-ChildItem -LiteralPath $tmpEx -Directory | Select-Object -First 1
if (-not $inner) { L 'zip inner dir missing -> abort'; exit 3 }
if (Test-Path $rel) { Remove-Item -LiteralPath $rel -Recurse -Force }
Move-Item -LiteralPath $inner.FullName -Destination $rel
Remove-Item -LiteralPath $tmpEx -Recurse -Force
Remove-Item -LiteralPath $zip -Force
L ('release -> ' + $rel)

# 4) 同步到 app
& robocopy $rel $AppD /MIR /NFL /NDL /NP /R:1 /W:1 | Out-Null
$rc = $LASTEXITCODE
L ('robocopy app rc=' + $rc)
if ($rc -ge 8) { L 'robocopy FAILED -> abort'; exit 4 }

# 5) post-deploy
$hook = Join-Path $AppD 'deploy\post-deploy.ps1'
if (Test-Path $hook) {
  L 'running post-deploy.ps1'
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hook -Root $Root -Sha $sha 2>&1
  foreach ($l in $out) { L ('  post | ' + $l) }
} else { L 'no post-deploy hook' }

# 6) 记录
Set-Content -LiteralPath $ShaF -Value $sha -Encoding ASCII
L ('DONE deployed ' + $sha)

# 7) 清理旧 release（保留最近 5 个）
$all = Get-ChildItem -LiteralPath $RelD -Directory | Sort-Object LastWriteTime -Descending
$keep = $all | Select-Object -First 5
foreach ($o in $all) {
  if ($keep.Name -notcontains $o.Name) {
    try { Remove-Item -LiteralPath $o.FullName -Recurse -Force; L ('pruned ' + $o.Name) } catch { L ('prune FAIL ' + $o.Name) }
  }
}

} finally {
  Remove-Item -LiteralPath $Lock -Force -ErrorAction SilentlyContinue
}
