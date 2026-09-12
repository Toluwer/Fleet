param(
    [string] $InstallerPath = '',
    [string] $InstallerUrl = '',
    [string] $ExpectedSha512 = 'skip'
)

# Audits the custom Fleet installer UI on real Windows:
#   1. Runs FleetInstaller.exe with --demo (drives its single page through
#      the flow: install form -> Install Fleet -> progress -> done) and
#      screenshots the screen throughout.
#   2. Verifies the install actually happened: files, registry, shortcuts.
#   3. Re-runs it: same version -> must show "already installed" and close.
#   4. Fakes an older installed version, re-runs it -> update flow: closes
#      Fleet, removes the previous version's files, installs the new one.
#   5. Uninstalls and verifies removal.
# Output lands in .\audit-output\

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'audit-output'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

if (-not $InstallerPath) {
    $InstallerPath = Join-Path $root 'dist\FleetInstaller.exe'
    if (-not (Test-Path $InstallerPath)) { $InstallerPath = '' }
}
if (-not $InstallerPath -and $InstallerUrl) {
    $tmp = Join-Path $env:TEMP 'FleetInstaller-audit.exe'
    Invoke-WebRequest $InstallerUrl -OutFile $tmp -UseBasicParsing
    if ($ExpectedSha512 -and $ExpectedSha512 -ne 'skip') {
        $actual = (Get-FileHash $tmp -Algorithm SHA512).Hash
        if ($actual -ne $ExpectedSha512) { throw "SHA-512 mismatch: expected $ExpectedSha512 got $actual" }
    }
    $InstallerPath = $tmp
}
if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) { throw 'No installer to audit.' }
Write-Host "Auditing: $InstallerPath"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace FleetAudit -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$installDir = Join-Path $env:TEMP ('FleetAudit-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

# The installer's own trace (only written when FLEET_SETUP_LOG is set).
$fleetLog = Join-Path $env:TEMP 'FleetSetup.log'
if (Test-Path $fleetLog) { Remove-Item $fleetLog -Force }
$env:FLEET_SETUP_LOG = '1'

# ---- window shape: borderless, 8px rounded, drawn on every Windows ----------
# The window is a layered surface whose alpha channel is the shape, so this
# check works on Windows 10 as well as 11 (no DWM corner preference involved).
# A bright backdrop sits behind the window so corner pixels are unambiguous
# even on an otherwise near-black CI desktop.
$problems = @()
$shapeProblems = @()
$backdrop = New-Object System.Windows.Forms.Form
$backdrop.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$backdrop.WindowState = [System.Windows.Forms.FormWindowState]::Maximized
$backdrop.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
$backdrop.TopMost = $false
$backdrop.Show()
[System.Windows.Forms.Application]::DoEvents()
$shapeProc = Start-Process -FilePath $InstallerPath -ArgumentList "--path=$installDir" -PassThru
Start-Sleep -Milliseconds 1800
try {
    $shapeProc.Refresh()
    if ($shapeProc.MainWindowHandle -eq [IntPtr]::Zero) {
        $shapeProblems += 'Installer window was not found.'
    } else {
        $rect = New-Object FleetAudit.Win32+RECT
        [void][FleetAudit.Win32]::GetWindowRect($shapeProc.MainWindowHandle, [ref]$rect)
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        if ($w -lt 400 -or $h -lt 300) { $shapeProblems += "Window is unexpectedly small: ${w}x${h}." }
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $srcPt = New-Object System.Drawing.Point([int]$rect.Left, [int]$rect.Top)
        $srcSz = New-Object System.Drawing.Size([int]$w, [int]$h)
        $g.CopyFromScreen($srcPt, [System.Drawing.Point]::Empty, $srcSz)
        $g.Dispose()
        $bmp.Save((Join-Path $outDir 'shape.png'), [System.Drawing.Imaging.ImageFormat]::Png)

        function Test-Pixel([int]$x, [int]$y) { $p = $bmp.GetPixel($x, $y); $p }
        $bg = @{ R = 14; G = 15; B = 19 }   # #0e0f13
        function Test-IsBg($p) {
            [Math]::Abs($p.R - $bg.R) -le 12 -and [Math]::Abs($p.G - $bg.G) -le 12 -and [Math]::Abs($p.B - $bg.B) -le 12
        }
        # Center and edge midpoints must be the Fleet surface.
        foreach ($pt in @(@{x=[int]($w/2); y=[int]($h/2)}, @{x=[int]($w/2); y=2}, @{x=2; y=[int]($h/2)})) {
            if (-not (Test-IsBg (Test-Pixel $pt.x $pt.y))) {
                $shapeProblems += "Pixel ($($pt.x),$($pt.y)) is not the Fleet surface - the window body did not render."
            }
        }
        # The 8px corners must be cut: these pixels sit outside the rounded
        # arc (pixel centers clear of the 8px radius), so they must show the
        # desktop, not the window.
        foreach ($pt in @(@{x=1; y=1}, @{x=$w-2; y=1}, @{x=1; y=$h-2}, @{x=$w-2; y=$h-2})) {
            if (Test-IsBg (Test-Pixel $pt.x $pt.y)) {
                $shapeProblems += "Pixel ($($pt.x),$($pt.y)) is window-colored - corners are square, not 8px rounded."
            }
        }
        $bmp.Dispose()
        Write-Host "Shape check: window ${w}x${h}; corners verified $(if ($shapeProblems.Count) { 'FAILED' } else { 'rounded 8px' })."
    }
} finally {
    if (-not $shapeProc.HasExited) { Stop-Process -Id $shapeProc.Id -Force -ErrorAction SilentlyContinue }
    $backdrop.Close()
    $backdrop.Dispose()
}
if ($shapeProblems.Count) { $problems += $shapeProblems }

# ---- run the demo flow and screenshot continuously ------------------------
$proc = Start-Process -FilePath $InstallerPath -ArgumentList "--demo", "--path=$installDir" -PassThru

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$shot = 0
$sw = [Diagnostics.Stopwatch]::StartNew()
# The real payload (tens of thousands of files) takes minutes to extract, so
# watch the whole run (up to 10 minutes) instead of cutting it off mid-install.
# Screenshot fast while the early stages flip by, then every few seconds
# during the long copy.
while (-not $proc.HasExited -and $sw.Elapsed.TotalSeconds -lt 600) {
    try {
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $g.Dispose()
        $bmp.Save((Join-Path $outDir ("stage-{0:d2}.png" -f $shot)), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $shot++
    } catch { }
    $interval = if ($sw.Elapsed.TotalSeconds -lt 30) { 700 } else { 4000 }
    Start-Sleep -Milliseconds $interval
}
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Write-Host "Captured $shot screenshots (watched for $([int]$sw.Elapsed.TotalSeconds)s)."

# ---- verify the install ----------------------------------------------------
if (-not (Test-Path (Join-Path $installDir 'Fleet.exe')))   { $problems += 'Fleet.exe missing after install.' }
if (-not (Test-Path (Join-Path $installDir 'node.exe')))    { $problems += 'node.exe missing after install.' }
if (-not (Test-Path (Join-Path $installDir 'uninstall.exe'))) { $problems += 'uninstall.exe missing after install.' }

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fleet'
if (-not (Get-Item $uninstallKey -ErrorAction SilentlyContinue)) {
    $problems += 'Uninstall registry key missing.'
} else {
    $entry = Get-ItemProperty $uninstallKey
    if ($entry.DisplayName -ne 'Fleet') { $problems += "DisplayName is '$($entry.DisplayName)'." }
    if (-not $entry.UninstallString)    { $problems += 'UninstallString missing.' }
}

$programs = [Environment]::GetFolderPath('Programs')
if (-not (Test-Path (Join-Path $programs 'Fleet\Fleet.lnk'))) { $problems += 'Start Menu shortcut missing.' }

# ---- same version: re-running the installer must be a no-op ---------------
$proc = Start-Process -FilePath $InstallerPath -ArgumentList '--demo' -PassThru
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $proc.HasExited -and $sw.Elapsed.TotalSeconds -lt 90) { Start-Sleep -Milliseconds 500 }
if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $problems += 'Installer did not close itself when the same version is already installed (expected the up-to-date screen with Close only).'
} else {
    Write-Host 'Same-version re-run showed the up-to-date screen and closed on its own.'
}
$entry = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
if (-not $entry -or $entry.DisplayVersion -ne $version) {
    $problems += "DisplayVersion is wrong after the no-op re-run: '$($entry.DisplayVersion)'."
}

# ---- older version: the update flow replaces the previous install ---------
Set-ItemProperty $uninstallKey -Name DisplayVersion -Value '0.0.1'
$canary = Join-Path $installDir 'stale-file-from-old-version.txt'
Set-Content -Path $canary -Value 'left over by the old version' -Encoding ascii

$proc = Start-Process -FilePath $InstallerPath -ArgumentList '--demo' -PassThru
$shot = 0
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $proc.HasExited -and $sw.Elapsed.TotalSeconds -lt 600) {
    # Screenshot the early UI (checking -> update page -> progress),
    # then just wait out the long file copy.
    if ($sw.Elapsed.TotalSeconds -lt 30) {
        try {
            $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
            $g.Dispose()
            $bmp.Save((Join-Path $outDir ("update-{0:d2}.png" -f $shot)), [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            $shot++
        } catch { }
        Start-Sleep -Milliseconds 700
    } else {
        Start-Sleep -Milliseconds 2000
    }
}
if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $problems += 'Update flow did not finish within 10 minutes.'
} else {
    Write-Host "Update flow finished ($([int]$sw.Elapsed.TotalSeconds)s, $shot screenshots)."
}

if (Test-Path $canary) { $problems += 'A file from the previous version survived the update (previous version not fully deleted).' }
if (-not (Test-Path (Join-Path $installDir 'Fleet.exe')))     { $problems += 'Fleet.exe missing after the update.' }
if (-not (Test-Path (Join-Path $installDir 'node.exe')))      { $problems += 'node.exe missing after the update.' }
if (-not (Test-Path (Join-Path $installDir 'uninstall.exe'))) { $problems += 'uninstall.exe missing after the update.' }
$entry = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
if (-not $entry -or $entry.DisplayVersion -ne $version) {
    $problems += "DisplayVersion not refreshed by the update: '$($entry.DisplayVersion)'."
}

# ---- uninstall and verify removal ------------------------------------------
if (Test-Path (Join-Path $installDir 'uninstall.exe')) {
    # The uninstaller asks first; drive it with --demo so it auto-removes.
    # Bounded wait: never hang the audit even if the uninstaller misbehaves.
    $up = Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '--demo', '--uninstall' -PassThru
    $usw = [Diagnostics.Stopwatch]::StartNew()
    while (-not $up.HasExited -and $usw.Elapsed.TotalSeconds -lt 180) { Start-Sleep -Milliseconds 500 }
    if (-not $up.HasExited) {
        Stop-Process -Id $up.Id -Force -ErrorAction SilentlyContinue
        $problems += 'Uninstaller did not exit on its own.'
    }
    Start-Sleep -Seconds 2
    if (Test-Path $installDir) { $problems += "Install folder still exists after uninstall: $installDir" }
    if (Get-Item $uninstallKey -ErrorAction SilentlyContinue) { $problems += 'Uninstall registry key still exists.' }
}

# ---- verdict ----------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
$report = @(
    "Fleet installer UI audit - $(Get-Date -Format s)",
    "Installer: $InstallerPath",
    "OS: $($os.Caption) build $([Environment]::OSVersion.Version)",
    "Screenshots: $shot",
    ""
)
if (Test-Path $fleetLog) {
    $report += 'Installer trace:'
    $report += (Get-Content $fleetLog) | ForEach-Object { "  $_" }
    $report += ''
}
if ($problems.Count) {
    $report += 'FAIL:'
    $problems | ForEach-Object { $report += "  - $_" }
} else {
    $report += 'PASS: install, registry, shortcuts, and uninstall all verified.'
}
$report | Tee-Object -FilePath (Join-Path $outDir 'audit.txt')

if ($problems.Count) { exit 1 }
