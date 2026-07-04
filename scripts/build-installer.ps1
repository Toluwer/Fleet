$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
$bundle = Join-Path $root 'src-tauri\target\release\bundle'

if (-not (Test-Path $tauri)) { throw 'Tauri CLI is not installed. Run npm install first.' }

Write-Host 'Building Tauri installer bundles...'
& $tauri build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)." }
if (-not (Test-Path $bundle)) { throw 'Tauri bundle output was not created.' }

Write-Host "Bundle output: $bundle"
Get-ChildItem $bundle -Recurse -File | Select-Object FullName, Length, LastWriteTime
