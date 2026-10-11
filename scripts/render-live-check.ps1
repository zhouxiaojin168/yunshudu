# render-live-check.ps1 -- 用无头 Edge 真实打开线上门户，取出渲染后的 DOM 与截图
#   powershell -File scripts\render-live-check.ps1
#   powershell -File scripts\render-live-check.ps1 -Url https://xxx -OutDir runtime\logs
param(
  [string]$Url = 'https://zhouxiaojin168.github.io/yunshudu/',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Root 'runtime\logs' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$edge = $null
foreach ($p in @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)) { if (Test-Path $p) { $edge = $p; break } }
if (-not $edge) { throw '找不到 msedge.exe' }

$profile = Join-Path $env:TEMP ('edge-headless-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$dom = Join-Path $OutDir 'live-dom.html'
$png = Join-Path $OutDir 'live-portal.png'

$common = @('--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars',('--user-data-dir=' + $profile))
& $edge @common '--virtual-time-budget=20000' '--window-size=1200,2400' ('--screenshot=' + $png) $Url 2>$null | Out-Null
& $edge @common '--virtual-time-budget=20000' '--dump-dom' $Url 2>$null | Out-File -LiteralPath $dom -Encoding UTF8

Write-Host ('DOM  -> ' + $dom)
Write-Host ('PNG  -> ' + $png)
$html = Get-Content -LiteralPath $dom -Raw -Encoding UTF8
$checks = @{
  '徽章-在线'   = ($html -match '>在线<')
  '徽章-离线'   = ($html -match '离线快照')
  '网关版本号'  = ($html -match 'v1\.0\.0-rc\.43')
  '站点名'      = ($html -match 'yunshudu')
  '数据源提示'  = ($html -match '__API_BASE__|公网|快照')
}
foreach ($k in $checks.Keys) { Write-Host ('  ' + $k.PadRight(12) + ' = ' + $checks[$k]) }
$m = [regex]::Match($html, '<title>(.*?)</title>')
if ($m.Success) { Write-Host ('title = ' + $m.Groups[1].Value) }
Write-Host ('搜索 __API_BASE__ 值: ' + ([regex]::Match($html, "window\.__API_BASE__ = '([^']*)'").Groups[1].Value))
Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue