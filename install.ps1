[CmdletBinding()]
param(
    [string]$Version = $env:APEX_CODE_INSTALL_VERSION
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repository = "Fchery87/apex-code"
$releasesUrl = "https://github.com/$repository/releases"
$versionPattern = '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$'

function Fail([string]$Message) {
    throw "apex-code installer: $Message"
}

function Resolve-Version {
    if ([string]::IsNullOrWhiteSpace($Version)) {
        try {
            $redirect = Invoke-WebRequest -Uri "$releasesUrl/latest" -MaximumRedirection 10
        } catch {
            Fail "could not resolve the latest GitHub Release: $($_.Exception.Message)"
        }
        $script:Version = $redirect.BaseResponse.ResponseUri.Segments[-1].TrimEnd('/').TrimStart('v')
    }

    if ($Version -notmatch $versionPattern) {
        Fail "invalid release version '$Version'"
    }
    return $Version
}

function Resolve-Architecture {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($architecture) {
        "X64" { return "x64" }
        "Arm64" { return "arm64" }
        default { Fail "unsupported Windows architecture '$architecture'" }
    }
}

function Get-ManifestHash([string]$ManifestPath, [string]$AssetName) {
    $matches = @(Get-Content -LiteralPath $ManifestPath | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($AssetName))$" })
    if ($matches.Count -ne 1) {
        Fail "checksum manifest does not contain one valid hash for $AssetName"
    }
    return $matches[0].Substring(0, 64)
}

function Add-UserPath([string]$Directory) {
    $current = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
    $entries = @($current -split ";" | Where-Object { $_ })
    if (-not [System.Linq.Enumerable]::Contains([string[]]$entries, $Directory, [System.StringComparer]::OrdinalIgnoreCase)) {
        [Environment]::SetEnvironmentVariable("Path", (($entries + $Directory) -join ";"), [EnvironmentVariableTarget]::User)
    }
}

$resolvedVersion = Resolve-Version
$assetName = "apex-code-windows-$(Resolve-Architecture).zip"
$tag = "v$resolvedVersion"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "apex-code-install-$([guid]::NewGuid())"
$archivePath = Join-Path $temporaryDirectory $assetName
$manifestPath = Join-Path $temporaryDirectory "SHA256SUMS"
$extractedDirectory = Join-Path $temporaryDirectory "extracted"
$installParent = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) "Apex Code"
$installDirectory = Join-Path $installParent "bin"
$stagingDirectory = Join-Path $installParent ".install-$([guid]::NewGuid())"
$backupDirectory = Join-Path $installParent ".backup-$([guid]::NewGuid())"

try {
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    Invoke-WebRequest -Uri "$releasesUrl/download/$tag/SHA256SUMS" -OutFile $manifestPath
    Invoke-WebRequest -Uri "$releasesUrl/download/$tag/$assetName" -OutFile $archivePath

    $expectedHash = Get-ManifestHash $manifestPath $assetName
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        Fail "checksum mismatch for $assetName; installation aborted"
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractedDirectory -Force
    if (-not (Test-Path -LiteralPath (Join-Path $extractedDirectory "apex-code.exe") -PathType Leaf)) {
        Fail "release archive does not contain apex-code.exe"
    }

    New-Item -ItemType Directory -Path $installParent -Force | Out-Null
    Move-Item -LiteralPath $extractedDirectory -Destination $stagingDirectory
    if (Test-Path -LiteralPath $installDirectory) {
        Move-Item -LiteralPath $installDirectory -Destination $backupDirectory
    }
    Move-Item -LiteralPath $stagingDirectory -Destination $installDirectory
    Remove-Item -LiteralPath $backupDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Add-UserPath $installDirectory

    Write-Host "Installed Apex Code $resolvedVersion to $installDirectory"
    Write-Host "Open a new PowerShell, Command Prompt, Windows Terminal, or Git Bash session, then run: apex-code --version"
} finally {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
