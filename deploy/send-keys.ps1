<#
  send-keys.ps1 -- 把按键送进 mstsc 窗口（pid 优先 AppActivate，失败则 SetForegroundWindow，再失败先敲 Alt 解锁）
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\send-keys.ps1 -Keys "^({ESC})"
          powershell ... -File .\send-keys.ps1 -Keys "powershell{ENTER}" -DelayMs 1500
#>
param(
  [Parameter(Mandatory=$true)][string]$Keys,
  [int]$DelayMs = 600,
  [switch]$AltUnlock,
  [switch]$Shot,
  [string]$ShotPath = ''
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace N -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@
$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc window found'; exit 1 }
Write-Host ('target pid=' + $p.Id + '  title=' + $p.MainWindowTitle)
$wsh = New-Object -ComObject WScript.Shell
$ok = $wsh.AppActivate($p.Id)
Write-Host ('AppActivate(pid) = ' + $ok)
if (-not $ok) {
  [void][N.U]::ShowWindow($p.MainWindowHandle, 9)
  $ok = [N.U]::SetForegroundWindow($p.MainWindowHandle)
  Write-Host ('SetForegroundWindow = ' + $ok)
}
if ($AltUnlock) { [System.Windows.Forms.SendKeys]::SendWait('%'); Start-Sleep -Milliseconds 250 }
Start-Sleep -Milliseconds $DelayMs
[System.Windows.Forms.SendKeys]::SendWait($Keys)
Write-Host ('SENT: ' + $Keys)
Start-Sleep -Milliseconds 800
if ($Shot) {
  if (-not $ShotPath) { $ShotPath = 'C:\rdpshare\shot.png' }
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('shot -> ' + $ShotPath)
}
