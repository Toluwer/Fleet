$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
$bundle = Join-Path $root 'src-tauri\target\release\bundle'
$nsisBundle = Join-Path $bundle 'nsis'
$releaseDir = Join-Path $root 'dist'
$releaseInstaller = Join-Path $releaseDir 'FleetInstaller.exe'

if (-not (Test-Path $tauri)) { throw 'Tauri CLI is not installed. Run npm install first.' }

Write-Host 'Building Tauri installer bundles...'
& $tauri build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)." }
if (-not (Test-Path $bundle)) { throw 'Tauri bundle output was not created.' }

$installer = Get-ChildItem $nsisBundle -Filter '*-setup.exe' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $installer) { throw 'Tauri did not create an NSIS installer.' }

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Copy-Item -LiteralPath $installer.FullName -Destination $releaseInstaller -Force

Write-Host "Bundle output: $bundle"
Get-ChildItem $bundle -Recurse -File | Select-Object FullName, Length, LastWriteTime
Write-Host "Release installer: $releaseInstaller"
