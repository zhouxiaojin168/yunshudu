<#
  poke-deploy.ps1 -- 本地「戳」服务器立刻执行部署任务，并等待部署到指定 commit
    凭据从 %USERPROFILE%\.yunshudu\srv-225.json 读取（{host,user,pass}），不进仓库
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File deploy\poke-deploy.ps1 -ExpectSha <sha>
#>
param(
  [Parameter(Mandatory = $true)][string]$ExpectSha,
  [string]$CredFile = (Join-Path $env:USERPROFILE '.yunshudu\srv-225.json'),
  [int]$TimeoutSec = 240
)
$ErrorActionPreference = 'Continue'
if (-not (Test-Path $CredFile)) { Write-Output ('POKE_SKIP no cred file: ' + $CredFile); exit 0 }
$j = Get-Content -LiteralPath $CredFile -Raw -Encoding UTF8 | ConvertFrom-Json
$sec = ConvertTo-SecureString $j.pass -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($j.user, $sec)
$opt = @{ ComputerName = $j.host; Authentication = 'Basic'; Credential = $cred; ErrorAction = 'Stop' }

$svc = Get-Service WinRM -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') { Start-Service WinRM -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }

try {
  Invoke-Command @opt -ScriptBlock { Start-ScheduledTask -TaskName 'yunshudu-deploy' } | Out-Null
  Write-Output 'POKE_SENT'
} catch {
  Write-Output ('POKE_FAIL ' + $_.Exception.Message)
  exit 1
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$last = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 6
  try {
    $last = (Invoke-Command @opt -ScriptBlock { (Get-Content -LiteralPath 'C:\yunshudu\state\deployed-sha.txt' -Raw -ErrorAction SilentlyContinue) }).Trim()
  } catch { }
  if ($last -eq $ExpectSha) { Write-Output ('DEPLOY_OK ' + $last); exit 0 }
}
Write-Output ('DEPLOY_TIMEOUT expect=' + $ExpectSha + ' last=' + $last)
exit 2
