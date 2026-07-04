# Generates build/icon.ico (multi-resolution, PNG frames) and assets/icon.png
# from the Fleet "stacked clients" mark, using GDI+ (System.Drawing).
# Run:  npm run make-icon

Add-Type -AssemblyName System.Drawing

$root    = Split-Path -Parent $PSScriptRoot
$icoPath = Join-Path $root 'build\icon.ico'
$pngPath = Join-Path $root 'assets\icon.png'

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $d = $r * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# --- Render the master 256x256 bitmap ---
$master = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# White rounded tile with hairline border
$tile = New-RoundedPath 8 8 240 240 46
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $tile)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(224, 225, 228)), 3
$g.DrawPath($pen, $tile)

# Three stacked squares (back -> front)
$back = New-RoundedPath 24 104 120 120 28
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(227,228,231))), $back)
$mid = New-RoundedPath 68 68 120 120 28
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(183,187,193))), $mid)
$front = New-RoundedPath 112 32 120 120 28
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20,22,26))), $front)

# White "launch" triangle on the front square
$tri = @(
  (New-Object System.Drawing.PointF 152, 66),
  (New-Object System.Drawing.PointF 152, 118),
  (New-Object System.Drawing.PointF 198, 92)
)
$g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $tri)
$g.Dispose()

# Save a PNG for docs/README
$master.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Wrote $pngPath"

# --- Build the .ico from downscaled PNG frames ---
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gg.Clear([System.Drawing.Color]::Transparent)
  $gg.DrawImage($master, (New-Object System.Drawing.Rectangle 0, 0, $s, $s))
  $gg.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += , @{ size = $s; bytes = $ms.ToArray() }
  $bmp.Dispose(); $ms.Dispose()
}
$master.Dispose()

# Assemble ICO container (6-byte header + 16-byte entries + PNG payloads)
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt16]0)            # reserved
$bw.Write([UInt16]1)            # type = icon
$bw.Write([UInt16]$frames.Count)
$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  $dim = if ($f.size -ge 256) { 0 } else { $f.size }
  $bw.Write([Byte]$dim)         # width
  $bw.Write([Byte]$dim)         # height
  $bw.Write([Byte]0)            # palette
  $bw.Write([Byte]0)            # reserved
  $bw.Write([UInt16]1)          # planes
  $bw.Write([UInt16]32)         # bpp
  $bw.Write([UInt32]$f.bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $f.bytes.Length
}
foreach ($f in $frames) { $bw.Write($f.bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()
Write-Host "Wrote $icoPath ($($frames.Count) frames: $($sizes -join ', '))"
