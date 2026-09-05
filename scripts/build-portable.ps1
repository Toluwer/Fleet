$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'dist\Fleet'
$tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
$releaseExe = Join-Path $root 'src-tauri\target\release\fleet.exe'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path $tauri)) { throw 'Tauri CLI is not installed. Run npm install first.' }

Write-Host 'Building Tauri release...'
& $tauri build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)." }
if (-not (Test-Path $releaseExe)) { throw 'Tauri release executable was not created.' }

Write-Host "Cleaning $out"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item $releaseExe (Join-Path $out 'Fleet.exe') -Force
Copy-Item $nodeExe (Join-Path $out 'node.exe') -Force

# Temporary compatibility staging while the remaining JS service layer is
# ported to Rust. The Tauri shell is active; only the transitional Node
# backend is copied next to the portable executable.
New-Item -ItemType Directory -Force (Join-Path $out 'src') | Out-Null
robocopy (Join-Path $root 'src\main') (Join-Path $out 'src\main') /E /NFL /NDL /NJH /NJS /NP | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out 'node_modules') | Out-Null
$prodDirs = & npm.cmd ls --omit=dev --all --parseable 2>$null
$modulesRoot = Join-Path $root 'node_modules'
foreach ($dep in $prodDirs) {
  if (-not $dep -or $dep -eq $root -or -not $dep.StartsWith($modulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
  $relative = $dep.Substring($modulesRoot.Length).TrimStart('\')
  if (-not $relative) { continue }
  robocopy $dep (Join-Path (Join-Path $out 'node_modules') $relative) /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

Write-Host ""
Write-Host "Built: $(Join-Path $out 'Fleet.exe')"
Write-Host 'Run it directly, or zip dist\Fleet as a portable distribution.'
