param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "release"))
$packageJsonPath = Join-Path $projectRoot "package.json"
$packageInfo = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$packageInfo.version
$folderName = "QCpet-v$version-windows-x64"
$stagePath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot $folderName))
$zipPath = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot "$folderName.zip"))
$builtExe = Join-Path $projectRoot "src-tauri\target\release\qcpet.exe"
$sourceModels = Join-Path $projectRoot "public\models"
$manifestPath = Join-Path $sourceModels "manifest.json"

function Assert-DirectChild([string]$Path, [string]$Parent) {
    $prefix = $Parent.TrimEnd('\') + '\'
    if (-not $Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the release directory: $Path"
    }
}

Assert-DirectChild -Path $stagePath -Parent $releaseRoot
Assert-DirectChild -Path $zipPath -Parent $releaseRoot

if (-not $SkipBuild) {
    if (Get-Process -Name "qcpet" -ErrorAction SilentlyContinue) {
        throw "QCpet is running. Exit it from the context menu before building."
    }

    Push-Location $projectRoot
    try {
        & npm.cmd run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri release build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
    throw "Release executable was not found: $builtExe"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Bundled model manifest was not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$modelFiles = @($manifest.files)
if ($modelFiles.Count -eq 0 -and $manifest.file) {
    $modelFiles = @([string]$manifest.file)
}
if ($modelFiles.Count -eq 0) {
    throw "The bundled model manifest contains no files."
}

foreach ($modelFile in $modelFiles) {
    $name = [string]$modelFile
    if ([System.IO.Path]::GetFileName($name) -ne $name) {
        throw "The bundled model manifest contains an invalid file name: $name"
    }
    $source = Join-Path $sourceModels $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "A bundled model file does not exist: $source"
    }
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
if ([System.IO.Directory]::Exists($stagePath)) {
    [System.IO.Directory]::Delete($stagePath, $true)
}
if ([System.IO.File]::Exists($zipPath)) {
    [System.IO.File]::Delete($zipPath)
}

$stageModels = Join-Path $stagePath "models"
New-Item -ItemType Directory -Path $stageModels -Force | Out-Null
Copy-Item -LiteralPath $builtExe -Destination (Join-Path $stagePath "QCpet.exe")
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stageModels "manifest.json")
foreach ($modelFile in $modelFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceModels ([string]$modelFile)) -Destination $stageModels
}
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $stagePath
Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination $stagePath

Compress-Archive -Path (Join-Path $stagePath "*") -DestinationPath $zipPath -CompressionLevel Optimal

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "[OK] Portable directory: $stagePath"
Write-Host "[OK] Release archive: $zipPath"
Write-Host "[OK] SHA256: $hash"
