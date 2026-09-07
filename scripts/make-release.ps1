$ErrorActionPreference = 'Stop'

# Generates dist\latest.yml for a release from the freshly built installer
# and portable package. Run scripts\build-installer.ps1 first.
#
# The feed carries TWO digests:
#   url/sha512/size        -> FleetInstaller.exe (evergreen installer asset;
#                             pre-1.5.14 clients download and run this)
#   portableUrl/portable*  -> FleetPortable_<version>_x64.zip (what the
#                             in-app self-updater downloads, verifies and
#                             installs without any installer window)
# Both must match the exact files uploaded to GitHub.

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root 'dist'
$installer = Join-Path $releaseDir 'FleetInstaller.exe'

if (-not (Test-Path $installer)) { throw 'dist\FleetInstaller.exe not found. Run scripts\build-installer.ps1 first.' }
if (-not (Test-Path (Join-Path $releaseDir 'Fleet'))) { throw 'dist\Fleet not found. Run scripts\build-installer.ps1 first.' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

# The portable zip the self-updater installs. Created HERE, once, so the
# digest below matches the uploaded asset byte for byte (a second
# Compress-Archive run would produce a different archive).
$portable = Join-Path $releaseDir "FleetPortable_${version}_x64.zip"
Compress-Archive -Path (Join-Path $releaseDir 'Fleet') -DestinationPath $portable -Force
if (-not (Test-Path $portable)) { throw 'The portable package was not created.' }

function Get-Sha512Base64([string]$file) {
  $hex = (Get-FileHash -Algorithm SHA512 -LiteralPath $file).Hash
  if ($hex.Length -ne 128) { throw "Unexpected SHA-512 length ($($hex.Length)) for $file." }
  $bytes = New-Object byte[] 64
  for ($i = 0; $i -lt 64; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  [Convert]::ToBase64String($bytes)
}

$size = (Get-Item $installer).Length
$sha512 = Get-Sha512Base64 $installer
$portableSize = (Get-Item $portable).Length
$portableSha512 = Get-Sha512Base64 $portable
$releaseDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$yml = "version: $version`n" +
       "path: FleetInstaller.exe`n" +
       "url: FleetInstaller.exe`n" +
       "sha512: $sha512`n" +
       "size: $size`n" +
       "portableUrl: FleetPortable_${version}_x64.zip`n" +
       "portableSha512: $portableSha512`n" +
       "portableSize: $portableSize`n" +
       "releaseDate: '$releaseDate'`n"

$outFile = Join-Path $releaseDir 'latest.yml'
# UTF-8 without BOM; the updater parser accepts either, but no-BOM keeps the feed clean.
[System.IO.File]::WriteAllText($outFile, $yml, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Wrote $outFile"
Write-Host 'Upload to the GitHub release for this version:'
Write-Host '  FleetInstaller.exe  (evergreen installer - pre-1.5.14 updaters download this)'
Write-Host '  latest.yml          (version + both digests the updater verifies)'
Write-Host "  FleetPortable_${version}_x64.zip (the in-app self-updater installs this)"
Write-Host ''
Write-Host 'Contents:'
Get-Content $outFile
