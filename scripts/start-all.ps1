# start-all.ps1 -- 一键把整套本地环境拉起来（幂等，可重复执行）
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-all.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'D:\node-v\node.exe' }
if (-not (Test-Path $Node)) { $Node = $null }

function Step($n, $msg) { Write-Host ('[' + $n + '] ' + $msg) -ForegroundColor Cyan }

# 1) 二进制
Step 1 '检查 new-api.exe'
$bin = Join-Path $Root 'runtime\bin\new-api.exe'
if (-not (Test-Path $bin)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'download-release.ps1')
} else { Write-Host ('    already present: ' + $bin) }

# 2) 网关
Step 2 '启动 new-api (3300)'
$running = $false
try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:3300/api/status' -UseBasicParsing -TimeoutSec 3; $running = $true } catch {}
if ($running) { Write-Host '    already listening on 3300' }
else { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-local-windows.ps1') }

if (-not $Node) { Write-Host 'skip 3-8: node not found'; exit 0 }

# 3) 初始化 + 站点参数
Step 3 '初始化 root + 站点参数'
& $Node (Join-Path $PSScriptRoot 'bootstrap-local.js')

# 4) 模拟上游
Step 4 '启动模拟上游号池 (9921 healthy / 9922 quota-dead)'
# 用 TCP 探活, 不要走 /v1/models -- 那个会消耗 mock 的额度计数
$mockUp = $false
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.Connect('127.0.0.1', 9921); $mockUp = $c.Connected; $c.Close()
} catch {}
if ($mockUp) { Write-Host '    already listening on 9921' }
else { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-mock-pool.ps1') }

# 5) 渠道池 + 令牌
Step 5 '创建多 Key 渠道池 + 测试令牌'
& $Node (Join-Path $PSScriptRoot 'setup-channels.js')

# 6) 计价
Step 6 '写入模型计价 (MiniMax-H3/M3)'
& $Node (Join-Path $PSScriptRoot 'set-pricing.js')

# 7) 令牌明文
Step 7 '修正 test-token.txt (接口只返回脱敏 key, 必须读库)'
$out = (& $Node (Join-Path $PSScriptRoot 'show-tokens.js')) -join "`n"
$m = [regex]::Matches($out, 'sk-[A-Za-z0-9]{20,}')
if ($m.Count -gt 0) {
  [System.IO.File]::WriteAllText((Join-Path $Root 'runtime\test-token.txt'), $m[$m.Count - 1].Value, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '    test-token.txt updated'
} else { Write-Host '    !! no token plaintext found' }

# 8) 冒烟
Step 8 '端到端冒烟 (4 calls)'
& $Node (Join-Path $PSScriptRoot 'test-call.js') 4

# 9) 网页门户数据
Step 9 '抓取站点快照 -> web/data/site.json'
& $Node (Join-Path $PSScriptRoot 'build-site-json.js')

# 10) 网页门户
Step 10 '启动网页门户 (8899)'
$webUp = $false
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.Connect('127.0.0.1', 8899); $webUp = $c.Connected; $c.Close()
} catch {}
if ($webUp) { Write-Host '    already listening on 8899' }
else { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-web.ps1') }

Write-Host ''
Write-Host 'DONE  panel : http://127.0.0.1:3300   (see runtime\credentials.txt)' -ForegroundColor Green
Write-Host 'DONE  portal: http://127.0.0.1:8899' -ForegroundColor Green