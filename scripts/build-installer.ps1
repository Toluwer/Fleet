$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$unpacked = Join-Path $dist 'win-unpacked'
$builder = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

if (-not (Test-Path $builder)) { throw 'electron-builder is not installed. Run npm install first.' }

Write-Host 'Cleaning previous distributables...'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist | Out-Null

Write-Host 'Packaging production app and dependencies...'
& $builder --dir --win --x64 '-c.win.signAndEditExecutable=false'
if ($LASTEXITCODE -ne 0) { throw "electron-builder packaging failed ($LASTEXITCODE)." }

# signAndEditExecutable=false avoids electron-builder's cross-platform signing
# archive, whose macOS symlinks require Windows Developer Mode. Apply the icon
# and version metadata with the cached Windows rcedit binary instead.
$rcedit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$exe = Join-Path $unpacked 'Fleet.exe'
if (-not (Test-Path $exe)) { throw 'Packaged Fleet.exe was not created.' }
if ($rcedit) {
  & $rcedit.FullName $exe `
    '--set-icon' (Join-Path $root 'build\icon.ico') `
    '--set-version-string' 'ProductName' 'Fleet' `
    '--set-version-string' 'FileDescription' 'Fleet - Roblox multi-launcher' `
    '--set-version-string' 'CompanyName' 'Toluwa' `
    '--set-version-string' 'OriginalFilename' 'Fleet.exe' `
    '--set-file-version' "$version.0" `
    '--set-product-version' "$version.0"
  if ($LASTEXITCODE -ne 0) { throw "rcedit failed ($LASTEXITCODE)." }
} else {
  Write-Warning 'rcedit was not found; continuing with the default executable icon.'
}

# --prepackaged skips electron-builder's normal app-update.yml injection, so
# copy the same public GitHub provider configuration into the final resources.
Copy-Item (Join-Path $root 'build\app-update.yml') (Join-Path $unpacked 'resources\app-update.yml') -Force

Write-Host 'Building branded NSIS installer and update metadata...'
& $builder --prepackaged $unpacked --win nsis --x64 '-c.win.signAndEditExecutable=false'
if ($LASTEXITCODE -ne 0) { throw "NSIS installer build failed ($LASTEXITCODE)." }

$installer = Join-Path $dist 'FleetInstaller.exe'
$metadata = Join-Path $dist 'latest.yml'
if (-not (Test-Path $installer)) { throw 'FleetInstaller.exe was not created.' }
if (-not (Test-Path $metadata)) { throw 'latest.yml was not created; automatic updates would not work.' }
if (-not ((Get-Content $metadata -Raw) -match 'url:\s+FleetInstaller\.exe')) {
  throw 'latest.yml does not point to the permanent FleetInstaller.exe asset.'
}

Write-Host "Built installer: $installer"
Write-Host "Update metadata: $metadata"
Write-Host 'Permanent download URL: https://github.com/Toluwer/Fleet/releases/latest/download/FleetInstaller.exe'
