<#
  git-push.ps1 -- 经机场出口推 GitHub（本机直连已劣化：直连 https://github.com ~15s，走机场 ~0.6s）
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\git-push.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\git-push.ps1 -Message "R163: xxx"
  说明：
    - 默认走 http.proxy=http://127.0.0.1:17899（bridge-manager 起的机场桥）
    - 卡住时先清理残留进程： Get-Process git,git-remote-https | Stop-Process -Force
    - 真实远端状态用 ls-remote 判，别只看本地 origin/main（超时中断的 push 可能已在后台推完）
#>
param(
  [string]$Proxy = 'http://127.0.0.1:17899',
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [string]$Message = '',
  [switch]$NoPush
)
$ErrorActionPreference = 'Continue'
$GIT = 'E:\git\Git\cmd\git.exe'
if (-not (Test-Path $GIT)) { $GIT = 'git' }
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if ($Message) {
  & $GIT add -A
  & $GIT -c user.name='wangzha' -c user.email='wangzha@local' commit -m $Message
}
if (-not $NoPush) {
  Write-Host "==> push via $Proxy"
  & $GIT -c "http.proxy=$Proxy" -c http.version=HTTP/1.1 push $Remote $Branch
}
Write-Host "==> 远端真实状态："
& $GIT -c "http.proxy=$Proxy" ls-remote $Remote $Branch