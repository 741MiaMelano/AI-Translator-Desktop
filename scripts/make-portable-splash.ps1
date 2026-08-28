#requires -Version 5
# Generates build/splash.bmp for the electron-builder portable target.
# The splash is load-bearing, not decoration: declaring portable.splashImage keeps the
# NSIS wrapper out of silent mode, which is the only way .onGUIInit runs InitPluginsDir
# and $PLUGINSDIR resolves to a per-launch directory (see docs/ui-redesign notes on J1).
[CmdletBinding()]
param(
  [string] $IconPath = "build\icon.png",
  [string] $OutPath = "build\splash.bmp"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$width = 520
$height = 240
$bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $ink = [System.Drawing.Color]::FromArgb(23, 19, 14)
  $graphics.Clear($ink)

  $rule = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(201, 162, 39))
  $graphics.FillRectangle($rule, 0, 0, $width, 4)

  $iconFull = [System.IO.Path]::GetFullPath($IconPath)
  if (Test-Path -LiteralPath $iconFull) {
    $icon = [System.Drawing.Image]::FromFile($iconFull)
    try {
      $graphics.DrawImage($icon, 44, 64, 108, 108)
    } finally {
      $icon.Dispose()
    }
  }

  $title = New-Object System.Drawing.Font("Microsoft YaHei UI", 21, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $body = New-Object System.Drawing.Font("Microsoft YaHei UI", 14, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $bright = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(232, 220, 200))
  $muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(154, 141, 120))

  $graphics.DrawString("桌面 AI 翻译器", $title, $bright, 186, 76)
  $graphics.DrawString("正在解包便携运行环境…", $body, $bright, 188, 116)
  $graphics.DrawString("解压约 330 MB，请勿重复双击。", $body, $muted, 188, 144)

  $bitmap.Save([System.IO.Path]::GetFullPath($OutPath), [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output ("splash written: {0}" -f [System.IO.Path]::GetFullPath($OutPath))
