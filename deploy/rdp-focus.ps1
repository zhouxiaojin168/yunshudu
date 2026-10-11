<#
  rdp-focus.ps1 -- 把 mstsc 窗口真正抢到前台（TopMost 推 + AttachThreadInput + 校验），并可继续发按键
    用法:
      powershell -NoProfile -ExecutionPolicy Bypass -File .\rdp-focus.ps1                      # 只看焦点是否抢到
      powershell ... -File .\rdp-focus.ps1 -Command '\\tsclient\C\rdpshare\b.cmd' -ShotEach     # 抢焦点后 Win+R 粘贴执行
#>
param(
  [string]$Command = '',
  [int]$StepDelayMs = 1200,
  [string]$Tag = 'f',
  [switch]$ShotEach
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace N -Name U -MemberDefinition @'
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
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
$SWP = 0x0001 -bor 0x0002 -bor 0x0040   # NOSIZE | NOMOVE | SHOWWINDOW
function WinTitle([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][N.U]::GetWindowTextW($h, $sb, 512)
  return $sb.ToString()
}
function Shot([string]$name) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $path = 'C:\rdpshare\' + $name + '.png'
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('  shot -> C:\rdpshare\' + $name + '.png')
}

$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
$h = $p.MainWindowHandle
Write-Host ('mstsc pid=' + $p.Id + '  hwnd=' + $h + '  title=' + (WinTitle $h))

[void][N.U]::ShowWindow($h, 9)
[void][N.U]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP)
[void][N.U]::BringWindowToTop($h)
$fg = [N.U]::GetForegroundWindow()
$fpid = [uint32]0
$ft = [N.U]::GetWindowThreadProcessId($fg, [ref]$fpid)
$ct = [N.U]::GetCurrentThreadId()
[void][N.U]::AttachThreadInput($ct, $ft, $true)
[void][N.U]::SwitchToThisWindow($h, $true)
$ok = [N.U]::SetForegroundWindow($h)
[void][N.U]::AttachThreadInput($ct, $ft, $false)
[void][N.U]::SetWindowPos($h, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP)
Start-Sleep -Milliseconds 600
$fg2 = [N.U]::GetForegroundWindow()
Write-Host ('  SetForegroundWindow=' + $ok)
Write-Host ('  foreground now = ' + $fg2 + '  title=' + (WinTitle $fg2) + '  isMstsc=' + ($fg2 -eq $h))
if ($Command -eq '') { exit 0 }
if ($fg2 -ne $h) { Write-Host '  !! 焦点仍未抢到，放弃发键（避免误伤本机）'; exit 2 }

Start-Sleep -Milliseconds $StepDelayMs
# Win+R（keybd_event：LWIN=0x5B / R=0x52 / KEYUP=0x0002）
[N.U]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 130
[N.U]::keybd_event(0x52, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 130
[N.U]::keybd_event(0x52, 0, 0x0002, [UIntPtr]::Zero); Start-Sleep -Milliseconds 130
[N.U]::keybd_event(0x5B, 0, 0x0002, [UIntPtr]::Zero)
Write-Host '  sent Win+R'
Start-Sleep -Milliseconds $StepDelayMs
if ($ShotEach) { Shot ($Tag + '-1') }
Set-Clipboard -Value $Command
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait('^v')
Write-Host ('  pasted: ' + $Command)
Start-Sleep -Milliseconds $StepDelayMs
if ($ShotEach) { Shot ($Tag + '-2') }
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Host '  sent ENTER'
Start-Sleep -Milliseconds ($StepDelayMs + 1200)
if ($ShotEach) { Shot ($Tag + '-3') }
Write-Host 'DONE'
