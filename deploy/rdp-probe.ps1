<#
  rdp-probe.ps1 -- 探针: 抢焦点 -> 发按键 -> 报告本机『运行』框 -> 截图
  用法: powershell -NoProfile -ExecutionPolicy Bypass -File C:\rdpshare\rdp-probe.ps1 -Combo winr -Tag p1
#>
param(
  [ValidateSet('winr','enter','esc','ctrlv','tm','none')][string]$Combo = 'winr',
  [string]$ClipText = '',
  [int]$AfterMs = 2500,
  [string]$Tag = 'probe',
  [switch]$KillLocalRun
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace PB -Name U -MemberDefinition @'
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
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
'@
function WTitle([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][PB.U]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
function WClass([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][PB.U]::GetClassNameW($h, $sb, 512); return $sb.ToString() }
function LocalRunList { $r = @(); foreach ($q in (Get-Process -ErrorAction SilentlyContinue)) { if ($q.MainWindowTitle -ne '' -and ($q.MainWindowTitle -match '运行' -or $q.MainWindowTitle -match '^Run')) { $r += ('' + $q.Id + ':' + $q.ProcessName + ':' + $q.MainWindowTitle) } }; return $r }
Write-Host ('== rdp-probe combo=' + $Combo + ' tag=' + $Tag + ' ==')
Write-Host ('local Run-like BEFORE: ' + ((LocalRunList) -join ' | '))
if ($KillLocalRun) {
  $wsh = New-Object -ComObject WScript.Shell
  for ($i = 0; $i -lt 3; $i++) { if ($wsh.AppActivate('运行')) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 400; Write-Host ('  closed local Run on try ' + $i) } else { break } }
  Start-Sleep -Milliseconds 300
}
$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
$h = $p.MainWindowHandle
Write-Host ('mstsc pid=' + $p.Id + ' hwnd=' + $h + ' title=' + (WTitle $h) + ' class=' + (WClass $h))
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2); $SWP = 0x0001 -bor 0x0002 -bor 0x0040
$tries = 0; $got = $false
while ($tries -lt 10 -and -not $got) {
  $tries++
  [void][PB.U]::ShowWindow($h, 3)
  [void][PB.U]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP)
  [void][PB.U]::BringWindowToTop($h)
  $fg = [PB.U]::GetForegroundWindow()
  $fpid = [uint32]0
  $ft = [PB.U]::GetWindowThreadProcessId($fg, [ref]$fpid)
  $ct = [PB.U]::GetCurrentThreadId()
  [void][PB.U]::AttachThreadInput($ct, $ft, $true)
  [void][PB.U]::SwitchToThisWindow($h, $true)
  [void][PB.U]::SetForegroundWindow($h)
  [void][PB.U]::AttachThreadInput($ct, $ft, $false)
  [void][PB.U]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP)
  Start-Sleep -Milliseconds 300
  if ([PB.U]::GetForegroundWindow() -eq $h) { $got = $true; break }
  Write-Host ('  focus try ' + $tries + ' -> fg=' + (WTitle ([PB.U]::GetForegroundWindow())))
}
Write-Host ('  focus tries=' + $tries + ' got=' + $got)
if (-not $got) { Write-Host '!! no focus, abort'; exit 2 }
Start-Sleep -Milliseconds 500
if ($ClipText -ne '') { Set-Clipboard -Value $ClipText; Start-Sleep -Milliseconds 900; Write-Host ('  clip=' + $ClipText) }
$EXT = 0x0001; $UP = 0x0002
function DK([int]$vk,[int]$sc,[int]$ex) { [PB.U]::keybd_event([byte]$vk, [byte]$sc, [uint32]$ex, [UIntPtr]::Zero) }
function UK([int]$vk,[int]$sc,[int]$ex) { [PB.U]::keybd_event([byte]$vk, [byte]$sc, [uint32]($ex -bor $UP), [UIntPtr]::Zero) }
function Tap([int]$vk,[int]$sc,[int]$ex) { DK $vk $sc $ex; Start-Sleep -Milliseconds 70; UK $vk $sc $ex }
switch ($Combo.ToLower()) {
  'winr' { DK 0x5B 0x5B $EXT; Start-Sleep -Milliseconds 120; Tap 0x52 0x13 0; UK 0x5B 0x5B $EXT; Write-Host '  sent Win+R' }
  'tm' { DK 0x11 0x1D 0; Start-Sleep -Milliseconds 80; DK 0x10 0x2A 0; Start-Sleep -Milliseconds 80; Tap 0x1B 0x01 0; UK 0x10 0x2A 0; UK 0x11 0x1D 0; Write-Host '  sent Ctrl+Shift+Esc' }
  'esc' { Tap 0x1B 0x01 0; Write-Host '  sent ESC' }
  'enter' { Tap 0x0D 0x1C 0; Write-Host '  sent ENTER' }
  'ctrlv' { DK 0x11 0x1D 0; Tap 0x56 0x2F 0; UK 0x11 0x1D 0; Write-Host '  sent Ctrl+V' }
  'none' { Write-Host '  no key' }
}
Start-Sleep -Milliseconds $AfterMs
Write-Host ('local Run-like AFTER: ' + ((LocalRunList) -join ' | '))
Write-Host ('foreground now = ' + (WTitle ([PB.U]::GetForegroundWindow())))
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$f = 'C:\rdpshare\probe-' + $Tag + '.png'
$bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ('  shot -> ' + $f)
