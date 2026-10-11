# autosync-once.ps1 -- 计划任务专用：注入 token 后跑一次同步
#   （计划任务的进程环境里往往没有 CODEX_HOME，所以这里显式找 token）
$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\node-v\node.exe' }

$cands = @()
if ($env:GITHUB_TOKEN_FILE) { $cands += $env:GITHUB_TOKEN_FILE }
if ($env:USERPROFILE)      { $cands += (Join-Path $env:USERPROFILE '.yunshudu\gh-token.txt') }
if ($env:CODEX_HOME)       { $cands += (Join-Path $env:CODEX_HOME 'work\tools\gh-token.json') }

foreach ($p in $cands) {
  if (-not (Test-Path $p)) { continue }
  try {
    $raw = (Get-Content -LiteralPath $p -Raw).Trim()
    if ($raw.StartsWith('{')) { $env:GITHUB_TOKEN = ($raw | ConvertFrom-Json).access_token }
    else { $env:GITHUB_TOKEN = $raw }
    break
  } catch {}
}

& $node (Join-Path $Root 'scripts\auto-sync.js') --once
exit 0