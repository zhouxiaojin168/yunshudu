# start-autosync.ps1 -- 后台常驻：本地改动实时自动同步到 GitHub
#   日志: runtime\logs\autosync.out.log  /  runtime\logs\auto-sync.log
param([int]$IntervalSec = 60, [int]$DebounceSec = 8)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'runtime\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$pidFile = Join-Path $LogDir 'autosync.pid'
if (Test-Path $pidFile) {
  $old = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $alive = Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue
  if ($alive) { Write-Host ('已经在跑 pid=' + $old + '（先跑 stop-autosync.ps1）'); exit 0 }
}

# 显式把 token 塞进子进程环境（计划任务/独立窗口里常常没有 CODEX_HOME）
$cands = @()
if ($env:GITHUB_TOKEN_FILE) { $cands += $env:GITHUB_TOKEN_FILE }
if ($env:USERPROFILE)      { $cands += (Join-Path $env:USERPROFILE '.yunshudu\gh-token.txt') }
if ($env:CODEX_HOME)       { $cands += (Join-Path $env:CODEX_HOME 'work\tools\gh-token.json') }
foreach ($p in $cands) {
  if (-not (Test-Path $p)) { continue }
  try {
    $raw = (Get-Content -LiteralPath $p -Raw).Trim()
    if ($raw.StartsWith('{')) { $env:GITHUB_TOKEN = ($raw | ConvertFrom-Json).access_token } else { $env:GITHUB_TOKEN = $raw }
    Write-Host ('token 已注入 (来源: ' + $p + ')')
    break
  } catch {}
}
if (-not $env:GITHUB_TOKEN) { Write-Host '⚠ 没找到 token，改动只会提交不会推送' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\node-v\node.exe' }
$args = @((Join-Path $Root 'scripts\auto-sync.js'), '--interval', $IntervalSec, '--debounce', $DebounceSec)
$p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $Root `
     -RedirectStandardOutput (Join-Path $LogDir 'autosync.out.log') `
     -RedirectStandardError  (Join-Path $LogDir 'autosync.err.log') `
     -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ASCII
Start-Sleep -Seconds 2
Write-Host ('autosync started  pid=' + $p.Id + '  debounce=' + $DebounceSec + 's  interval=' + $IntervalSec + 's')
Write-Host ('log -> ' + (Join-Path $LogDir 'auto-sync.log'))