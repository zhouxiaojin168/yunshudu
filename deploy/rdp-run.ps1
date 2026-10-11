<#
  rdp-run.ps1 -- 往 mstsc 会话里"确定性"执行一条命令（不靠打字）
    原理：AttachThreadInput 抢前台 -> 真 Win+R 打开"运行" -> 剪贴板粘贴命令 -> 回车
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\rdp-run.ps1 -Command "\\tsclient\C\rdpshare\b.cmd"
#>
param(
  [Parameter(Mandatory=$true)][string]$Command,
  [int]$StepDelayMs = 1200,
  [string]$Tag = '',
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
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@
function Shot([string]$name) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  if (-not $name) { $name = 'shot' }
  $f = 'C:\rdpshare\' + $name + '.png'
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('  shot -> ' + $f)
}
$p = Get-Process mstsc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
Write-Host ('mstsc pid=' + $p.Id + ' title=' + $p.MainWindowTitle)
$h = $p.MainWindowHandle
[void][N.U]::ShowWindow($h, 9)
[void][N.U]::BringWindowToTop($h)
$fg = [N.U]::GetForegroundWindow()
$ft = [N.U]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$ct = [N.U]::GetCurrentThreadId()
[void][N.U]::AttachThreadInput($ct, $ft, $true)
$ok = [N.U]::SetForegroundWindow($h)
[void][N.U]::AttachThreadInput($ct, $ft, $false)
Write-Host ('  focus: SetForegroundWindow=' + $ok)
Start-Sleep -Milliseconds $StepDelayMs

# 1) 真 Win+R（keybd_event: LWIN=0x5B, R=0x52, KEYUP=0x0002）
[N.U]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[N.U]::keybd_event(0x52, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[N.U]::keybd_event(0x52, 0, 0x0002, [UIntPtr]::Zero)
[N.U]::keybd_event(0x5B, 0, 0x0002, [UIntPtr]::Zero)
Write-Host '  sent Win+R'
Start-Sleep -Milliseconds $StepDelayMs
if ($ShotEach) { Shot ($Tag + '-1-winr') }

# 2) 剪贴板放命令 + Ctrl+V
Set-Clipboard -Value $Command
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('^v')
Write-Host '  sent Ctrl+V'
Start-Sleep -Milliseconds $StepDelayMs
if ($ShotEach) { Shot ($Tag + '-2-paste') }

# 3) 回车
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Host '  sent ENTER'
Start-Sleep -Milliseconds ($StepDelayMs + 800)
if ($ShotEach) { Shot ($Tag + '-3-enter') }
Write-Host 'DONE'
