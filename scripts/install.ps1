$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repository = "Obito-404/Codex_iLink"
$assetName = "codex-ilink-x86_64-pc-windows-msvc.exe"
$checksumName = "$assetName.sha256"
$releaseBase = "https://github.com/$repository/releases/latest/download"
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
