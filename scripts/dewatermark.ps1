<#
  dewatermark.ps1 -- strip the small bottom-right overlay tag (e.g. the CN 'AI generated' corner tag)
  from a generated image. Method: take the strip immediately LEFT of the tag box, mirror it about the
  box's left edge (seamless at x0), paste it back through a vertical alpha ramp (feathered top edge).
  Only that box is touched; every other pixel is left as-is.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File dewatermark.ps1 -In a.jpg -Out b.jpg
  Optional: -X 0.815 -Y 0.848 -Y2 0.952 -Feather 0.55 -Bands 60
  Exit 0 on success, non-zero on failure.
#>
param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [double]$X = 0.815,
  [double]$Y = 0.848,
  [double]$Y2 = 0.952,
  [double]$Feather = 0.55,
  [int]$Bands = 60
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($In)
try {
  $W = $img.Width; $H = $img.Height
  $x0 = [int]($W * $X); $y0 = [int]($H * $Y); $y1 = [int]($H * $Y2)
  if ($x0 -lt 8 -or $y0 -lt 8 -or $y1 -le ($y0 + 8) -or $x0 -ge $W) { throw ('bad box ' + $x0 + ',' + $y0 + ',' + $y1) }
  $rw = $W - $x0; $rh = $y1 - $y0
  if (($x0 - $rw) -lt 0) { throw 'box too wide for mirror source' }
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($img, 0, 0, $W, $H)
  $strip = New-Object System.Drawing.Bitmap($rw, $rh)
  $gs = [System.Drawing.Graphics]::FromImage($strip)
  $gs.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $rw, $rh)), (New-Object System.Drawing.Rectangle(($x0 - $rw), $y0, $rw, $rh)), [System.Drawing.GraphicsUnit]::Pixel)
  $gs.Dispose()
  $strip.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX)
  $featherPx = [int]($rh * $Feather)
  $bandH = [Math]::Ceiling($rh / $Bands)
  for ($i = 0; $i -lt $Bands; $i++) {
    $by = $i * $bandH
    $bh = [Math]::Min($bandH, $rh - $by)
    if ($bh -le 0) { break }
    $a = if ($by -ge $featherPx) { 1.0 } else { [double]$by / [double][Math]::Max($featherPx,1) }
    if ($a -le 0.002) { continue }
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix33 = [single][Math]::Min(1.0, $a)
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $ia.SetColorMatrix($cm)
    $dRect = New-Object System.Drawing.Rectangle($x0, ($y0 + $by), $rw, $bh)
    $g.DrawImage($strip, $dRect, 0, $by, $rw, $bh, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $ia.Dispose()
  }
  $g.Dispose(); $strip.Dispose()
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]95)
  $bmp.Save($Out, $enc, $ep)
  $bmp.Dispose()
  Write-Output ('dewatermark ok ' + $W + 'x' + $H + ' box=' + $x0 + ',' + $y0 + ' ' + $rw + 'x' + $rh + ' -> ' + $Out)
} finally { $img.Dispose() }
