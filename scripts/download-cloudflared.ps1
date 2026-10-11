# download-cloudflared.ps1 -- 下载 cloudflared.exe 并校验 SHA256（走系统代理）
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $Root 'runtime\bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Out    = Join-Path $BinDir 'cloudflared.exe'
$Proxy  = 'http://127.0.0.1:10090'
$Url    = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

Write-Host ('下载: ' + $Url)
if (Test-Path $Out) { Write-Host ('已存在，大小 ' + (Get-Item $Out).Length + ' B，跳过下载') }
else {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Invoke-WebRequest -Uri $Url -OutFile $Out -Proxy $Proxy -TimeoutSec 600 -UseBasicParsing
  $sw.Stop()
  Write-Host ('完成: ' + (Get-Item $Out).Length + ' B，耗时 ' + [int]$sw.Elapsed.TotalSeconds + ' s')
}

$h = (Get-FileHash -LiteralPath $Out -Algorithm SHA256).Hash.ToLower()
Write-Host ('SHA256 = ' + $h)

# 从 GitHub API 取官方 digest 做对照（不可用时只记录本地哈希）
try {
  $api = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
  $rel = Invoke-RestMethod -Uri $api -Proxy $Proxy -TimeoutSec 60 -Headers @{ 'User-Agent'='wangzha-agent'; Accept='application/vnd.github+json' }
  $asset = $rel.assets | Where-Object { $_.name -eq 'cloudflared-windows-amd64.exe' }
  if ($asset -and $asset.digest) {
    $official = ($asset.digest -replace '^sha256:','')
    Write-Host ('官方 digest = ' + $official)
    if ($official -eq $h) { Write-Host '校验: ✅ 一致' } else { Write-Host '校验: ❌ 不一致（不要使用！）' }
  } else {
    Write-Host ('tag = ' + $rel.tag_name + ' ；该 asset 未提供 digest 字段')
  }
} catch { Write-Host ('GitHub API 取 digest 失败: ' + $_.Exception.Message) }

& $Out --version