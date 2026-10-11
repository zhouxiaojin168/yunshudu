<#
  rdp-click-remote.ps1 -- 用「远端桌面坐标」点击 RDP 会话（自动换算 mstsc 客户区 -> 本机屏幕坐标）
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File C:\rdpshare\rdp-click-remote.ps1 -RX 3 -RY 797 -Click right -Shot -ShotName s1
          powershell ... -ProbeOnly
    注: mstsc 客户区可能被「智能缩放」，脚本按 客户区尺寸 / 远端分辨率 自动换算。
#>
param(
  [int]$RX = 0,
  [int]$RY = 0,
  [ValidateSet('single','dbl','right','none')][string]$Click = 'single',
  [int]$AfterMs = 1500,
  [switch]$Shot,
  [switch]$ProbeOnly,
  [string]$ShotName = 'rc',
  [int]$SrcW = 1280,
  [int]$SrcH = 800,
  [switch]$FocusMstsc,
  [switch]$Maximize
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace PC -Name U -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string win);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
function WTitle([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][PC.U]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
$h = [PC.U]::FindWindowW('TscShellContainerClass', $null)
if ($h -eq [IntPtr]::Zero) {
  $mstscP = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
  if (-not $mstscP) { Write-Host 'NO mstsc'; exit 1 }
  $h = $mstscP.MainWindowHandle
}
$mspid = [uint32]0
[void][PC.U]::GetWindowThreadProcessId($h, [ref]$mspid)
$p = New-Object psobject -Property @{ Id = $mspid }
$wr = New-Object PC.U+RECT
[void][PC.U]::GetWindowRect($h, [ref]$wr)
$cr = New-Object PC.U+RECT
[void][PC.U]::GetClientRect($h, [ref]$cr)
$pt = New-Object PC.U+POINT; $pt.x = 0; $pt.y = 0
[void][PC.U]::ClientToScreen($h, [ref]$pt)
$cw = $cr.Right - $cr.Left
$ch = $cr.Bottom - $cr.Top
$sx0 = $pt.x
$sy0 = $pt.y
Write-Host ('mstsc pid=' + $p.Id + ' hwnd=' + $h + ' title=' + (WTitle $h))
Write-Host ('windowRect  = ' + $wr.Left + ',' + $wr.Top + ' ' + ($wr.Right - $wr.Left) + 'x' + ($wr.Bottom - $wr.Top))
Write-Host ('clientSize  = ' + $cw + 'x' + $ch + '  at screen ' + $sx0 + ',' + $sy0)
Write-Host ('implied scale = ' + [math]::Round($cw / [double]$SrcW, 4) + ' x ' + [math]::Round($ch / [double]$SrcH, 4) + '   (远端假定 ' + $SrcW + 'x' + $SrcH + ')')
$tx = $sx0 + [int][math]::Round(([double]$RX) * $cw / $SrcW)
$ty = $sy0 + [int][math]::Round(([double]$RY) * $ch / $SrcH)
Write-Host ('remote (' + $RX + ',' + $RY + ') -> screen (' + $tx + ',' + $ty + ')')
if ($Maximize) {
  [void][PC.U]::ShowWindow($h, 3)
  Start-Sleep -Milliseconds 1200
  $wr = New-Object PC.U+RECT
  [void][PC.U]::GetWindowRect($h, [ref]$wr)
  $cr = New-Object PC.U+RECT
  [void][PC.U]::GetClientRect($h, [ref]$cr)
  $pt = New-Object PC.U+POINT; $pt.x = 0; $pt.y = 0
  [void][PC.U]::ClientToScreen($h, [ref]$pt)
  $cw = $cr.Right - $cr.Left
  $ch = $cr.Bottom - $cr.Top
  $sx0 = $pt.x
  $sy0 = $pt.y
  Write-Host ('AFTER MAX: windowRect = ' + $wr.Left + ',' + $wr.Top + ' ' + ($wr.Right - $wr.Left) + 'x' + ($wr.Bottom - $wr.Top))
  Write-Host ('AFTER MAX: clientSize = ' + $cw + 'x' + $ch + ' at screen ' + $sx0 + ',' + $sy0)
  $tx = $sx0 + [int][math]::Round(([double]$RX) * $cw / $SrcW)
  $ty = $sy0 + [int][math]::Round(([double]$RY) * $ch / $SrcH)
  Write-Host ('remote (' + $RX + ',' + $RY + ') -> screen (' + $tx + ',' + $ty + ')')
}
if ($ProbeOnly) { exit 0 }
if ($FocusMstsc) {
  [void][PC.U]::ShowWindow($h, 3)
  [void][PC.U]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)
  [void][PC.U]::BringWindowToTop($h)
  $fg = [PC.U]::GetForegroundWindow()
  $fpid = [uint32]0
  $ft = [PC.U]::GetWindowThreadProcessId($fg, [ref]$fpid)
  $ct = [PC.U]::GetCurrentThreadId()
  [void][PC.U]::AttachThreadInput($ct, $ft, $true)
  [void][PC.U]::SwitchToThisWindow($h, $true)
  [void][PC.U]::SetForegroundWindow($h)
  [void][PC.U]::AttachThreadInput($ct, $ft, $false)
  [void][PC.U]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)
  Start-Sleep -Milliseconds 400
  Write-Host ('  fg=' + (WTitle ([PC.U]::GetForegroundWindow())))
}
[void][PC.U]::SetCursorPos($tx, $ty)
Start-Sleep -Milliseconds 350
$LD = 0x0002; $LU = 0x0004; $RD = 0x0008; $RU = 0x0010
if ($Click -eq 'single' -or $Click -eq 'dbl') {
  [PC.U]::mouse_event($LD, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
  [PC.U]::mouse_event($LU, 0, 0, 0, [UIntPtr]::Zero)
}
if ($Click -eq 'dbl') {
  Start-Sleep -Milliseconds 150
  [PC.U]::mouse_event($LD, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
  [PC.U]::mouse_event($LU, 0, 0, 0, [UIntPtr]::Zero)
}
if ($Click -eq 'right') {
  [PC.U]::mouse_event($RD, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
  [PC.U]::mouse_event($RU, 0, 0, 0, [UIntPtr]::Zero)
}
Write-Host ('  clicked ' + $Click + ' at screen ' + $tx + ',' + $ty)
Start-Sleep -Milliseconds $AfterMs
if ($Shot) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $f = 'C:\rdpshare\rc-' + $ShotName + '.png'
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('  shot -> ' + $f)
}
