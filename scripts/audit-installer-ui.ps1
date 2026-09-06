param(
    [string] $InstallerPath = '',
    [string] $InstallerUrl = '',
    [string] $ExpectedSha512 = 'skip'
)

# Audits the custom Fleet installer UI on real Windows:
#   1. Runs FleetInstaller.exe with --demo (drives itself through every stage:
#      Hello -> folder -> Confirm -> Install Fleet -> done) and screenshots
#      the screen throughout.
#   2. Verifies the install actually happened: files, registry, shortcuts.
#   3. Uninstalls and verifies removal.
# Output lands in .\audit-output\

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'audit-output'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

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

$installDir = Join-Path $env:TEMP ('FleetAudit-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

# ---- run the demo flow and screenshot continuously ------------------------
$proc = Start-Process -FilePath $InstallerPath -ArgumentList "--demo", "--path=$installDir" -PassThru

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$shot = 0
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 30) {
    if ($proc.HasExited) { break }
    try {
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $g.Dispose()
        $bmp.Save((Join-Path $outDir ("stage-{0:d2}.png" -f $shot)), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $shot++
    } catch { }
    Start-Sleep -Milliseconds 700
}
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Write-Host "Captured $shot screenshots."

# ---- verify the install ----------------------------------------------------
$problems = @()
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

# ---- uninstall and verify removal ------------------------------------------
if (Test-Path (Join-Path $installDir 'uninstall.exe')) {
    # The uninstaller asks first; drive it with --demo so it auto-removes.
    Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '--demo', '--uninstall' -Wait
    Start-Sleep -Seconds 2
    if (Test-Path $installDir) { $problems += "Install folder still exists after uninstall: $installDir" }
    if (Get-Item $uninstallKey -ErrorAction SilentlyContinue) { $problems += 'Uninstall registry key still exists.' }
}

# ---- verdict ----------------------------------------------------------------
$report = @(
    "Fleet installer UI audit - $(Get-Date -Format s)",
    "Installer: $InstallerPath",
    "Screenshots: $shot",
    ""
)
if ($problems.Count) {
    $report += 'FAIL:'
    $problems | ForEach-Object { $report += "  - $_" }
} else {
    $report += 'PASS: install, registry, shortcuts, and uninstall all verified.'
}
$report | Tee-Object -FilePath (Join-Path $outDir 'audit.txt')

if ($problems.Count) { exit 1 }
