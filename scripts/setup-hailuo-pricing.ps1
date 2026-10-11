<#
  setup-hailuo-pricing.ps1 — 预置「海螺 / MiniMax」形态的价格、分组、套餐、签到、额度显示。

  在 new-api 所在机器上运行（本机 127.0.0.1:3000）：
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\yunshudu\app\scripts\setup-hailuo-pricing.ps1
    # 或指定配置： -ConfigFile D:\x.json   # 跳过合规闸： -NoCompliance

  幂等：可反复跑。套餐按 title 匹配：存在 -> PUT 更新，不存在 -> POST 新建。
  数据源：config/pricing-hailuo.json（同目录上一级 config/ 下）。
#>
param(
  [string]$Base = "http://127.0.0.1:3000",
  [string]$ConfigFile = "",
  [string]$AdminUser = "root",
  [string]$AdminPassword = "",
  [string]$SecretsFile = "C:\yunshudu\secrets.txt",
  [switch]$NoCompliance
)
$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = "SilentlyContinue"

function Log($m) { Write-Host ("[pricing] " + $m) }
function Sec([string]$name, [string]$file) {
  if (-not (Test-Path $file)) { return "" }
  foreach ($l in (Get-Content $file -Encoding UTF8)) {
    if ($l -match ("^\s*" + $name + "\s*=")) { return ($l -split "=",2)[1].Trim() }
  }
  return ""
}

if (-not $ConfigFile) {
  $cand = @((Join-Path $PSScriptRoot "..\config\pricing-hailuo.json"), (Join-Path $PSScriptRoot "pricing-hailuo.json"))
  foreach ($c in $cand) { if (Test-Path $c) { $ConfigFile = (Resolve-Path $c).Path; break } }
}
if (-not $ConfigFile -or -not (Test-Path $ConfigFile)) { throw ("pricing config not found (tried: " + $ConfigFile + ")") }
if (-not $AdminPassword) { $AdminPassword = Sec "ADMIN_PASSWORD" $SecretsFile }
if (-not $AdminPassword) { throw "ADMIN_PASSWORD missing: pass -AdminPassword or put it in secrets.txt" }

$cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
Log ("config = " + $ConfigFile)

# ---------- login ----------
$loginBody = @{ username = $AdminUser; password = $AdminPassword } | ConvertTo-Json -Compress
$lg = Invoke-RestMethod -Uri ($Base + "/api/user/login") -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($loginBody)) -TimeoutSec 25
if (-not $lg.success) { throw ("login failed: " + ($lg | ConvertTo-Json -Compress)) }
$H = @{ Authorization = ("Bearer " + $lg.data.access_token); "New-Api-User" = [string]$lg.data.user.id }
Log ("login ok, admin id = " + $lg.data.user.id)

function ApiJson([string]$method, [string]$path, $obj) {
  $p = @{ Uri = ($Base + $path); Method = $method; Headers = $H; TimeoutSec = 40 }
  if ($null -ne $obj) {
    # PS 5.1 的 Invoke-RestMethod 默认按 latin1 编码 body，中文会被写成 "??"，必须显式给 UTF-8 字节
    $json = ($obj | ConvertTo-Json -Depth 10 -Compress)
    $p.ContentType = "application/json; charset=utf-8"
    $p.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  try { return Invoke-RestMethod @p }
  catch {
    $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    $msg = ""; try { $msg = $_.ErrorDetails.Message } catch { try { $msg = $_.Exception.Message } catch {} }
    if ($msg -and $msg.Length -gt 300) { $msg = $msg.Substring(0,300) }
    Log ("FAIL " + $method + " " + $path + " http=" + $code + " " + $msg)
    return $null
  }
}

$script:fail = 0
function PutOpt([string]$key, [string]$val) {
  $r = ApiJson "PUT" "/api/option/" @{ key = $key; value = $val }
  if ($r -and $r.success) { Log ("set " + $key + " = " + $val); return }
  $msg = ""; if ($r) { $msg = [string]$r.message }
  Log ("SET FAILED -> " + $key + " :: " + $msg + " (retrying once)")
  $r2 = ApiJson "PUT" "/api/option/" @{ key = $key; value = $val }
  if ($r2 -and $r2.success) { Log ("retry ok: " + $key) } else { $script:fail++; Log ("SET STILL FAILED -> " + $key) }
}
function J($o) { return ($o | ConvertTo-Json -Depth 10 -Compress) }
# 少数选项在服务端是强类型（如 AutoGroups = []string），value 必须原样传 JSON 数组/对象，不能当字符串
function PutOptRaw([string]$key, $val) {
  $r = ApiJson "PUT" "/api/option/" @{ key = $key; value = $val }
  if ($r -and $r.success) { Log ("set " + $key + " = " + (J $val)); return }
  $msg = ""; if ($r) { $msg = [string]$r.message }
  $script:fail++; Log ("SET FAILED -> " + $key + " :: " + $msg)
}

# ---------- 1) 合规闸（订阅/兑换/邀请 的总开关） ----------
if (-not $NoCompliance) {
  $r = ApiJson "POST" "/api/option/payment_compliance" @{ confirmed = $true }
  if ($r -and $r.success) { Log ("payment compliance confirmed (terms=" + $r.data.terms_version + ")") }
  else { Log "payment compliance: not confirmed via API (可能已确认 / 需要面板会话)" }
}

# ---------- 2) 额度展示口径：算力 ----------
if ($cfg.display) {
  foreach ($k in @("quota_display_type","custom_currency_symbol","custom_currency_exchange_rate")) {
    if ($cfg.display.PSObject.Properties.Name -contains $k) { PutOpt ("general_setting." + $k) ([string]$cfg.display.$k) }
  }
  if ($cfg.display.PSObject.Properties.Name -contains "display_in_currency_enabled") {
    PutOpt "DisplayInCurrencyEnabled" ([string]$cfg.display.display_in_currency_enabled)
  }
}
if ($cfg.currency -and $cfg.currency.usd_exchange_rate) { PutOpt "USDExchangeRate" ([string]$cfg.currency.usd_exchange_rate) }

# ---------- 3) 分组倍率 ----------
if ($cfg.groups) {
  $g = $cfg.groups
  if ($g.group_ratio)          { PutOpt "group_ratio_setting.group_ratio"         (J $g.group_ratio) }
  if ($g.group_group_ratio)    { PutOpt "group_ratio_setting.group_group_ratio"   (J $g.group_group_ratio) }
  if ($g.topup_group_ratio)    { PutOpt "TopupGroupRatio"                          (J $g.topup_group_ratio) }
  if ($g.user_usable_groups)   { PutOpt "UserUsableGroups"                         (J $g.user_usable_groups) }
  if ($g.auto_groups)          { PutOptRaw "AutoGroups" $g.auto_groups }   # AutoGroups 是 []string，必须传真数组
  PutOpt "GroupRatio" (J $g.group_ratio)
  PutOpt "GroupGroupRatio" (J $g.group_group_ratio)
}

# ---------- 4) 模型价格 / 倍率 ----------
if ($cfg.models) {
  $mr = @{}; $mp = @{}; $meta = @{}
  foreach ($p in $cfg.models.PSObject.Properties) {
    $mr[$p.Name] = [double]$p.Value.ratio
    $mp[$p.Name] = [double]$p.Value.price
    $meta[$p.Name] = @{ ratio = [double]$p.Value.ratio; locked = $false }
  }
  PutOpt "ModelRatio" (J $mr)
  PutOpt "ModelPrice" (J $mp)
  PutOpt "CompletionRatioMeta" (J $meta)
}

# ---------- 5) 签到 ----------
if ($cfg.checkin) {
  PutOpt "checkin_setting.enabled"   ([string]$cfg.checkin.enabled)
  PutOpt "checkin_setting.min_quota" ([string]$cfg.checkin.min_quota)
  PutOpt "checkin_setting.max_quota" ([string]$cfg.checkin.max_quota)
}

# ---------- 6) 订阅套餐（按 title 幂等 upsert） ----------
$existing = @{}
$cur = ApiJson "GET" "/api/subscription/admin/plans" $null
if ($cur -and $cur.success -and $cur.data) {
  foreach ($item in $cur.data) {
    $rec = $item; if ($item.plan) { $rec = $item.plan }
    if ($rec.title) { $existing[[string]$rec.title] = [int]$rec.id }
  }
}
foreach ($pl in $cfg.plans) {
  $body = @{ plan = $pl }
  $t = [string]$pl.title
  if ($existing.ContainsKey($t)) {
    $r = ApiJson "PUT" ("/api/subscription/admin/plans/" + $existing[$t]) $body
    if ($r -and $r.success) { Log ("plan updated: " + $t + " (id=" + $existing[$t] + ")") } else { $script:fail++; Log ("plan UPDATE failed: " + $t) }
  } else {
    $r = ApiJson "POST" "/api/subscription/admin/plans" $body
    if ($r -and $r.success) { Log ("plan created: " + $t + " (id=" + $r.data.id + ", " + $pl.total_amount + " 算力/" + $pl.duration_value + " " + $pl.duration_unit + ")") }
    else { $script:fail++; Log ("plan CREATE failed: " + $t) }
  }
}

# ---------- 7) 回读校验 ----------
Log "---- readback ----"
$o = ApiJson "GET" "/api/option/" $null
if ($o -and $o.data) {
  $map = @{}; foreach ($x in $o.data) { $map[$x.key] = [string]$x.value }
  foreach ($k in @("group_ratio_setting.group_ratio","UserUsableGroups","ModelRatio","ModelPrice","checkin_setting.enabled","general_setting.quota_display_type","general_setting.custom_currency_symbol","general_setting.custom_currency_exchange_rate","payment_setting.compliance_confirmed")) {
    if ($map.ContainsKey($k)) { Log ("  [" + $k + "] = " + $map[$k]) } else { Log ("  [" + $k + "] = <missing>") }
  }
}
$cur2 = ApiJson "GET" "/api/subscription/admin/plans" $null
if ($cur2 -and $cur2.data) {
  foreach ($item in $cur2.data) {
    $rec = $item; if ($item.plan) { $rec = $item.plan }
    Log ("  plan#" + $rec.id + " " + $rec.title + " | " + $rec.price_amount + " " + $rec.currency + " | " + $rec.total_amount + " 算力 / " + $rec.duration_value + " " + $rec.duration_unit + " | reset=" + $rec.quota_reset_period + " | up=" + $rec.upgrade_group + " | enabled=" + $rec.enabled)
  }
}

if ($script:fail -gt 0) { Log ("DONE WITH " + $script:fail + " FAILURE(S)"); exit 2 }
Log "PRICING_OK"
exit 0
