<#
  setup-pool-channel.ps1 -- 在服务器上把 new-api 的一条渠道指到「平台池」
    (1) 登录 new-api 拿 access_token
    (2) 删掉同名旧渠道（幂等）
    (3) 在池子里签发一把 unlimited 的渠道 Key
    (4) 建渠道 base_url=http://127.0.0.1:9940，模型对齐池子的 SPECS
    (5) 顺手把模型价格写进 new-api（ModelPrice/ModelRatio）

  在服务器本机跑（或由本地 WinRM 调用）：
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\app\scripts\setup-pool-channel.ps1

  参数（默认值即服务器现状）：
    -NewApiBase  http://127.0.0.1:3000
    -User        root
    -Password    <从 C:\yunshudu\secrets.txt 的 ADMIN_PASSWORD 读>
    -PoolBase    http://127.0.0.1:9940
    -ChannelName 平台池-海螺H3式(platform-pool)
    -Models      MiniMax-H3,H3-Max,Hailuo-2.3,MiniMax-Image
#>
param(
  [string]$Root = 'C:\yunshudu',
  [string]$NewApiBase = 'http://127.0.0.1:3000',
  [string]$User = 'root',
  [string]$Password = '',
  [string]$PoolBase = 'http://127.0.0.1:9940',
  [string]$ChannelName = '平台池-海螺H3式(platform-pool)',
  [string]$Models = 'MiniMax-H3,H3-Max,Hailuo-2.3,MiniMax-Image',
  [double]$VideoPrice = 1.0,
  [double]$ImagePrice = 0.05
)
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = "SilentlyContinue"

# ---- 从 secrets.txt 取密钥 ----
function Get-Secret([string]$name) {
  $f = Join-Path $Root 'secrets.txt'
  if (-not (Test-Path $f)) { return "" }
  foreach ($l in (Get-Content -LiteralPath $f -Encoding UTF8)) {
    if ($l -match ('^\s*' + [regex]::Escape($name) + '\s*=')) { return ($l -split '=',2)[1].Trim() }
  }
  return ""
}
if (-not $Password) { $Password = Get-Secret "ADMIN_PASSWORD" }
if (-not $Password) { Write-Output "POOL_CHANNEL_FAIL: 没拿到 new-api 管理员密码（secrets.txt 的 ADMIN_PASSWORD）"; exit 1 }
$poolKey = Get-Secret "H3P_ADMIN_KEY"
if (-not $poolKey) { Write-Output "POOL_CHANNEL_FAIL: 没拿到 H3P_ADMIN_KEY"; exit 1 }

$jq = @{ "Content-Type" = "application/json" }

# ---- 1) 登录 ----
$loginBody = @{ username = $User; password = $Password } | ConvertTo-Json -Compress
try {
  $lg = Invoke-RestMethod -Uri ($NewApiBase + '/api/user/login') -Method Post -Headers $jq -Body $loginBody -TimeoutSec 20
} catch { Write-Output ("POOL_CHANNEL_FAIL: 登录异常 " + $_.Exception.Message); exit 2 }
if (-not $lg.success) { Write-Output ("POOL_CHANNEL_FAIL: 登录失败 " + ($lg | ConvertTo-Json -Compress)); exit 2 }
$adm = $lg.data.access_token
Write-Output ("login ok user=" + $lg.data.username + " id=" + $lg.data.id)
$H = @{ "Content-Type" = "application/json"; "Authorization" = ("Bearer " + $adm); "New-Api-User" = [string]$lg.data.id }

# ---- 2) 删同名旧渠道 ----
try {
  $chs = Invoke-RestMethod -Uri ($NewApiBase + '/api/channel/?p=0&page_size=200') -Headers $H -TimeoutSec 20
  $list = @($chs.data)
  if ($chs.data.items) { $list = @($chs.data.items) }
  foreach ($c in $list) {
    if ($c.name -eq $ChannelName) {
      Invoke-RestMethod -Uri ($NewApiBase + '/api/channel/' + $c.id) -Method Delete -Headers $H -TimeoutSec 20 | Out-Null
      Write-Output ("deleted old channel id=" + $c.id)
    }
  }
} catch { Write-Output ("warn: 列/删旧渠道异常 " + $_.Exception.Message) }

# ---- 3) 池子签发渠道 Key（unlimited）----
$pkH = @{ "Content-Type" = "application/json"; "x-admin-key" = $poolKey }
try {
  $kr = Invoke-RestMethod -Uri ($PoolBase + '/pool/keys') -Method Post -Headers $pkH -Body (@{ label = 'new-api-channel'; credits = 0; unlimited = 1 } | ConvertTo-Json -Compress) -TimeoutSec 20
  $chKey = $kr.key
} catch { Write-Output ("POOL_CHANNEL_FAIL: 池子签发 Key 失败 " + $_.Exception.Message); exit 3 }
Write-Output ("pool channel key = " + $chKey.Substring(0,[Math]::Min(14,$chKey.Length)) + "... (unlimited)")

# ---- 4) 建渠道 ----
$chBody = @{
  mode = 'single'
  channel = @{
    name = $ChannelName
    type = 1
    key = $chKey
    base_url = $PoolBase
    models = $Models
    group = 'default'
    status = 1
    priority = 110
    weight = 10
    auto_ban = 0
    setting = '{}'
  }
} | ConvertTo-Json -Compress -Depth 6
try {
  $cr = Invoke-RestMethod -Uri ($NewApiBase + '/api/channel/') -Method Post -Headers $H -Body $chBody -TimeoutSec 25
} catch { Write-Output ("POOL_CHANNEL_FAIL: 建渠道异常 " + $_.Exception.Message); exit 4 }
Write-Output ("channel create -> success=" + $cr.success + " msg=" + $cr.message)

# ---- 5) 模型价格 ----
function Set-Option([string]$key, $obj) {
  $body = @{ key = $key; value = ($obj | ConvertTo-Json -Compress) } | ConvertTo-Json -Compress
  try { $r = Invoke-RestMethod -Uri ($NewApiBase + '/api/option/') -Method Put -Headers $H -Body $body -TimeoutSec 20; return $r.success } catch { return $false }
}
$mp = @{}; $mr = @{}
$mp["MiniMax-H3"] = $VideoPrice; $mp["H3-Max"] = $VideoPrice; $mp["Hailuo-2.3"] = $VideoPrice; $mp["MiniMax-Image"] = $ImagePrice
$mr["MiniMax-H3"] = 1; $mr["H3-Max"] = 1; $mr["Hailuo-2.3"] = 1; $mr["MiniMax-Image"] = 1
Write-Output ("PUT ModelPrice -> " + (Set-Option "ModelPrice" $mp))
Write-Output ("PUT ModelRatio -> " + (Set-Option "ModelRatio" $mr))

# ---- 6) 回读确认 ----
try {
  $chs2 = Invoke-RestMethod -Uri ($NewApiBase + '/api/channel/?p=0&page_size=200') -Headers $H -TimeoutSec 20
  $l2 = @($chs2.data); if ($chs2.data.items) { $l2 = @($chs2.data.items) }
  foreach ($c in $l2) { if ($c.name -eq $ChannelName) { Write-Output ("VERIFY channel id=" + $c.id + " base=" + $c.base_url + " models=" + $c.models + " weight=" + $c.weight + " priority=" + $c.priority + " status=" + $c.status) } }
} catch { Write-Output ("warn: 回读异常 " + $_.Exception.Message) }
Write-Output "POOL_CHANNEL_DONE"
