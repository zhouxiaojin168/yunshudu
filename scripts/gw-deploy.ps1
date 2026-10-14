<#
  gw-deploy.ps1 -- 一键部署「自建出口网关」到任意 Windows VPS (ysd-gw-server.js)
  用法（本地生成远端脚本 + （可选）WinRM 部署）:
    # 1) 只生成远端脚本（拷到 VPS 上跑）
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gw-deploy.ps1 -GenerateOnly -GatewayPort 38472 -Token gw_xxx

    # 2) WinRM 直连部署（需目标机开放 WinRM + 管理员凭据）
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gw-deploy.ps1 -RemoteHost 1.2.3.4 -User Administrator -Pass 'xxx' -GatewayPort 38472 -Token gw_xxx

  参数:
    -RemoteHost  目标 VPS IP/域名（省略 = 只生成脚本）
    -User/-Pass  WinRM 凭据
    -GatewayPort 网关监听端口（高位，默认 38472）
    -Token       隧道握手 token（请自定义，本机 client 端要用同一个）
    -LocalPort   本机 SOCKS5 监听端口（默认 18081，仅用于打印提示）
    -NodePath    远端 node.exe 路径（默认 C:\yunshudu\node-v22.23.3\node.exe）
    -ExtraJson   额外环境变量 JSON（备用）
#>
param(
  [string]$RemoteHost = "",
  [string]$User = "Administrator",
  [string]$Pass = "",
  [int]$GatewayPort = 38472,
  [string]$Token = "",
  [int]$LocalPort = 18081,
  [string]$NodePath = "C:\yunshudu\node-v22.23.3\node.exe",
  [switch]$GenerateOnly
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Token) { $Token = "gw_" + (-join ((48..57) + (97..122) | Get-Random -Count 12 | ForEach-Object { [char]$_ })) }
$srv = Join-Path $repo "scripts\ysd-gw-server.js"
if (-not (Test-Path $srv)) { throw "找不到 $srv" }
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($srv))
$NL = [Environment]::NewLine
$remote = @()
$remote += "Get-CimInstance Win32_Process -Filter ""Name='node.exe'"" | Where-Object { `$_.CommandLine -like '*ysd-gw-server*' } | ForEach-Object { try { Stop-Process -Id `$_.ProcessId -Force } catch {} }"
$remote += "[IO.File]::WriteAllText('C:\yunshudu\app\scripts\ysd-gw-server.js',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')),(New-Object System.Text.UTF8Encoding(`$false)))"
$remote += "`$l=@('@echo off','set GW_PORT=$GatewayPort','set GW_HOST=0.0.0.0','set GW_TOKEN=$Token','set GW_LOG=C:\yunshudu\logs\gw$GatewayPort.log','$NodePath C:\yunshudu\app\scripts\ysd-gw-server.js >> C:\yunshudu\logs\gw$GatewayPort.out.log 2>&1')"
$remote += "[IO.File]::WriteAllLines('C:\yunshudu\app\scripts\gw$GatewayPort.cmd', `$l, (New-Object System.Text.UTF8Encoding(`$false)))"
$remote += "(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c C:\yunshudu\app\scripts\gw$GatewayPort.cmd'}).ProcessId"
$remote += "Start-Sleep -Seconds 3"
$remote += "try { `$c=New-Object System.Net.Sockets.TcpClient; `$c.Connect('127.0.0.1',$GatewayPort); 'listen=True'; `$c.Close() } catch { 'listen=False ' + `$_.Exception.Message }"
$remote += "try { if (-not (Get-NetFirewallRule -DisplayName 'ysd-gw-$GatewayPort' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'ysd-gw-$GatewayPort' -Direction Inbound -Protocol TCP -LocalPort $GatewayPort -Action Allow | Out-Null; 'fw=added' } else { 'fw=exists' } } catch { 'fw_err=' + `$_.Exception.Message }"
$remote += "try { Get-Content 'C:\yunshudu\logs\gw$GatewayPort.out.log' -Tail 3 } catch { 'no log' }"
$outDir = Join-Path (Split-Path -Parent $repo) "_ops"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$outFile = Join-Path $outDir "gw-deploy-$GatewayPort.ps1"
$body = ($remote -join $NL) + $NL
[IO.File]::WriteAllText($outFile, $body, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "已生成远端脚本: $outFile"
Write-Output "GW_TOKEN=$Token"
Write-Output "本机接入: `$env:GW_REMOTE='<VPS_IP>:$GatewayPort'; `$env:GW_TOKEN='$Token'; node scripts/ysd-gw-client.js   # 然后 curl -x socks5h://127.0.0.1:$LocalPort http://ip-api.com/json"
Write-Output "防火墙规则名: ysd-gw-$GatewayPort（远端已自动添加）"
if ($GenerateOnly -or -not $RemoteHost) {
  Write-Output "（未指定 -RemoteHost，仅生成脚本；把它拷到 VPS 上 powershell -File 执行即可）"
  return
}
$sec = ConvertTo-SecureString $Pass -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($User, $sec)
Write-Output "WinRM 部署到 $RemoteHost …"
Invoke-Command -ComputerName $RemoteHost -Credential $cred -ScriptBlock ([scriptblock]::Create($body))