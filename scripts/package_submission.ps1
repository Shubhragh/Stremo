$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root "dist"
$stagingDir = Join-Path $distDir "scalastream_submission"
$zipPath = Join-Path $distDir "ScalaStream-submission.zip"

if (-not (Test-Path $distDir)) {
  New-Item -ItemType Directory -Path $distDir | Out-Null
}

if (Test-Path $stagingDir) {
  Remove-Item -Recurse -Force $stagingDir
}
if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}

New-Item -ItemType Directory -Path $stagingDir | Out-Null

$include = @(
  "docker-compose.yml",
  ".env.example",
  "README.md",
  "docs",
  "infra",
  "services",
  "web",
  "scripts/failure_demo.ps1",
  "scripts/upload_concurrency_test.js",
  "scripts/seed_synthetic_data.py"
)

foreach ($item in $include) {
  $source = Join-Path $root $item
  if (-not (Test-Path $source)) {
    continue
  }

  $destination = Join-Path $stagingDir $item
  $destinationParent = Split-Path -Parent $destination
  if (-not (Test-Path $destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }

  Copy-Item -Path $source -Destination $destination -Recurse -Force
}

Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $zipPath -Force

Write-Output "Created: $zipPath"
