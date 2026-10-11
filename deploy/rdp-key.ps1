<#
  rdp-key.ps1 -- 带【扫描码】的按键注入（mstsc 只认扫描码，纯 VK 会被吞）
    powershell -NoProfile -ExecutionPolicy Bypass -File .\rdp-key.ps1 -Combo winr
    支持: winr / tm(Ctrl+Shift+Esc) / esc / enter / ctrlv / ctrla
#>
param(
  [Parameter(Mandatory=$true)][string]$Combo,
  [int]$HoldMs = 90,
  [int]$AfterMs = 1500,
  [switch]$Shot
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace K -Name In -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
function Title([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][K.In]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
$EXT = 0x0001; $UP = 0x0002
function Down([int]$vk, [int]$sc, [int]$ext) { [K.In]::keybd_event([byte]$vk, [byte]$sc, [uint32]$ext, [UIntPtr]::Zero) }
function Up([int]$vk, [int]$sc, [int]$ext) { [K.In]::keybd_event([byte]$vk, [byte]$sc, [uint32]($ext -bor $UP), [UIntPtr]::Zero) }
function Tap([int]$vk, [int]$sc, [int]$ext) { Down $vk $sc $ext; Start-Sleep -Milliseconds 60; Up $vk $sc $ext }

$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
$h = $p.MainWindowHandle
Write-Host ('mstsc pid=' + $p.Id + ' title=' + (Title $h))
$wsh = New-Object -ComObject WScript.Shell
[void]$wsh.AppActivate($p.Id)
[void][K.In]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500
$fg = [K.In]::GetForegroundWindow()
Write-Host ('  foreground=' + (Title $fg) + '  isMstsc=' + ($fg -eq $h))
if ($fg -ne $h) { Write-Host '  !! 没抢到焦点，终止'; exit 2 }

switch ($Combo.ToLower()) {
  'winr' {
    Down 0x5B 0x5B $EXT; Start-Sleep -Milliseconds $HoldMs
    Down 0x52 0x13 0;     Start-Sleep -Milliseconds $HoldMs
    Up   0x52 0x13 0
    Up   0x5B 0x5B $EXT
    Write-Host '  sent Win+R (scancode)'
  }
  'tm' {
    Down 0x11 0x1D 0; Start-Sleep -Milliseconds $HoldMs
    Down 0x10 0x2A 0; Start-Sleep -Milliseconds $HoldMs
    Down 0x1B 0x01 0; Start-Sleep -Milliseconds $HoldMs
    Up   0x1B 0x01 0; Start-Sleep -Milliseconds 60
    Up   0x10 0x2A 0; Start-Sleep -Milliseconds 60
    Up   0x11 0x1D 0
    Write-Host '  sent Ctrl+Shift+Esc (scancode)'
  }
  'esc'    { Tap 0x1B 0x01 0; Write-Host '  sent ESC' }
  'enter'  { Tap 0x0D 0x1C 0; Write-Host '  sent ENTER' }
  'ctrlv'  { Down 0x11 0x1D 0; Tap 0x56 0x2F 0; Up 0x11 0x1D 0; Write-Host '  sent Ctrl+V' }
  default  { Write-Host ('unknown combo: ' + $Combo); exit 3 }
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
