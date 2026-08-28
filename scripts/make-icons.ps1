# DSH Studio 图标生成脚本
# 生成两套候选图标（方案 A：对话脉冲 / 方案 B：终端窗口），输出多尺寸 PNG 与 SVG 源稿。
# 用法: pwsh scripts/make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\icons\preview'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 圆角矩形路径
function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
  $p.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
  $p.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
  $p.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
  $p.CloseFigure()
  return $p
}

# ---- 方案 A：对话脉冲（深蓝渐变圆角方块 + 白色对话气泡 + 三个蓝点）----
function Draw-SchemeA([int]$size, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [float]$size

  # 渐变底：左上亮蓝 → 右下深蓝
  $bg = New-RoundedRectPath 0 0 $s $s ($s * 0.19)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $s, $s),
    [System.Drawing.Color]::FromArgb(255, 59, 130, 246),   # #3b82f6
    [System.Drawing.Color]::FromArgb(255, 29, 78, 216)     # #1d4ed8
  )
  $g.FillPath($grad, $bg)

  # 对话气泡：白色圆角矩形 + 左下尾巴
  $bw = $s * 0.58; $bh = $s * 0.36
  $bx = ($s - $bw) / 2; $by = $s * 0.24
  $br = $s * 0.09
  $tail = $s * 0.14
  $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bubble.AddArc($bx, $by, $br * 2, $br * 2, 180, 90)
  $bubble.AddArc($bx + $bw - $br * 2, $by, $br * 2, $br * 2, 270, 90)
  $bubble.AddArc($bx + $bw - $br * 2, $by + $bh - $br * 2, $br * 2, $br * 2, 0, 90)
  $bubble.AddLine($bx + $bw * 0.42, $by + $bh, $bx + $bw * 0.24, $by + $bh + $tail)
  $bubble.AddLine($bx + $bw * 0.24, $by + $bh + $tail, $bx + $bw * 0.24, $by + $bh)
  $bubble.AddArc($bx, $by + $bh - $br * 2, $br * 2, $br * 2, 90, 90)
  $bubble.CloseFigure()
  $g.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::White), $bubble)

  # 气泡内三个蓝点（省略号）
  $dotR = $s * 0.045
  $dotY = $by + $bh * 0.5
  $spacing = $s * 0.155
  $cx = $s * 0.5
  $dotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 37, 99, 235)) # #2563eb
  for ($i = -1; $i -le 1; $i++) {
    $g.FillEllipse($dotBrush, $cx + $i * $spacing - $dotR, $dotY - $dotR, $dotR * 2, $dotR * 2)
  }

  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $dotBrush.Dispose(); $grad.Dispose(); $bg.Dispose(); $bubble.Dispose()
  $g.Dispose(); $bmp.Dispose()
}

# ---- 方案 B：终端窗口（深色圆角方块 + 标题栏三色点 + 绿色提示符）----
function Draw-SchemeB([int]$size, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [float]$size

  # 深色渐变底
  $bg = New-RoundedRectPath 0 0 $s $s ($s * 0.19)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, $s),
    [System.Drawing.Color]::FromArgb(255, 15, 23, 32),    # #0f1720
    [System.Drawing.Color]::FromArgb(255, 30, 41, 59)     # #1e293b
  )
  $g.FillPath($grad, $bg)

  # 标题栏：上半透明白条
  $barH = $s * 0.16
  $bar = New-RoundedRectPath ($s * 0.02) ($s * 0.02) ($s * 0.96) $barH ($s * 0.08)
  $barBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(64, 255, 255, 255))
  $g.FillPath($barBrush, $bar)

  # 标题栏三个窗口点（红/黄/绿）
  $barY = $s * 0.02 + $barH / 2
  $barD = $s * 0.055
  $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 95, 86)), $s * 0.08 - $barD / 2, $barY - $barD / 2, $barD, $barD)
  $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 189, 46)), $s * 0.16 - $barD / 2, $barY - $barD / 2, $barD, $barD)
  $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 39, 201, 63)), $s * 0.24 - $barD / 2, $barY - $barD / 2, $barD, $barD)

  # 绿色提示符 » （两条粗线段拼成的箭头）
  $green = [System.Drawing.Color]::FromArgb(255, 74, 222, 128) # #4ade80
  $pen = New-Object System.Drawing.Pen $green, ($s * 0.055)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cx = $s * 0.545
  $topY = $s * 0.40; $botY = $s * 0.62; $midY = $s * 0.51
  $backX = $s * 0.36
  $g.DrawLine($pen, $backX, $topY, $cx, $midY)
  $g.DrawLine($pen, $cx, $midY, $backX, $botY)
  # 第二层浅绿箭头（回声）
  $pen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 74, 222, 128)), ($s * 0.055)
  $pen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen2.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $backX2 = $s * 0.47
  $g.DrawLine($pen2, $backX2, $topY + $s * 0.02, $cx + $s * 0.11, $midY + $s * 0.01)
  $g.DrawLine($pen2, $cx + $s * 0.11, $midY + $s * 0.01, $backX2, $botY)

  # 闪烁光标：绿色圆角短横线
  $cur = New-RoundedRectPath ($s * 0.36) ($s * 0.70) ($s * 0.30) ($s * 0.075) ($s * 0.04)
  $g.FillPath([System.Drawing.SolidBrush]::new($green), $cur)

  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $pen2.Dispose(); $barBrush.Dispose(); $cur.Dispose(); $grad.Dispose(); $bg.Dispose(); $bar.Dispose()
  $g.Dispose(); $bmp.Dispose()
}

# ---- 方案 C：DeepSeek D（参考 Claude Code / Codex / OpenCode：深色底 + 居中几何标志）----
# D 形对话气泡：左侧竖线 + 右侧半圆（名字 D），左下尾巴（对话），DeepSeek 蓝 + 白点。
function Draw-SchemeC([int]$size, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [float]$size

  # 深色渐变底（对齐 CLI 工具图标风格）
  $bg = New-RoundedRectPath 0 0 $s $s ($s * 0.19)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, $s),
    [System.Drawing.Color]::FromArgb(255, 12, 18, 34),     # #0c1222
    [System.Drawing.Color]::FromArgb(255, 20, 29, 54)      # #141d36
  )
  $g.FillPath($grad, $bg)

  # D 形对话气泡（DeepSeek 蓝 #4d6bfe）：左侧竖线 + 右侧半圆（D 形），左下尾巴
  $w = $s * 0.46; $h = $s * 0.44
  $bx = ($s - $w) / 2; $by = $s * 0.28
  $rTop = $s * 0.06          # 上下小圆角
  $rSide = $h / 2            # 右侧半圆
  $tail = $s * 0.09
  $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bubble.AddArc($bx, $by, $rTop * 2, $rTop * 2, 180, 90)                    # 左上小圆角
  $bubble.AddLine($bx + $rTop, $by, $bx + $w - $rSide, $by)                  # 顶边
  $bubble.AddArc($bx + $w - $h, $by, $h, $h, 270, 180)                       # 右侧半圆（D 弧）
  $bubble.AddLine($bx + $w - $rSide, $by + $h, $bx + $w * 0.34, $by + $h)    # 底边（右段）
  $bubble.AddLine($bx + $w * 0.34, $by + $h, $bx + $w * 0.24, $by + $h + $tail) # 尾巴斜出
  $bubble.AddLine($bx + $w * 0.24, $by + $h + $tail, $bx + $w * 0.14, $by + $h) # 尾巴返回
  $bubble.AddLine($bx + $w * 0.14, $by + $h, $bx + $rTop, $by + $h)          # 底边（左段）
  $bubble.AddArc($bx, $by + $h - $rTop * 2, $rTop * 2, $rTop * 2, 90, 90)    # 左下小圆角
  $bubble.AddLine($bx, $by + $h - $rTop, $bx, $by + $rTop)                   # 左边缘（竖线）
  $bubble.CloseFigure()
  $blue = [System.Drawing.Color]::FromArgb(255, 77, 107, 254) # #4d6bfe
  $g.FillPath([System.Drawing.SolidBrush]::new($blue), $bubble)

  # 白点三连（对话省略号）
  $dotR = $s * 0.036
  $dotY = $by + $h * 0.5
  $spacing = $s * 0.12
  $cx = $bx + $w * 0.44
  $dotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  for ($i = -1; $i -le 1; $i++) {
    $g.FillEllipse($dotBrush, $cx + $i * $spacing - $dotR, $dotY - $dotR, $dotR * 2, $dotR * 2)
  }

  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $dotBrush.Dispose(); $grad.Dispose(); $bg.Dispose(); $bubble.Dispose()
  $g.Dispose(); $bmp.Dispose()
}

# ---- 方案 D：鲜亮 DeepSeek D（亮蓝渐变底 + 白色 D 形气泡 + 深蓝三点）----
function Draw-SchemeD([int]$size, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [float]$size

  # 鲜亮蓝渐变底（对角）
  $bg = New-RoundedRectPath 0 0 $s $s ($s * 0.19)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $s, $s),
    [System.Drawing.Color]::FromArgb(255, 96, 128, 255),   # #6080ff
    [System.Drawing.Color]::FromArgb(255, 61, 90, 254)     # #3d5afe
  )
  $g.FillPath($grad, $bg)

  # 白色 D 形对话气泡
  $w = $s * 0.46; $h = $s * 0.44
  $bx = ($s - $w) / 2; $by = $s * 0.28
  $rTop = $s * 0.06
  $rSide = $h / 2
  $tail = $s * 0.09
  $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bubble.AddArc($bx, $by, $rTop * 2, $rTop * 2, 180, 90)
  $bubble.AddLine($bx + $rTop, $by, $bx + $w - $rSide, $by)
  $bubble.AddArc($bx + $w - $h, $by, $h, $h, 270, 180)
  $bubble.AddLine($bx + $w - $rSide, $by + $h, $bx + $w * 0.34, $by + $h)
  $bubble.AddLine($bx + $w * 0.34, $by + $h, $bx + $w * 0.24, $by + $h + $tail)
  $bubble.AddLine($bx + $w * 0.24, $by + $h + $tail, $bx + $w * 0.14, $by + $h)
  $bubble.AddLine($bx + $w * 0.14, $by + $h, $bx + $rTop, $by + $h)
  $bubble.AddArc($bx, $by + $h - $rTop * 2, $rTop * 2, $rTop * 2, 90, 90)
  $bubble.AddLine($bx, $by + $h - $rTop, $bx, $by + $rTop)
  $bubble.CloseFigure()
  $g.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::White), $bubble)

  # 深蓝三点（对话省略号）
  $dotR = $s * 0.036
  $dotY = $by + $h * 0.5
  $spacing = $s * 0.12
  $cx = $bx + $w * 0.44
  $dotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 47, 75, 216)) # #2f4bd8
  for ($i = -1; $i -le 1; $i++) {
    $g.FillEllipse($dotBrush, $cx + $i * $spacing - $dotR, $dotY - $dotR, $dotR * 2, $dotR * 2)
  }

  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $dotBrush.Dispose(); $grad.Dispose(); $bg.Dispose(); $bubble.Dispose()
  $g.Dispose(); $bmp.Dispose()
}

# ---- ICO 打包（PNG-in-ICO，Vista+ 支持）----
function Build-Ico([string[]]$pngFiles, [string]$icoFile) {
  $entries = @()
  $total = 0
  foreach ($f in $pngFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $dim = [int]([regex]::Match($f, '-(\d+)\.png$').Groups[1].Value)
    $entries += [pscustomobject]@{ Dim = $dim; Bytes = $bytes; Offset = 0 }
    $total += $bytes.Length
  }
  $offset = 6 + 16 * $entries.Count
  foreach ($e in $entries) { $e.Offset = $offset; $offset += $e.Bytes.Length }

  $fs = [System.IO.File]::Create($icoFile)
  $w = New-Object System.IO.BinaryWriter($fs)
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$entries.Count)
  foreach ($e in $entries) {
    $dim = if ($e.Dim -ge 256) { 0 } else { $e.Dim }
    $w.Write([Byte]$dim); $w.Write([Byte]$dim)      # 宽/高（0 = 256）
    $w.Write([Byte]0); $w.Write([Byte]0)            # 颜色数/保留
    $w.Write([UInt16]1); $w.Write([UInt16]32)       # 平面/位深
    $w.Write([UInt32]$e.Bytes.Length)
    $w.Write([UInt32]$e.Offset)
  }
  foreach ($e in $entries) { $w.Write($e.Bytes) }
  $w.Flush(); $w.Close(); $fs.Close()
}

# ---- 正式输出（方案 D）----
$iconsDir = Join-Path $PSScriptRoot '..\icons'
$sizes = @(16, 24, 32, 48, 64, 128, 256, 512)
foreach ($size in $sizes) { Draw-SchemeD $size (Join-Path $iconsDir "icon-$size.png") }
# 托盘图标（32px 在标准/高分屏下均清晰）
Draw-SchemeD 32 (Join-Path $iconsDir 'tray.png')
# 应用大图
Copy-Item (Join-Path $iconsDir 'icon-512.png') (Join-Path $iconsDir 'icon.png') -Force

$icoParts = @()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) { $icoParts += (Join-Path $iconsDir "icon-$size.png") }
Build-Ico $icoParts (Join-Path $iconsDir 'icon.ico')
Write-Host "正式图标已生成: $iconsDir\icon.ico / tray.png / icon.png"
Write-Host "图标预览已生成: $out"

# ---- SVG 源稿 ----
$svgDir = Join-Path $out 'svg'
New-Item -ItemType Directory -Force -Path $svgDir | Out-Null

@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="97" fill="url(#bg)"/>
  <path d="M 250 122 h 166 a 46 46 0 0 1 46 46 v 92 a 46 46 0 0 1 -46 46 h -80 l -46 62 v -62 h -40 a 46 46 0 0 1 -46 -46 v -92 a 46 46 0 0 1 46 -46 z" fill="#ffffff"/>
  <circle cx="256" cy="192" r="23" fill="#2563eb"/>
  <circle cx="339" cy="192" r="23" fill="#2563eb"/>
  <circle cx="422" cy="192" r="23" fill="#2563eb"/>
</svg>
'@ | Set-Content (Join-Path $svgDir 'schemeA.svg') -Encoding UTF8

@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f1720"/>
      <stop offset="1" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="97" fill="url(#bg)"/>
  <rect x="36" y="36" width="440" height="72" rx="36" fill="#ffffff" opacity="0.14"/>
  <circle cx="76" cy="72" r="26" fill="#ff5f56"/>
  <circle cx="132" cy="72" r="26" fill="#ffbd2e"/>
  <circle cx="188" cy="72" r="26" fill="#27c93f"/>
  <g stroke="#4ade80" stroke-width="28" stroke-linecap="round" fill="none">
    <polyline points="190,210 278,261 190,312"/>
    <polyline points="243,218 331,268 243,319" opacity="0.45"/>
  </g>
  <rect x="186" y="358" width="152" height="38" rx="19" fill="#4ade80"/>
</svg>
'@ | Set-Content (Join-Path $svgDir 'schemeB.svg') -Encoding UTF8

Write-Host "SVG 源稿已生成: $svgDir"

@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6080ff"/>
      <stop offset="1" stop-color="#3d5afe"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="97" fill="url(#bg)"/>
  <path d="M 153 152
           H 314
           A 113 113 0 0 1 314 378
           H 232
           L 220 425
           L 203 378
           H 170
           A 31 31 0 0 1 170 152
           Z" fill="#ffffff"/>
  <circle cx="230" cy="260" r="19" fill="#2f4bd8"/>
  <circle cx="297" cy="260" r="19" fill="#2f4bd8"/>
  <circle cx="364" cy="260" r="19" fill="#2f4bd8"/>
</svg>
'@ | Set-Content (Join-Path $svgDir 'schemeD.svg') -Encoding UTF8

@'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1222"/>
      <stop offset="1" stop-color="#141d36"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="496" height="496" rx="97" fill="url(#bg)"/>
  <path d="M 153 155
           H 316
           A 107 107 0 0 1 316 369
           H 166 Q 166 369 158 388 Q 148 411 138 412 Q 149 398 152 369 H 153
           A 28 28 0 0 1 153 155 Z" fill="#4d6bfe"/>
  <circle cx="230" cy="262" r="19" fill="#ffffff"/>
  <circle cx="297" cy="262" r="19" fill="#ffffff"/>
  <circle cx="364" cy="262" r="19" fill="#ffffff"/>
</svg>
'@ | Set-Content (Join-Path $svgDir 'schemeC.svg') -Encoding UTF8
