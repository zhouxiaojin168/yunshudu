<# 量 mstsc 窗口真实坐标 + 关本机运行框 + 双击远端图标 #>
param([int]$ClickX = -1, [int]$ClickY = -1, [switch]$CloseRun, [switch]$Shot, [string]$ShotName='g')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace G -Name In -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref System.Drawing.Point p);
public struct RECT { public int Left, Top, Right, Bottom; }
'@
if ($CloseRun) { $w = New-Object -ComObject WScript.Shell; while ($w.AppActivate('运行')) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 300 } ; Write-Host 'run dialog closed' }
$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
$r = New-Object G.In+RECT
[void][G.In]::GetWindowRect($h, [ref]$r)
$cr = New-Object G.In+RECT
[void][G.In]::GetClientRect($h, [ref]$cr)
$pt = New-Object System.Drawing.Point 0,0
[void][G.In]::ClientToScreen($h, [ref]$pt)
Write-Host ('mstsc WindowRect = ' + $r.Left + ',' + $r.Top + ' -> ' + $r.Right + ',' + $r.Bottom + '   size=' + ($r.Right-$r.Left) + 'x' + ($r.Bottom-$r.Top))
Write-Host ('mstsc ClientRect = ' + $cr.Right + 'x' + $cr.Bottom + '   client origin on screen = ' + $pt.X + ',' + $pt.Y)
if ($ClickX -ge 0) {
  [void][G.In]::SetCursorPos($ClickX, $ClickY); Start-Sleep -Milliseconds 250
  for ($i = 0; $i -lt 2; $i++) { [G.In]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [G.In]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 160 }
  Write-Host ('double-clicked screen ' + $ClickX + ',' + $ClickY)
  Start-Sleep -Milliseconds 2000
}
if ($Shot) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save(('C:\rdpshare\' + $ShotName + '.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $gg.Dispose(); $bmp.Dispose()
  Write-Host ('shot -> C:\rdpshare\' + $ShotName + '.png')
}
