# Export ChestLab as an independent GitHub repository.
# Example: powershell -NoProfile -File chest-tracker/export-standalone.ps1
# Optional: -RemoteUrl https://github.com/USERNAME/fortnite-chest-tracker.git
# Does not modify or delete the original repository.
param(
    [string] $Destination = "",
    [string] $RemoteUrl = ""
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = Join-Path (Split-Path -Parent $sourceRoot) 'fortnite-chest-tracker'
}
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) {
    throw "Destination already exists: $Destination. Choose an unused -Destination. No files were overwritten."
}

function Write-Utf8File([string]$filePath, [string]$textValue) {
    $folder = Split-Path -Parent $filePath
    if (!(Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }
    [IO.File]::WriteAllText($filePath, $textValue, (New-Object System.Text.UTF8Encoding($false)))
}
function Copy-ProjectPath([string]$relativePath) {
    $source = Join-Path $sourceRoot $relativePath
    $target = Join-Path $Destination $relativePath
    if (!(Test-Path -LiteralPath $source)) {
        throw "Missing required source: $relativePath. Switch to feature/standalone-chest-tracker and pull."
    }
    $parent = Split-Path -Parent $target
    if (!(Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

Write-Host "Creating clean ChestLab project in $Destination"
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
foreach ($entry in @(
    'chest-tracker', 'vendor/parser', 'src/downloader.js',
    'scripts/patch-downloader-cache.js', '.github/workflows/chest-tracker.yml'
)) { Copy-ProjectPath $entry }

# Avoid copying existing build artifacts, dependencies, and version-control metadata.
Get-ChildItem -LiteralPath $Destination -Directory -Recurse -Force |
    Where-Object { $_.Name -in @('bin', 'obj', 'node_modules', '.git') } |
    Sort-Object FullName -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

$package = @'
{
  "name": "fortnite-chest-tracker",
  "version": "0.1.0",
  "private": true,
  "description": "Standalone Fortnite replay chest tracker and local dashboard.",
  "scripts": {
    "start": "node chest-tracker/dashboard/server.js",
    "watch": "node chest-tracker/watch.js",
    "test": "node --test chest-tracker/*.test.js chest-tracker/dashboard/*.test.js",
    "build": "dotnet build chest-tracker/chest-tracker.csproj -c Release",
    "postinstall": "node scripts/patch-downloader-cache.js"
  },
  "dependencies": {
    "fortnite-replay-downloader": "^3.0.8"
  }
}
'@
Write-Utf8File (Join-Path $Destination 'package.json') $package

$ignore = @'
node_modules/
data/
chest-tracker/bin/
chest-tracker/obj/
vendor/parser/src/**/bin/
vendor/parser/src/**/obj/
**/cmds/
**/*.dump
**/failed-properties
*.log
'@
Write-Utf8File (Join-Path $Destination '.gitignore') $ignore

$readme = @'
# ChestLab - Fortnite Chest Tracker

An independent, single-player Fortnite chest tracker with a local web dashboard.
It analyzes completed Fortnite .replay files, can attempt to download a server
replay by session ID, and keeps a local searchable match history.

## Start

Requirements: Node.js 18+, npm, .NET 10 SDK, and Git.

    npm.cmd install
    npm.cmd run build
    npm.cmd start

Open http://127.0.0.1:3407 on the same PC. The dashboard can monitor
%LOCALAPPDATA%\FortniteGame\Saved\Demos when the folder exists, or import a
completed replay from the browser. An observed chest count may be entered
for validation. Export CSV and see per-match chest events.

    npm.cmd test

## Important

The software builds and automated tests pass, but actual chest-event accuracy
needs a real current-season replay. Unknown player ownership is not zero chests.
Data is processed locally and kept under data/chest-tracker/.
The patched MIT-licensed replay parser is included under vendor/parser; preserve
its license notices. See chest-tracker/README.md for additional CLI options.
'@
Write-Utf8File (Join-Path $Destination 'README.md') $readme

# The original CI only builds the feature branch; the standalone repo uses main.
$workflowFile = Join-Path $Destination '.github/workflows/chest-tracker.yml'
$workflow = [IO.File]::ReadAllText($workflowFile)
$workflow = $workflow.Replace("      - 'feature/standalone-chest-tracker'", '      - main')
Write-Utf8File $workflowFile $workflow

Push-Location $Destination
try {
    & git init -b main
    if ($LASTEXITCODE -ne 0) { throw 'git init failed.' }
    & git add -A
    if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }
    & git commit -m 'Initial standalone ChestLab repository'
    if ($LASTEXITCODE -ne 0) {
        throw 'Git commit failed. Configure git user.name and user.email, then commit in the new folder.'
    }
    if (![string]::IsNullOrWhiteSpace($RemoteUrl)) {
        & git remote add origin $RemoteUrl
        if ($LASTEXITCODE -ne 0) { throw 'Could not add remote.' }
        & git push -u origin main
        if ($LASTEXITCODE -ne 0) { throw 'Push failed. Create an empty GitHub repository and confirm you have access.' }
        Write-Host "Published ChestLab to $RemoteUrl" -ForegroundColor Green
    } else {
        Write-Host 'Standalone ChestLab repository created locally.' -ForegroundColor Green
        Write-Host 'Create an EMPTY GitHub repository at https://github.com/new named fortnite-chest-tracker.'
        Write-Host 'Then run from the new project folder:'
        Write-Host '  git remote add origin https://github.com/YOUR_USERNAME/fortnite-chest-tracker.git'
        Write-Host '  git push -u origin main'
    }
} finally {
    Pop-Location
}
