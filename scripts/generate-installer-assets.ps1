param(
  [Parameter(Mandatory = $true)][string]$SourceLogo,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-Canvas([int]$Width, [int]$Height) {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  return @{ Bitmap = $bitmap; Graphics = $graphics }
}

function Save-Bitmap($Canvas, [string]$Path) {
  $Canvas.Graphics.Dispose()
  $Canvas.Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $Canvas.Bitmap.Dispose()
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$mark = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourceLogo).Path)
$ink = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(37, 35, 33))
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(102, 108, 105))
$line = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(226, 228, 226), 1)
$titleFont = [System.Drawing.Font]::new("Segoe UI", 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = [System.Drawing.Font]::new("Segoe UI", 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$smallFont = [System.Drawing.Font]::new("Segoe UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

try {
  $sidebar = New-Canvas 164 314
  $sidebar.Graphics.DrawImage($mark, 34, 38, 96, 96)
  $sidebar.Graphics.DrawString("Meta Code", $titleFont, $ink, 38, 158)
  $sidebar.Graphics.DrawString("多 Agent 开发工作台", $bodyFont, $muted, 31, 187)
  $sidebar.Graphics.DrawLine($line, 28, 221, 136, 221)
  $sidebar.Graphics.DrawString("VERSION $Version", $smallFont, $muted, 47, 238)
  Save-Bitmap $sidebar (Join-Path $OutputDirectory "installerSidebar.bmp")

  $header = New-Canvas 150 57
  $header.Graphics.DrawImage($mark, 9, 9, 38, 38)
  $header.Graphics.DrawString("Meta Code", $titleFont, $ink, 54, 11)
  $header.Graphics.DrawString("本地多 Agent 工作台", $smallFont, $muted, 55, 34)
  Save-Bitmap $header (Join-Path $OutputDirectory "installerHeader.bmp")
} finally {
  $smallFont.Dispose()
  $bodyFont.Dispose()
  $titleFont.Dispose()
  $line.Dispose()
  $muted.Dispose()
  $ink.Dispose()
  $mark.Dispose()
}
