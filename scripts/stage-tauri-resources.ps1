$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$resources = Join-Path $root 'src-tauri\resources'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force $resources | Out-Null
Copy-Item $nodeExe (Join-Path $resources 'node.exe') -Force

Write-Host "Staged Node runtime: $(Join-Path $resources 'node.exe')"
