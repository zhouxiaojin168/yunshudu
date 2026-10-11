<#
  rdp-find.ps1 -- 枚举 mstsc 进程的所有顶层窗口（类名/标题/矩形/可见性），并给出「最佳主窗口」
    用法: powershell -NoProfile -ExecutionPolicy Bypass -File C:\rdpshare\rdp-find.ps1
#>
param([switch]$Maximize,[switch]$Quiet)
$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> List(uint pid) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
        var c = new StringBuilder(512); GetClassNameW(h, c, 512);
        RECT r; GetWindowRect(h, out r);
        res.Add(h.ToInt64() + "|" + c.ToString() + "|" + t.ToString() + "|" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + "|vis=" + IsWindowVisible(h));
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static void Max(IntPtr h) { ShowWindow(h, 3); }
}
'@
if (-not ('WEnum' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }
$p = Get-Process mstsc -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { Write-Host 'NO mstsc'; exit 1 }
Write-Host ('mstsc pid = ' + $p.Id)
$lines = [WEnum]::List([uint32]$p.Id)
$best = [IntPtr]::Zero; $bestArea = 0
foreach ($ln in $lines) {
  Write-Host ('  ' + $ln)
  $parts = $ln.Split('|')
  $rect = $parts[3].Split(',')
  $wh = $rect[2].Split('x')
  $area = [int]$wh[0] * [int]$wh[1]
  if ($parts[1] -eq 'TscShellContainerClass' -and $area -gt $bestArea) { $bestArea = $area; $best = [IntPtr][int64]$parts[0] }
}
if ($best -eq [IntPtr]::Zero) { Write-Host 'NO TscShellContainerClass window!'; exit 2 }
Write-Host ('BEST hwnd = ' + $best + '  area=' + $bestArea)
if ($Maximize) {
  [WEnum]::Max($best)
  Start-Sleep -Milliseconds 1500
}
$wr = New-Object WEnum+RECT
[void][WEnum]::GetWindowRect($best, [ref]$wr)
$cr = New-Object WEnum+RECT
[void][WEnum]::GetClientRect($best, [ref]$cr)
$pt = New-Object WEnum+POINT; $pt.x = 0; $pt.y = 0
[void][WEnum]::ClientToScreen($best, [ref]$pt)
$cw = $cr.Right - $cr.Left
$ch = $cr.Bottom - $cr.Top
Write-Host ('windowRect = ' + $wr.Left + ',' + $wr.Top + ' ' + ($wr.Right - $wr.Left) + 'x' + ($wr.Bottom - $wr.Top))
Write-Host ('clientRect = ' + $cw + 'x' + $ch + ' at ' + $pt.x + ',' + $pt.y)
if ($cw -eq 1280 -and $ch -eq 800) { Write-Host 'MAPPING 1:1  => screenX = ' + $pt.x + ' + RX ; screenY = ' + $pt.y + ' + RY' }
