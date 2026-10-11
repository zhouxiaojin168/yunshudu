<#
  setup-pool-channel.ps1 -- 在服务器上把 new-api 的一条渠道指到「平台池」(h3-platform-pool)
  (1) 登录 new-api 拿 access_token
  (2) 按 base_url 清理所有指向池子的旧渠道（幂等 + 去重）
  (3) 在池子里签发一把 unlimited 的渠道 Key
  (4) 建渠道 base_url=http://127.0.0.1:9940，模型/分组对齐；group 默认 default,vip,svip
  (5) 价格默认不写（由 scripts/setup-hailuo-pricing.ps1 统一管理），需要时加 -WritePricing

  在服务器本机跑：
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\app\scripts\setup-pool-channel.ps1

  坑（2026-10-12 修）：
   * PS 5.1 的 Invoke-RestMethod 默认按 latin1 编码 body -> 中文渠道名会被写成 "???"，
     第二次跑就匹配不上、重复建渠道。必须显式传 UTF-8 字节。
#>
param(
  [string]$Root = "C:\yunshudu",
  [string]$NewApiBase = "http://127.0.0.1:3000",
  [string]$User = "root",
  [string]$Password = "",
  [string]$PoolBase = "http://127.0.0.1:9940",
  [string]$ChannelName = "平台池-海螺H3式(platform-pool)",
  [string]$Models = "MiniMax-H3,H3-Max,Hailuo-2.3,MiniMax-Image",
  [string]$Group = "default,vip,svip",
  [switch]$WritePricing
)
$ErrorActionPreference = "Continue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = "SilentlyContinue"
$CT = "application/json; charset=utf-8"

function Get-Secret([string]$name) {
  $f = Join-Path $Root "secrets.txt"
  if (-not (Test-Path $f)) { return "" }
  foreach ($l in (Get-Content -LiteralPath $f -Encoding UTF8)) {
    if ($l -match ("^\s*" + [regex]::Escape($name) + "\s*=")) { return ($l -split "=",2)[1].Trim() }
  }
  return ""
}
# 统一走 UTF-8 字节，避免中文被 latin1 写坏
function Call-Api([string]$method, [string]$url, [hashtable]$headers, $obj) {
  $p = @{ Uri = $url; Method = $method; Headers = $headers; TimeoutSec = 30 }
  if ($null -ne $obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
    $p.ContentType = $CT
    $p.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  return Invoke-RestMethod @p
}

if (-not $Password) { $Password = Get-Secret "ADMIN_PASSWORD" }
if (-not $Password) { Write-Output "POOL_CHANNEL_FAIL: 没拿到 new-api 管理员密码（secrets.txt 的 ADMIN_PASSWORD）"; exit 1 }
$poolKey = Get-Secret "H3P_ADMIN_KEY"
if (-not $poolKey) { Write-Output "POOL_CHANNEL_FAIL: 没拿到 H3P_ADMIN_KEY"; exit 1 }

# ---- 1) 登录 ----
try {
  $lg = Call-Api "Post" ($NewApiBase + "/api/user/login") @{ "Content-Type" = $CT } @{ username = $User; password = $Password }
} catch { Write-Output ("POOL_CHANNEL_FAIL: 登录异常 " + $_.Exception.Message); exit 2 }
if (-not $lg.success) { Write-Output ("POOL_CHANNEL_FAIL: 登录失败 " + ($lg | ConvertTo-Json -Compress)); exit 2 }
$uid = 1; if ($lg.data.user) { $uid = $lg.data.user.id }
$H = @{ "Content-Type" = $CT; "Authorization" = ("Bearer " + $lg.data.access_token); "New-Api-User" = [string]$uid }
Write-Output ("login ok user=" + $lg.data.user.username + " id=" + $uid + " group=" + $lg.data.user.group)

# ---- 2) 按 base_url 清理旧渠道（去重） ----
$removed = 0
try {
  $chs = Call-Api "Get" ($NewApiBase + "/api/channel/?p=0&page_size=200") $H $null
  $list = @($chs.data); if ($chs.data.items) { $list = @($chs.data.items) }
  foreach ($c in $list) {
    $isMine = ($c.base_url -eq $PoolBase) -or ($c.name -eq $ChannelName) -or ($c.name -like "*platform-pool*")
    if ($isMine) {
      Call-Api "Delete" ($NewApiBase + "/api/channel/" + $c.id) $H $null | Out-Null
      Write-Output ("deleted old channel id=" + $c.id + " name=" + $c.name + " base=" + $c.base_url)
      $removed++
    }
  }
} catch { Write-Output ("warn: 列/删旧渠道异常 " + $_.Exception.Message) }
Write-Output ("old channels removed = " + $removed)

# ---- 3) 池子签发渠道 Key（unlimited） ----
try {
  $kr = Call-Api "Post" ($PoolBase + "/pool/keys") @{ "Content-Type" = $CT; "x-admin-key" = $poolKey } @{ label = "new-api-channel"; credits = 0; unlimited = 1 }
  $chKey = $kr.key
} catch { Write-Output ("POOL_CHANNEL_FAIL: 池子签发 Key 失败 " + $_.Exception.Message); exit 3 }
Write-Output ("pool channel key = " + $chKey.Substring(0,[Math]::Min(14,$chKey.Length)) + "... (unlimited)")

# ---- 4) 建渠道 ----
$chBody = @{
  mode = "single"
  channel = @{
    name = $ChannelName
    type = 1
    key = $chKey
    base_url = $PoolBase
    models = $Models
    group = $Group
    status = 1
    priority = 110
    weight = 10
    auto_ban = 0
    setting = "{}"
  }
}
try { $cr = Call-Api "Post" ($NewApiBase + "/api/channel/") $H $chBody }
catch { Write-Output ("POOL_CHANNEL_FAIL: 建渠道异常 " + $_.Exception.Message); exit 4 }
Write-Output ("channel create -> success=" + $cr.success + " msg=" + $cr.message)

# ---- 5) 价格（可选：默认交给 setup-hailuo-pricing.ps1 管） ----
if ($WritePricing) {
  $mp = @{}; $mr = @{}
  foreach ($m in ($Models -split ",")) { $t = $m.Trim(); if ($t) { $mp[$t] = 0.001; $mr[$t] = 1 } }
  try { Call-Api "Put" ($NewApiBase + "/api/option/") $H @{ key = "ModelPrice"; value = (ConvertTo-Json -InputObject $mp -Compress) } | Out-Null; Write-Output "PUT ModelPrice ok" } catch { Write-Output ("ModelPrice warn " + $_.Exception.Message) }
  try { Call-Api "Put" ($NewApiBase + "/api/option/") $H @{ key = "ModelRatio"; value = (ConvertTo-Json -InputObject $mr -Compress) } | Out-Null; Write-Output "PUT ModelRatio ok" } catch { Write-Output ("ModelRatio warn " + $_.Exception.Message) }
} else { Write-Output "pricing untouched (-WritePricing 未开；价格由 setup-hailuo-pricing.ps1 统一预置)" }

# ---- 6) 回读确认 ----
try {
  $chs2 = Call-Api "Get" ($NewApiBase + "/api/channel/?p=0&page_size=200") $H $null
  $l2 = @($chs2.data); if ($chs2.data.items) { $l2 = @($chs2.data.items) }
  foreach ($c in $l2) {
    if ($c.base_url -eq $PoolBase) {
      Write-Output ("VERIFY channel id=" + $c.id + " name=" + $c.name + " base=" + $c.base_url + " group=" + $c.group + " models=" + $c.models + " weight=" + $c.weight + " priority=" + $c.priority + " status=" + $c.status)
    }
  }
} catch { Write-Output ("warn: 回读异常 " + $_.Exception.Message) }
Write-Output "POOL_CHANNEL_DONE"
