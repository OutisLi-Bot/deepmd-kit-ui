# SPDX-License-Identifier: LGPL-3.0-or-later
[CmdletBinding()]
param(
    [string] $TargetTriple = "x86_64-pc-windows-msvc",
    [string] $AppVersion = ""
)

$ErrorActionPreference = "Stop"
$DesktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ReleaseDir = Join-Path $DesktopRoot "target\$TargetTriple\release"
$RuntimeDir = Join-Path $DesktopRoot "src-tauri\resources\runtime"
$ManifestPath = Join-Path $RuntimeDir "deepmd-ui-runtime.json"
$InstallerScript = Join-Path $DesktopRoot "installer\windows\deepmd-studio.iss"
$RuntimeManager = Join-Path $DesktopRoot "scripts\runtime_manager.py"
$OutputDir = Join-Path $ReleaseDir "bundle\inno"
$BridgeSourceDir = Join-Path $DesktopRoot "python\deepmd_ui"
$BridgeRuntimeDir = Join-Path $RuntimeDir "Lib\site-packages\deepmd_ui"

if (-not $AppVersion) {
    $Package = Get-Content (Join-Path $DesktopRoot "package.json") -Raw | ConvertFrom-Json
    $AppVersion = $Package.version
}

$RequiredFiles = @(
    (Join-Path $ReleaseDir "deepmd-studio.exe"),
    (Join-Path $ReleaseDir "dpstudio.exe"),
    (Join-Path $RuntimeDir "python.exe"),
    $ManifestPath,
    (Join-Path $BridgeSourceDir "bridge.py"),
    $RuntimeManager,
    $InstallerScript
)
foreach ($Path in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required installer input is missing: $Path"
    }
}

$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
if ($Manifest.platform -ne "windows" -or $Manifest.accelerator -notlike "cu*") {
    throw "The Windows installer requires a CUDA runtime manifest."
}
foreach ($PackageName in @("deepmd-kit", "torch", "jax", "jaxlib", "e3nn", "vesin", "triton-windows")) {
    if (-not $Manifest.packages.PSObject.Properties.Name.Contains($PackageName)) {
        throw "Bundled runtime is missing $PackageName."
    }
}

# Keep the lightweight Studio bridge in sync without rebuilding the 1.7 GB
# scientific runtime. The bridge imports all schema and validation behavior
# from the already bundled DeePMD package.
New-Item -ItemType Directory -Force -Path $BridgeRuntimeDir | Out-Null
Copy-Item -LiteralPath (Join-Path $BridgeSourceDir "__init__.py") -Destination $BridgeRuntimeDir -Force
Copy-Item -LiteralPath (Join-Path $BridgeSourceDir "bridge.py") -Destination $BridgeRuntimeDir -Force

$IsccCandidates = @(
    $env:ISCC_EXE,
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
if (-not $IsccCandidates) {
    throw "Inno Setup 6 compiler (ISCC.exe) was not found."
}
$IsccExe = @($IsccCandidates)[0]

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Get-ChildItem -LiteralPath $OutputDir -File | Where-Object {
    $_.Name -like "DeePMD-Studio-*-Windows-x64-CUDA13-Setup*" -or
    $_.Name -like "DeepMD-Studio-*-Windows-x64-CUDA13-Setup*" -or
    $_.Name -eq "SHA256SUMS.json"
} | Remove-Item -Force
& $IsccExe "/DAppVersion=$AppVersion" "/DTargetTriple=$TargetTriple" $InstallerScript
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup failed with exit code $LASTEXITCODE."
}

$Media = Get-ChildItem -LiteralPath $OutputDir -File |
    Where-Object { $_.Name -eq "DeePMD-Studio-$AppVersion-Windows-x64-CUDA13-Setup.exe" } |
    Sort-Object Name
if ($Media.Count -ne 1 -or $Media[0].Extension -ne ".exe") {
    throw "The expected single-file offline installer was not generated."
}

$Inventory = foreach ($File in $Media) {
    [ordered]@{
        name = $File.Name
        bytes = $File.Length
        sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$Inventory | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir "SHA256SUMS.json") -Encoding UTF8
$Media | Select-Object Name, Length, FullName
