[CmdletBinding()]
param(
  [ValidateSet("stable", "preview")]
  [string] $Channel = "stable",

  [string] $Version
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Channel -eq "preview") {
  if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Preview installation requires an explicit -Version (for example 0.1.0-beta.1)."
  }
  $previewVersionPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*$'
  if ($Version -notmatch $previewVersionPattern) {
    throw "Preview -Version must be a prerelease SemVer without the v prefix or +build metadata."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($Version)) {
  throw "-Version is only valid with -Channel preview; stable always installs releases/latest."
}

$repository = "Obito-404/Codex_iLink"
$assetName = "codex-ilink-x86_64-pc-windows-msvc.exe"
$checksumName = "$assetName.sha256"
$releaseBase = if ($Channel -eq "preview") {
  "https://github.com/$repository/releases/download/v$Version"
} else {
  "https://github.com/$repository/releases/latest/download"
}
$installDirectory = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Programs\Codex-iLink"
$destination = Join-Path $installDirectory "ilink.exe"
$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) "codex-ilink-install-$([Guid]::NewGuid().ToString('N'))"

New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
try {
  $downloadedExecutable = Join-Path $downloadDirectory $assetName
  $downloadedChecksum = Join-Path $downloadDirectory $checksumName
  Write-Host "Downloading Codex iLink..."
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $downloadedExecutable
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$checksumName" -OutFile $downloadedChecksum

  $checksumText = (Get-Content -LiteralPath $downloadedChecksum -Raw).Trim()
  $expectedHash = ($checksumText -split "\s+")[0].ToLowerInvariant()
  if ($expectedHash -notmatch "^[a-f0-9]{64}$") {
    throw "Release checksum is invalid."
  }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadedExecutable).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "SHA-256 verification failed."
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $downloadedExecutable
  if ($Channel -eq "stable") {
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "Stable release Authenticode verification failed: $($signature.Status)."
    }
  } elseif ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    Write-Warning "Preview release is not backed by a valid Authenticode signature: $($signature.Status)."
  }

  if (Test-Path -LiteralPath $destination) {
    try {
      & $destination stop | Out-Null
    } catch {
      Write-Warning "The previous Bridge could not be stopped automatically."
    }
  }

  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
  $stagedDestination = Join-Path $installDirectory "ilink.exe.new"
  Copy-Item -LiteralPath $downloadedExecutable -Destination $stagedDestination -Force
  Move-Item -LiteralPath $stagedDestination -Destination $destination -Force

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathEntries = @($userPath -split ";" | Where-Object { $_.Trim() })
  if (-not ($pathEntries | Where-Object { $_.TrimEnd("\") -ieq $installDirectory.TrimEnd("\") })) {
    $updatedPath = if ($userPath) { "$installDirectory;$userPath" } else { $installDirectory }
    [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
  }
  if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $installDirectory.TrimEnd("\") })) {
    $env:Path = "$installDirectory;$env:Path"
  }

  Write-Host "Codex iLink installed: $destination"
  Write-Host "Next: reopen Codex Desktop and PowerShell, then run 'ilink setup'."
} finally {
  if (Test-Path -LiteralPath $downloadDirectory) {
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
  }
}
