<#
  push.ps1 -- 本地改动一键进链路：commit -> push GitHub -> 服务器自动部署
  为什么单独写一个：GCM 交互式凭据在本机会挂住；这里直接用 %USERPROFILE%\.yunshudu\gh-token.txt + 机场代理推
  用法:
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\push.ps1 -Message "R1170: xxx"
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\push.ps1 -Message "msg" -WaitDeploy
#>
param(
  [Parameter(Mandatory=$true)][string]$Message,
  [string]$Proxy = 'http://127.0.0.1:10090',
  [string]$TokenFile = (Join-Path $env:USERPROFILE '.yunshudu\gh-token.txt'),
  [switch]$WaitDeploy
)
$ErrorActionPreference = 'Stop'
$GIT = 'E:\git\Git\cmd\git.exe'
if (-not (Test-Path $GIT)) { $GIT = 'git' }
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path $TokenFile)) { throw "没找到 token 文件: $TokenFile" }
$tok = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$remote = (& $GIT remote get-url origin).Trim()
$m = [regex]::Match($remote, 'github\.com[/:]([^/]+)/([^/\.]+)')
if (-not $m.Success) { throw "remote 不是 github: $remote" }
$user = $m.Groups[1].Value; $name = $m.Groups[2].Value

& $GIT add -A
& $GIT -c core.safecrlf=false -c user.name='zxj' -c user.email='zxj@local' commit -m $Message
$sha = (& $GIT rev-parse HEAD).Trim()
Write-Host "commit = $sha"

$env:GIT_TERMINAL_PROMPT = '0'
& $GIT -c credential.helper= -c "http.proxy=$Proxy" -c http.version=HTTP/1.1 push "https://${user}:${tok}@github.com/${user}/${name}.git" HEAD:main
Write-Host "push done"
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'git-credential|git-remote|^git$' } | Stop-Process -Force -ErrorAction SilentlyContinue

if ($WaitDeploy) {
  $credFile = Join-Path $env:USERPROFILE '.yunshudu\srv-225.json'
  if (Test-Path $credFile) {
    $j = Get-Content -LiteralPath $credFile -Raw | ConvertFrom-Json
    $sec = ConvertTo-SecureString $j.pass -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($j.user, $sec)
    $opt = @{ ComputerName = $j.host; Authentication = 'Basic'; Credential = $cred; SessionOption = (New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck) }
    Invoke-Command @opt { Start-ScheduledTask -TaskName 'yunshudu-deploy' } | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 6
      $cur = (Invoke-Command @opt { (Get-Content C:\yunshudu\state\deployed-sha.txt -Raw -ErrorAction SilentlyContinue) }).Trim()
      if ($cur -eq $sha) { Write-Host "DEPLOY_OK $sha"; exit 0 }
    }
    Write-Host "DEPLOY_TIMEOUT expect=$sha last=$cur"
  }
}