#Requires -Version 5.1
<#
  Fleet installer UI audit driver.
  Downloads the released FleetInstaller.exe, launches it, screenshots every
  page (install, progress, finish), dumps the full Win32 control tree, and
  clicks through via PostMessage so no real cursor input is required.

  Output: audit/ directory with PNGs + control dumps + log.
#>
param(
    [string]$InstallerUrl = 'https://github.com/Toluwer/Fleet/releases/download/v1.5.3/FleetInstaller.exe',
    [string]$ExpectedSha512 = '7701872de722cf311715213c192d8bddf72ada00e94efdd4d65cd0f6a9bed1f016c46aae19b5c7c42742c4ae1960f168d655557063d399dfbd62ab290658d3ec'
)

$ErrorActionPreference = 'Stop'
$Out = Join-Path $PSScriptRoot '..\..\audit-output'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
function Log($m) { $t = Get-Date -Format 'HH:mm:ss.fff'; Write-Host "[$t] $m"; Add-Content -Path (Join-Path $Out 'audit.log') -Value "[$t] $m" }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr lp);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, out WINDOWPLACEMENT wp);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int len, flags, showCmd; public POINT ptMin, ptMax; public RECT rcNormal; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

function Get-WinText([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 512; [void][WinCap]::GetWindowText($h, $sb, 512); $sb.ToString() }
function Get-WinClass([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 256; [void][WinCap]::GetClassName($h, $sb, 256); $sb.ToString() }
function Get-WinRect([IntPtr]$h) { $r = New-Object WinCap+RECT; [void][WinCap]::GetWindowRect($h, [ref]$r); $r }

# ---- capture with fallback chain: PrintWindow(PW_RENDERFULLCONTENT) -> PrintWindow(0) -> CopyFromScreen
function IsBlack([System.Drawing.Bitmap]$bmp) {
    $var = 0; $prev = -1
    for ($x = 0; $x -lt $bmp.Width; $x += [Math]::Max(1, [int]($bmp.Width / 24))) {
        for ($y = 0; $y -lt $bmp.Height; $y += [Math]::Max(1, [int]($bmp.Height / 24))) {
            $p = $bmp.GetPixel($x, $y); $lum = $p.R + $p.G + $p.B
            if ($prev -ge 0) { $var += [Math]::Abs($lum - $prev) }
            $prev = $lum
        }
    }
    return ($var -lt 12)  # nearly uniform image == blank/black
}

function Capture-Window([IntPtr]$h, [string]$path) {
    $r = Get-WinRect $h
    $w = [Math]::Max(1, $r.R - $r.L); $ht = [Math]::Max(1, $r.B - $r.T)
    foreach ($flag in @(2, 0)) {
        $bmp = New-Object System.Drawing.Bitmap $w, $ht
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        [void][WinCap]::PrintWindow($h, $hdc, [uint32]$flag)
        $g.ReleaseHdc($hdc); $g.Dispose()
        if (-not (IsBlack $bmp)) { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); return "PrintWindow($flag)" }
        $bmp.Dispose()
    }
    try {
        $bmp = New-Object System.Drawing.Bitmap $w, $ht
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
        $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
        return 'CopyFromScreen'
    } catch { return 'FAILED' }
}

function Capture-FullScreen([string]$path) {
    try {
        $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($b.Width, $b.Height)))
        $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
        Log "full-screen shot saved: $path"
    } catch { Log "full-screen shot FAILED: $($_.Exception.Message)" }
}
Add-Type -AssemblyName System.Windows.Forms

# ---- dump control tree of a window
function Dump-Tree([IntPtr]$root, [string]$path) {
    $script:lines = New-Object System.Collections.Generic.List[string]
    $script:rootRect = Get-WinRect $root
    $script:lines.Add(("ROOT id={0} class={1} text={2} rect={3},{4} {5}x{6}" -f $root, (Get-WinClass $root), (Get-WinText $root), $script:rootRect.L, $script:rootRect.T, ($script:rootRect.R - $script:rootRect.L), ($script:rootRect.B - $script:rootRect.T)))
    $cb = {
        param([IntPtr]$h, [IntPtr]$lp)
        $c = Get-WinClass $h; $t = Get-WinText $h; $r = Get-WinRect $h
        $txt = ($t -replace "`r", '' -replace "`n", '\n')
        $script:lines.Add(("  id={0,-10} class={1,-12} rect=({2,5},{3,5}) {4,4}x{5,-4} rel=({6,5},{7,5}) text='{8}'" -f `
            $h, $c, $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T), ($r.L - $script:rootRect.L), ($r.T - $script:rootRect.T), $txt))
        return $true
    }
    [void][WinCap]::EnumChildWindows($root, $cb, [IntPtr]::Zero)
    $script:lines | Set-Content -Path $path -Encoding UTF8
    Log "control tree ($($script:lines.Count - 1) children) -> $path"
}

function Find-Child([IntPtr]$root, [string]$textMatch) {
    $script:found = [IntPtr]::Zero
    $cb = {
        param([IntPtr]$h, [IntPtr]$lp)
        if ($script:found -eq [IntPtr]::Zero) {
            $t = Get-WinText $h
            if ($t -and $t.Trim() -eq $textMatch) { $script:found = $h }
        }
        return $true
    }
    [void][WinCap]::EnumChildWindows($root, $cb, [IntPtr]::Zero)
    return $script:found
}

function Click-Control([IntPtr]$h) {
    $r = Get-WinRect $h
    $cx = [int](($r.R - $r.L) / 2); $cy = [int](($r.B - $r.T) / 2)
    $lp = [IntPtr]((($cy -shl 16) -bor $cx))
    [void][WinCap]::PostMessage($h, 0x0201, [IntPtr]1, $lp)   # WM_LBUTTONDOWN
    Start-Sleep -Milliseconds 90
    [void][WinCap]::PostMessage($h, 0x0202, [IntPtr]0, $lp)   # WM_LBUTTONUP
    Log "posted click to $h at client $cx,$cy"
}

# ---- 0. environment info
Log "OS: $([System.Environment]::OSVersion.VersionString)"
$g0 = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
Log "DPI: $($g0.DpiX)x$($g0.DpiY)"; $g0.Dispose()
$wv2 = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
Log "WebView2 runtime: $(if ($wv2) { $wv2.pv } else { 'NOT FOUND (installer may install it)' })"

# ---- 1. download installer & verify hash
$exe = Join-Path $env:TEMP 'FleetInstaller.exe'
Log "downloading $InstallerUrl"
Invoke-WebRequest -Uri $InstallerUrl -OutFile $exe -UseBasicParsing
$hash = (Get-FileHash -Algorithm SHA512 $exe).Hash.ToLower()
Log "sha512: $hash"
if ($hash -ne $ExpectedSha512) { throw "SHA512 MISMATCH: $hash" }
Log "hash OK ($($(Get-Item $exe).Length) bytes)"

# ---- 2. launch
Log "launching installer..."
$p = Start-Process -FilePath $exe -WorkingDirectory $env:TEMP -PassThru
$script:p = $p
Log "pid=$($p.Id)"

# ---- 3. wait for main window (#32770 of our pid, visible, titled 'Fleet Installer')
$main = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and $script:main -eq [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 500
    $cb = {
        param([IntPtr]$h, [IntPtr]$lp)
        $procId = 0
        [void][WinCap]::GetWindowThreadProcessId($h, [ref]$procId)
        if ($procId -eq $script:p.Id -and [WinCap]::IsWindowVisible($h)) {
            $cls = Get-WinClass $h
            if ($cls -eq '#32770') { $script:main = $h }
        }
        return $true
    }
    [void][WinCap]::EnumWindows($cb, [IntPtr]::Zero)
    if ($script:main -eq [IntPtr]::Zero) { try { $p.Refresh(); if ($p.HasExited) { throw "installer exited early (code $($p.ExitCode))" } } catch {} }
}
if ($script:main -eq [IntPtr]::Zero) { Capture-FullScreen (Join-Path $Out '00_debug_no_window.png'); throw 'installer window not found' }
$main = $script:main
Log "main window: $main '$(Get-WinText $main)'"
[void][WinCap]::SetWindowPos($main, [IntPtr]::Zero, 100, 100, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)  # NOMOVE-off: place at 100,100, NOZORDER|NOACTIVATE... (SWP_NOSIZE=0x1, SHOWWINDOW=0x40)
Start-Sleep -Milliseconds 800

# ---- 4. page 1: dump + capture
Dump-Tree $main (Join-Path $Out 'controls_01_install.txt')
$m = Capture-Window $main (Join-Path $Out '01_install_page.png')
Log "capture method: $m"
Start-Sleep -Seconds 1
[void](Capture-Window $main (Join-Path $Out '01b_install_page.png'))
Capture-FullScreen (Join-Path $Out '01c_fullscreen.png')

# ---- 5. click Install
$install = Find-Child $main 'Install'
if ($install -eq [IntPtr]::Zero) { Log 'ERROR: Install control not found'; throw 'Install control not found' }
Log "Install control: $install rect=$((Get-WinRect $install).L),$((Get-WinRect $install).T) $((Get-WinRect $install).R - (Get-WinRect $install).L)x$((Get-WinRect $install).B - (Get-WinRect $install).T)"
Click-Control $install

# ---- 6. progress: poll & capture
$finish = $false
$progressShots = 0
$deadline = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $p.Refresh()
    if ($p.HasExited) { Log 'installer exited during progress!'; break }
    if ($progressShots -lt 6) {
        [void](Capture-Window $main (Join-Path $Out ("02_progress_{0:d2}.png" -f $progressShots)))
        $progressShots++
    }
    if ((Find-Child $main 'Launch Fleet') -ne [IntPtr]::Zero) { $finish = $true; Log 'finish page detected'; break }
    if ((Find-Child $main 'Fleet is ready') -ne [IntPtr]::Zero) { $finish = $true; Log 'finish page detected (label)'; break }
}

# ---- 7. finish page
if ($finish) {
    Start-Sleep -Seconds 2
    Dump-Tree $main (Join-Path $Out 'controls_03_finish.txt')
    [void](Capture-Window $main (Join-Path $Out '03_finish_page.png'))
    Start-Sleep -Seconds 1
    [void](Capture-Window $main (Join-Path $Out '03b_finish_page.png'))
    Capture-FullScreen (Join-Path $Out '03c_fullscreen.png')
} else {
    Log 'WARNING: finish page not reached in time'
}

# ---- 8. cleanup (do NOT click Launch Fleet - would start the app)
try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
Log 'done. files:'
Get-ChildItem $Out | ForEach-Object { Log ("  {0}  {1} bytes" -f $_.Name, $_.Length) }
Write-Host "AUDIT_OUTPUT_DIR=$Out"
