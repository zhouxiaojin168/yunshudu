<#
  local-rdp.ps1 -- 本机侧 RDP 助手（准备共享目录 / 生成 .rdp / 拉起 mstsc / 截图 / 发按键）
    用法（本机 PowerShell）：
      powershell -NoProfile -ExecutionPolicy Bypass -File .\local-rdp.ps1 -Action prep -Password <pw>
      powershell ... -Action launch -Password <pw> -Wait 25
      powershell ... -Action shot
      powershell ... -Action keys -Keys "^({ESC})"
  共享目录 C:\rdpshare 通过 RDP 驱动器重定向在会话里可见：\\tsclient\C\rdpshare\
#>
param(
  [ValidateSet('prep','launch','shot','keys')][string]$Action = 'prep',
  [string]$Password = '',
  [string]$Keys = '',
  [int]$Wait = 0,
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
$Ip = '114.66.16.225'
$User = 'administrator'
$Share = 'C:\rdpshare'
$RepoDeploy = $PSScriptRoot
$NL = [Environment]::NewLine

function Shot([string]$path) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('shot -> ' + $path)
}

if ($Action -eq 'prep') {
  New-Item -ItemType Directory -Force -Path $Share | Out-Null
  Copy-Item -Path (Join-Path $RepoDeploy 'win-bootstrap.ps1') -Destination $Share -Force
  if (Test-Path (Join-Path $RepoDeploy 'remote-deploy.ps1')) { Copy-Item -Path (Join-Path $RepoDeploy 'remote-deploy.ps1') -Destination $Share -Force }
  $cmd = @'
@echo off
chcp 65001 >nul
echo === win-bootstrap.ps1 start ===
powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\C\rdpshare\win-bootstrap.ps1"
echo.
echo === bootstrap.log ===
type C:\yunshudu\bootstrap.log
echo.
echo === finished (exit=%errorlevel%) ===
pause
'@
  [IO.File]::WriteAllText((Join-Path $Share 'b.cmd'), $cmd, (New-Object System.Text.UTF8Encoding($true)))
  Get-ChildItem $Share | Select-Object Length, Name | Format-Table -AutoSize
}

if ($Action -eq 'launch') {
  if ($Password) {
    & cmdkey.exe /generic:"TERMSRV/$Ip" /user:$User /pass:$Password | Out-Null
    Write-Host 'cmdkey stored'
  }
  $lines = @(
    ('full address:s:' + $Ip),
    ('username:s:' + $User),
    'authentication level:i:0',
    'prompt for credentials:i:0',
    'promptcredentialonce:i:0',
    'enablecredsspsupport:i:1',
    'screen mode id:i:1',
    'desktopwidth:i:1280',
    'desktopheight:i:800',
    'session bpp:i:32',
    'redirectclipboard:i:1',
    'redirectprinters:i:0',
    'redirectcomports:i:0',
    'drivestoredirect:s:C:\',
    'audiomode:i:2',
    'keyboardhook:i:2',
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'compression:i:1',
    'disable wallpaper:i:1',
    'allow font smoothing:i:0',
    'allow desktop composition:i:0',
    'autoreconnection enabled:i:1'
  )
  $rdp = ($lines -join $NL) + $NL
  New-Item -ItemType Directory -Force -Path $Share | Out-Null
  $rdpFile = Join-Path $Share 'srv.rdp'
  [IO.File]::WriteAllText($rdpFile, $rdp, (New-Object System.Text.UTF8Encoding($false)))
  Start-Process -FilePath 'mstsc.exe' -ArgumentList ('"' + $rdpFile + '"')
  Write-Host ('mstsc launched with ' + $rdpFile)
  if ($Wait -gt 0) { Start-Sleep -Seconds $Wait; Shot ($Share + '\shot-after-' + $Wait + 's.png') }
}

if ($Action -eq 'shot') {
  if (-not $OutFile) { $OutFile = $Share + '\shot-' + (Get-Date -Format 'HHmmss') + '.png' }
  Shot $OutFile
}

if ($Action -eq 'keys') {
  Add-Type -AssemblyName System.Windows.Forms
  $wsh = New-Object -ComObject WScript.Shell
  $ok = $wsh.AppActivate($Ip)
  Write-Host ('AppActivate(' + $Ip + ') = ' + $ok)
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Write-Host ('sent keys: ' + $Keys)
}
