<#
  rdp-key.ps1 -- 带【扫描码】的按键注入（mstsc 只认扫描码，纯 VK 会被吞）+ 硬抢焦点重试
    powershell -NoProfile -ExecutionPolicy Bypass -File .\rdp-key.ps1 -Combo winr -Shot
    Combo: winr / tm / esc / enter / ctrlv / ctrla / paste(先设剪贴板再直贴)
#>
param(
  [Parameter(Mandatory=$true)][string]$Combo,
  [int]$HoldMs = 90,
  [int]$AfterMs = 1500,
  [string]$ClipText = '',
  [switch]$Shot
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace K -Name In -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
'@
function Title([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][K.In]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
$EXT = 0x0001; $UP = 0x0002
function Down([int]$vk, [int]$sc, [int]$ext) { [K.In]::keybd_event([byte]$vk, [byte]$sc, [uint32]$ext, [UIntPtr]::Zero) }
function Up([int]$vk, [int]$sc, [int]$ext) { [K.In]::keybd_event([byte]$vk, [byte]$sc, [uint32]($ext -bor $UP), [UIntPtr]::Zero) }
function Tap([int]$vk, [int]$sc, [int]$ext) { Down $vk $sc $ext; Start-Sleep -Milliseconds 60; Up $vk $sc $ext }

# 0) 清掉本机残留的『运行』框（它会持续抢前台）
$wshC = New-Object -ComObject WScript.Shell
for ($c = 0; $c -lt 2; $c++) { if ($wshC.AppActivate('运行')) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 350 } else { break } }

$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
$h = $p.MainWindowHandle
Write-Host ('mstsc pid=' + $p.Id + ' title=' + (Title $h))

$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
$SWP = 0x0001 -bor 0x0002 -bor 0x0040
$tries = 0; $got = $false
while ($tries -lt 8 -and -not $got) {
  $tries++
  [void][K.In]::ShowWindow($h, 9)
  [void][K.In]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP)
  [void][K.In]::BringWindowToTop($h)
  $fgp = [uint32]0
  $ft = [K.In]::GetWindowThreadProcessId([K.In]::GetForegroundWindow(), [ref]$fgp)
  $ct = [K.In]::GetCurrentThreadId()
  [void][K.In]::AttachThreadInput($ct, $ft, $true)
  [void][K.In]::SwitchToThisWindow($h, $true)
  [void][K.In]::SetForegroundWindow($h)
  [void][K.In]::AttachThreadInput($ct, $ft, $false)
  [void][K.In]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP)
  Start-Sleep -Milliseconds 300
  $fgNow = [K.In]::GetForegroundWindow()
  if ($fgNow -eq $h) { $got = $true; break }
  if ($tries -ge 3 -and $fgNow -ne [IntPtr]::Zero) {
    $cls = New-Object System.Text.StringBuilder 256
    [void][K.In]::GetClassNameW($fgNow, $cls, 256)
    Write-Host ("  blocker: hwnd=" + $fgNow + " class=" + $cls.ToString() + " title=" + (Title $fgNow))
    [void][K.In]::ShowWindow($fgNow, 6)
    Start-Sleep -Milliseconds 250
  }
}
Write-Host ('  focus tries=' + $tries + '  got=' + $got + '  fgNow=' + (Title ([K.In]::GetForegroundWindow())))
if (-not $got) { Write-Host '  !! 没抢到焦点，终止（避免误伤本机）'; exit 2 }
Start-Sleep -Milliseconds 400

if ($ClipText -ne '') { Set-Clipboard -Value $ClipText; Start-Sleep -Milliseconds 800; Write-Host ('  clipboard set: ' + $ClipText) }

switch ($Combo.ToLower()) {
  'winr' {
    Down 0x5B 0x5B $EXT; Start-Sleep -Milliseconds $HoldMs
    Down 0x52 0x13 0; Start-Sleep -Milliseconds $HoldMs
    Up 0x52 0x13 0
    Up 0x5B 0x5B $EXT
    Write-Host '  sent Win+R (scancode)'
  }
  'tm' {
    Down 0x11 0x1D 0; Start-Sleep -Milliseconds $HoldMs
    Down 0x10 0x2A 0; Start-Sleep -Milliseconds $HoldMs
    Down 0x1B 0x01 0; Start-Sleep -Milliseconds $HoldMs
    Up 0x1B 0x01 0; Start-Sleep -Milliseconds 60
    Up 0x10 0x2A 0; Start-Sleep -Milliseconds 60
    Up 0x11 0x1D 0
    Write-Host '  sent Ctrl+Shift+Esc (scancode)'
  }
  'esc' { Tap 0x1B 0x01 0; Write-Host '  sent ESC' }
  'enter' { Tap 0x0D 0x1C 0; Write-Host '  sent ENTER' }
  'ctrlv' { Down 0x11 0x1D 0; Tap 0x56 0x2F 0; Up 0x11 0x1D 0; Write-Host '  sent Ctrl+V' }
  'ctrlshiftenter' {
    Down 0x11 0x1D 0; Down 0x10 0x2A 0; Tap 0x0D 0x1C 0
    Up 0x10 0x2A 0; Up 0x11 0x1D 0
    Write-Host '  sent Ctrl+Shift+Enter'
  }
  default { Write-Host ('unknown combo: ' + $Combo); exit 3 }
}
Start-Sleep -Milliseconds $AfterMs
if ($Shot) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $f = 'C:\rdpshare\key-' + $Combo + '.png'
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('  shot -> ' + $f)
}
