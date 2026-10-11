<#
  rdp-mouse.ps1 -- 往 mstsc 会话里点击（可见性测试/驱动远端 UI）
    powershell -NoProfile -ExecutionPolicy Bypass -File .\rdp-mouse.ps1 -X 30 -Y 160 -Click dbl -Shot
#>
param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [ValidateSet('single','dbl','right')][string]$Click = 'single',
  [int]$AfterMs = 1500,
  [switch]$Shot,
  [string]$ShotName = 'mouse'
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace M -Name In -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
$LDOWN = 0x0002; $LUP = 0x0004; $RDOWN = 0x0008; $RUP = 0x0010
function Title([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][M.In]::GetWindowTextW($h, $sb, 512); return $sb.ToString() }
Write-Host ('fg before = ' + (Title ([M.In]::GetForegroundWindow())))
[void][M.In]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 300
if ($Click -eq 'single' -or $Click -eq 'dbl') {
  [M.In]::mouse_event($LDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [M.In]::mouse_event($LUP, 0, 0, 0, [UIntPtr]::Zero)
}
if ($Click -eq 'dbl') {
  Start-Sleep -Milliseconds 120
  [M.In]::mouse_event($LDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [M.In]::mouse_event($LUP, 0, 0, 0, [UIntPtr]::Zero)
}
if ($Click -eq 'right') {
  [M.In]::mouse_event($RDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [M.In]::mouse_event($RUP, 0, 0, 0, [UIntPtr]::Zero)
}
Write-Host ('clicked ' + $Click + ' at ' + $X + ',' + $Y)
Start-Sleep -Milliseconds $AfterMs
if ($Shot) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $f = 'C:\rdpshare\' + $ShotName + '.png'
  $bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ('shot -> ' + $f)
}
