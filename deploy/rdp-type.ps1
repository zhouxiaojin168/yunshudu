<#
  rdp-type.ps1 -- 抢焦点 -> 可选 Win+R -> 清空 -> 键入文本 -> 可选回车 -> 截图
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File C:\rdpshare\rdp-type.ps1 -Text '\\tsclient\C\rdpshare\b2.cmd' -WinR -SelectAll -Enter -Tag boot -Shot
#>
param(
  [Parameter(Mandatory=$true)][string]$Text,
  [switch]$WinR,
  [switch]$SelectAll,
  [switch]$Enter,
  [int]$AfterMs = 2500,
  [string]$Tag = 'type',
  [switch]$Shot,
  [switch]$UseClipboard,
  [int]$KeyDelayMs = 30
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace PT -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
function WTitle([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][PT.U]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
$h = $p.MainWindowHandle
$tries = 0; $got = $false
while ($tries -lt 10 -and -not $got) {
  $tries++
  [void][PT.U]::ShowWindow($h, 9)
  [void][PT.U]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0043)
  [void][PT.U]::BringWindowToTop($h)
  $fg = [PT.U]::GetForegroundWindow()
  $fpid = [uint32]0
  $ft = [PT.U]::GetWindowThreadProcessId($fg, [ref]$fpid)
  $ct = [PT.U]::GetCurrentThreadId()
  [void][PT.U]::AttachThreadInput($ct, $ft, $true)
  [void][PT.U]::SwitchToThisWindow($h, $true)
  [void][PT.U]::SetForegroundWindow($h)
  [void][PT.U]::AttachThreadInput($ct, $ft, $false)
  [void][PT.U]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0043)
  Start-Sleep -Milliseconds 300
  if ([PT.U]::GetForegroundWindow() -eq $h) { $got = $true; break }
  Write-Host ('  focus try ' + $tries + ' -> fg=' + (WTitle ([PT.U]::GetForegroundWindow())))
}
Write-Host ('focus tries=' + $tries + ' got=' + $got)
if (-not $got) { Write-Host '!! no focus, abort'; exit 2 }
Start-Sleep -Milliseconds 400
$EXT = 0x0001; $UP = 0x0002
function DK([int]$vk,[int]$sc,[int]$ex) { [PT.U]::keybd_event([byte]$vk, [byte]$sc, [uint32]$ex, [UIntPtr]::Zero) }
function UK([int]$vk,[int]$sc,[int]$ex) { [PT.U]::keybd_event([byte]$vk, [byte]$sc, [uint32]($ex -bor $UP), [UIntPtr]::Zero) }
function Tap([int]$vk,[int]$sc,[int]$ex) { DK $vk $sc $ex; Start-Sleep -Milliseconds 60; UK $vk $sc $ex }
function Combo2([int]$m,[int]$ms,[int]$v,[int]$vs) { DK $m $ms 0; Start-Sleep -Milliseconds 60; Tap $v $vs 0; UK $m $ms 0 }
if ($WinR) {
  DK 0x5B 0x5B $EXT; Start-Sleep -Milliseconds 130
  Tap 0x52 0x13 0
  UK 0x5B 0x5B $EXT
  Write-Host 'sent Win+R'
  Start-Sleep -Milliseconds 1500
}
if ($SelectAll) { Combo2 0x11 0x1D 0x41 0x1E; Write-Host 'sent Ctrl+A'; Start-Sleep -Milliseconds 500 }
if ($UseClipboard) {
  Set-Clipboard -Value $Text
  Start-Sleep -Milliseconds 900
  Combo2 0x11 0x1D 0x56 0x2F
  Write-Host ('sent Ctrl+V: ' + $Text)
} else {
  foreach ($ch in $Text.ToCharArray()) {
    [System.Windows.Forms.SendKeys]::SendWait([string]$ch)
    Start-Sleep -Milliseconds $KeyDelayMs
  }
  Write-Host ('typed ' + $Text.Length + ' chars: ' + $Text)
}
Start-Sleep -Milliseconds 700
if ($Enter) { Tap 0x0D 0x1C 0; Write-Host 'sent ENTER' }
Start-Sleep -Milliseconds $AfterMs
if ($Shot) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $f = 'C:\rdpshare\tp-' + $Tag + '.png'
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('shot -> ' + $f)
}
