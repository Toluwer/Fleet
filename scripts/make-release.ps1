$ErrorActionPreference = 'Stop'

# Generates dist\latest.yml for a release from the freshly built installer.
# Run scripts\build-installer.ps1 (and optionally build-portable.ps1) first.
# The in-app updater verifies the sha512 below BEFORE running the installer,
# so this hash must match the exact FleetInstaller.exe you upload to GitHub.

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root 'dist'
$installer = Join-Path $releaseDir 'FleetInstaller.exe'

if (-not (Test-Path $installer)) { throw 'dist\FleetInstaller.exe not found. Run scripts\build-installer.ps1 first.' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$size = (Get-Item $installer).Length
$hex = (Get-FileHash -Algorithm SHA512 -LiteralPath $installer).Hash
if ($hex.Length -ne 128) { throw "Unexpected SHA-512 length ($($hex.Length))." }
$bytes = New-Object byte[] 64
for ($i = 0; $i -lt 64; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
$sha512 = [Convert]::ToBase64String($bytes)
$releaseDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$yml = "version: $version`n" +
       "path: FleetInstaller.exe`n" +
       "url: FleetInstaller.exe`n" +
       "sha512: $sha512`n" +
       "size: $size`n" +
       "releaseDate: '$releaseDate'`n"

$outFile = Join-Path $releaseDir 'latest.yml'
# UTF-8 without BOM; the updater parser accepts either, but no-BOM keeps the feed clean.
[System.IO.File]::WriteAllText($outFile, $yml, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Wrote $outFile"
Write-Host 'Upload to the GitHub release for this version:'
Write-Host '  FleetInstaller.exe  (required - the updater downloads this asset)'
Write-Host '  latest.yml          (required - version/sha512/size the updater verifies)'
Write-Host '  FleetPortable_<version>_x64.zip (optional, manual download)'
Write-Host ''
Write-Host 'Contents:'
Get-Content $outFile
