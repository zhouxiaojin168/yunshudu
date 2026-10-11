param([string]$Name = 'look')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$f = 'C:\rdpshare\' + $Name + '.png'
$bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ('shot -> ' + $f + '  ' + $b.Width + 'x' + $b.Height)
Get-Process mstsc -ErrorAction SilentlyContinue | Select-Object Id, MainWindowHandle, MainWindowTitle | Format-List
