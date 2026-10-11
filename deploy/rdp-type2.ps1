<#
  rdp-type2.ps1 -- 用【扫描码】逐字敲键盘（SendKeys 的 Unicode 事件 mstsc 不转发，必须走扫描码）
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File C:\rdpshare\rdp-type2.ps1 -Text 'whoami' -Enter -Shot -Tag t1
#>
param(
  [Parameter(Mandatory=$true)][string]$Text,
  [switch]$Enter,
  [switch]$ShiftFirst,
  [switch]$CtrlSpaceFirst,
  [int]$KeyDelayMs = 45,
  [int]$AfterMs = 2500,
  [string]$Tag = 't2',
  [switch]$Shot,
  [int]$Backspaces = 0
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace P2 -Name U -MemberDefinition @'
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
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string win);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
function WTitle([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][P2.U]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
$h = [P2.U]::FindWindowW('TscShellContainerClass', $null)
if ($h -eq [IntPtr]::Zero) {
  $mstscP = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
  if (-not $mstscP) { Write-Host 'NO mstsc'; exit 1 }
  $h = $mstscP.MainWindowHandle
}
$mspid = [uint32]0
[void][P2.U]::GetWindowThreadProcessId($h, [ref]$mspid)
$p = New-Object psobject -Property @{ Id = $mspid }
$tries = 0; $got = $false
while ($tries -lt 10 -and -not $got) {
  $tries++
  [void][P2.U]::ShowWindow($h, 3)
  [void][P2.U]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0043)
  [void][P2.U]::BringWindowToTop($h)
  $fg = [P2.U]::GetForegroundWindow()
  $fpid = [uint32]0
  $ft = [P2.U]::GetWindowThreadProcessId($fg, [ref]$fpid)
  $ct = [P2.U]::GetCurrentThreadId()
  [void][P2.U]::AttachThreadInput($ct, $ft, $true)
  [void][P2.U]::SwitchToThisWindow($h, $true)
  [void][P2.U]::SetForegroundWindow($h)
  [void][P2.U]::AttachThreadInput($ct, $ft, $false)
  [void][P2.U]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0043)
  Start-Sleep -Milliseconds 300
  if ([P2.U]::GetForegroundWindow() -eq $h) { $got = $true; break }
}
Write-Host ('focus tries=' + $tries + ' got=' + $got)
if (-not $got) { Write-Host '!!! no focus, abort'; exit 2 }
Start-Sleep -Milliseconds 400
$EXT = 0x0001; $UP = 0x0002
function DK([int]$vk,[int]$sc,[int]$ex) { [P2.U]::keybd_event([byte]$vk, [byte]$sc, [uint32]$ex, [UIntPtr]::Zero) }
function UK([int]$vk,[int]$sc,[int]$ex) { [P2.U]::keybd_event([byte]$vk, [byte]$sc, [uint32]($ex -bor $UP), [UIntPtr]::Zero) }
function Tap([int]$vk,[int]$sc,[int]$ex) { DK $vk $sc $ex; Start-Sleep -Milliseconds 60; UK $vk $sc $ex }
if ($ShiftFirst) { Tap 0x10 0x2A 0; Write-Host 'sent SHIFT'; Start-Sleep -Milliseconds 700 }
if ($CtrlSpaceFirst) { DK 0x11 0x1D 0; Start-Sleep -Milliseconds 70; Tap 0x20 0x39 0; UK 0x11 0x1D 0; Write-Host 'sent Ctrl+Space'; Start-Sleep -Milliseconds 700 }
$mapLo = @{}
$letters = 'qwertyuiopasdfghjklzxcvbnm'
$scans  = @(0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1E,0x1F,0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x2C,0x2D,0x2E,0x2F,0x30,0x31,0x32)
for ($i = 0; $i -lt 26; $i++) { $ch = $letters.Substring($i,1); $vk = 0x41 + ($letters.IndexOf($ch)); $mapLo[$ch] = @($vk, $scans[$i]) }
$mapSym = @{}
$mapSym['\'] = @(0xDC, 0x2B, 0)
$mapSym['.'] = @(0xBE, 0x34, 0)
$mapSym['-'] = @(0xBD, 0x0C, 0)
$mapSym['_'] = @(0xBD, 0x0C, 1)
$mapSym[':'] = @(0xBA, 0x27, 1)
$mapSym['/'] = @(0xBF, 0x35, 0)
$mapSym[' '] = @(0x20, 0x39, 0)
$mapSym['='] = @(0xBB, 0x0D, 0)
$mapSym[','] = @(0xBC, 0x33, 0)
$mapSym[';'] = @(0xBA, 0x27, 0)
$mapSym['+'] = @(0xBB, 0x0D, 1)
$mapSym['!'] = @(0x31, 0x02, 1)
$dscan = @(0x0B,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A)
for ($d = 0; $d -lt 10; $d++) { $mapSym[[string]$d] = @((0x30 + $d), $dscan[$d], 0) }
for ($b = 0; $b -lt $Backspaces; $b++) { Tap 0x08 0x0E 0; Start-Sleep -Milliseconds 60 }
$n = 0
foreach ($ch in $Text.ToCharArray()) {
  $c = [string]$ch
  $vk = 0; $sc = 0; $sh = 0; $ok = $false
  $low = $c.ToLower()
  if ($mapLo.ContainsKey($low)) { $vk = $mapLo[$low][0]; $sc = $mapLo[$low][1]; if ($c -cmatch '[A-Z]') { $sh = 1 }; $ok = $true }
  elseif ($mapSym.ContainsKey($c)) { $vk = $mapSym[$c][0]; $sc = $mapSym[$c][1]; $sh = $mapSym[$c][2]; $ok = $true }
  if (-not $ok) { Write-Host ('  !! unmapped char [' + $c + '] code=' + [int]$ch); continue }
  if ($sh) { DK 0x10 0x2A 0; Start-Sleep -Milliseconds 45 }
  DK $vk $sc 0; Start-Sleep -Milliseconds 45
  UK $vk $sc 0
  if ($sh) { UK 0x10 0x2A 0; Start-Sleep -Milliseconds 45 }
  Start-Sleep -Milliseconds $KeyDelayMs
  $n++
}
Write-Host ('scan-typed ' + $n + ' chars: ' + $Text)
Start-Sleep -Milliseconds 600
if ($Enter) { Tap 0x0D 0x1C 0; Write-Host 'sent ENTER' }
Start-Sleep -Milliseconds $AfterMs
if ($Shot) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $f = 'C:\rdpshare\s2-' + $Tag + '.png'
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('shot -> ' + $f)
}
