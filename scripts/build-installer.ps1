$ErrorActionPreference = 'Stop'

# Builds the real Fleet installer app and packs the portable distribution
# into it. The result is a single self-extracting FleetInstaller.exe - a real
# Win32 application (one dark Fleet-branded page, real native controls, no
# wizard) whose content swaps in place:
#   install form -> Install Fleet -> progress -> done.
#
# Layout on disk:  [ fleet-setup.exe ][ zip payload ][ FLEETSTP magic ][ u64 start ]

$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root 'installer'
$releaseDir = Join-Path $root 'dist'
$portableDir = Join-Path $releaseDir 'Fleet'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

# 1. Build the portable distribution (Fleet.exe + node runtime + resources).
& (Join-Path $PSScriptRoot 'build-portable.ps1')
if (-not (Test-Path (Join-Path $portableDir 'Fleet.exe'))) { throw 'Portable build did not produce Fleet.exe.' }

# 2. Build the custom installer app.
$env:FLEET_VERSION = $version
Push-Location $installerDir
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "Installer cargo build failed ($LASTEXITCODE)." }
} finally { Pop-Location }
$setupExe = Join-Path $installerDir 'target\release\fleet-setup.exe'
if (-not (Test-Path $setupExe)) { throw 'fleet-setup.exe was not created.' }

# 3. Stage the payload: the portable dist + the payload-less uninstaller +
#    (optionally) the WebView2 bootstrapper, then zip it.
$staging = Join-Path $releaseDir 'installer-payload'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
robocopy $portableDir $staging /E /NFL /NDL /NJH /NJS /NP | Out-Null

Copy-Item $setupExe (Join-Path $staging 'uninstall.exe') -Force

$bootstrapper = Join-Path $staging 'WebView2Setup.exe'
$wantBootstrapper = $true
if ($wantBootstrapper -and -not (Test-Path $bootstrapper)) {
  try {
    Write-Host 'Downloading the WebView2 bootstrapper...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrapper -UseBasicParsing
  } catch {
    Write-Warning "Could not download the WebView2 bootstrapper; the installer will rely on the system runtime."
  }
}

$payloadZip = Join-Path $releaseDir 'installer-payload.zip'
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $payloadZip -CompressionLevel Optimal

# 4. Attach the payload to the installer exe.
$exeBytes = [IO.File]::ReadAllBytes($setupExe)
$zipBytes = [IO.File]::ReadAllBytes($payloadZip)
$trailer = New-Object byte[] 16
[Array]::Copy([Text.Encoding]::ASCII.GetBytes('FLEETSTP'), 0, $trailer, 0, 8)
[Array]::Copy([BitConverter]::GetBytes([Int64]$exeBytes.Length), 0, $trailer, 8, 8)

$installerExe = Join-Path $releaseDir 'FleetInstaller.exe'
$out = New-Object byte[] ($exeBytes.Length + $zipBytes.Length + 16)
[Array]::Copy($exeBytes, 0, $out, 0, $exeBytes.Length)
[Array]::Copy($zipBytes, 0, $out, $exeBytes.Length, $zipBytes.Length)
[Array]::Copy($trailer, 0, $out, $exeBytes.Length + $zipBytes.Length, 16)
[IO.File]::WriteAllBytes($installerExe, $out)

Remove-Item $payloadZip -Force
Remove-Item $staging -Recurse -Force

Write-Host ""
Write-Host "Installer: $installerExe ($((Get-Item $installerExe).Length / 1MB) MB, Fleet $version)"
Write-Host "Payload:   portable distribution + uninstall.exe$(if (Test-Path $bootstrapper) { ' + WebView2Setup.exe' })"
