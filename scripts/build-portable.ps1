# Deterministic portable build -> dist\Fleet\Fleet.exe
# Avoids electron-builder's winCodeSign step (which needs symlink privilege on
# Windows). Produces a runnable, correctly-named Fleet.exe with the app icon.
#   npm run build

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root 'dist\Fleet'
$electronDist = Join-Path $root 'node_modules\electron\dist'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

if (-not (Test-Path $electronDist)) { throw "Electron not installed. Run npm install first." }

Write-Host "Cleaning $out"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

Write-Host "Copying Electron runtime..."
robocopy $electronDist $out /E /NFL /NDL /NJH /NJS /NP | Out-Null

# Rename the Electron binary to Fleet.exe
Rename-Item (Join-Path $out 'electron.exe') 'Fleet.exe'

# Remove the default app so Electron loads ours from resources\app
Remove-Item (Join-Path $out 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

# Stage the application into resources\app
$app = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $root 'package.json') $app
robocopy (Join-Path $root 'src')   (Join-Path $app 'src')   /E /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $root 'build') (Join-Path $app 'build') /E /NFL /NDL /NJH /NJS /NP | Out-Null
# Copy the complete production dependency closure (koffi, electron-updater and
# their runtime dependencies) while keeping development/build packages out.
New-Item -ItemType Directory -Force (Join-Path $app 'node_modules') | Out-Null
$prodDirs = & npm.cmd ls --omit=dev --all --parseable 2>$null
$modulesRoot = Join-Path $root 'node_modules'
foreach ($dep in $prodDirs) {
  if (-not $dep -or $dep -eq $root -or -not $dep.StartsWith($modulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
  $relative = $dep.Substring($modulesRoot.Length).TrimStart('\')
  if (-not $relative) { continue }
  robocopy $dep (Join-Path (Join-Path $app 'node_modules') $relative) /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

# Set icon + version metadata on the exe (rcedit ships with electron-builder's cache)
$rcedit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($rcedit) {
  $exe = Join-Path $out 'Fleet.exe'
  $ico = Join-Path $root 'build\icon.ico'
  $rcArgs = @(
    $exe, '--set-icon', $ico,
    '--set-version-string', 'ProductName', 'Fleet',
    '--set-version-string', 'FileDescription', 'Fleet - Roblox multi-launcher',
    '--set-version-string', 'CompanyName', 'Toluwa',
    '--set-version-string', 'OriginalFilename', 'Fleet.exe',
    '--set-version-string', 'LegalCopyright', 'MIT License',
    '--set-file-version', "$version.0", '--set-product-version', "$version.0"
  )
  & $rcedit.FullName @rcArgs 2>&1 | Out-Null
  Write-Host "Applied icon + metadata via rcedit"
} else {
  Write-Host "rcedit not found - exe built without custom icon (still named Fleet.exe)"
}

Write-Host ""
Write-Host "Built: $(Join-Path $out 'Fleet.exe')"
Write-Host "Run it directly, or zip dist\Fleet as a portable distribution."
