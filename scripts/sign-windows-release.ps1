[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,

  [string] $ChecksumPath = "$ExecutablePath.sha256"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_PFX_BASE64)) {
  throw "稳定版发布缺少 WINDOWS_SIGNING_PFX_BASE64，拒绝生成未签名产物。"
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_PFX_PASSWORD)) {
  throw "稳定版发布缺少 WINDOWS_SIGNING_PFX_PASSWORD，拒绝生成未签名产物。"
}

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$certificate = $null
try {
  $pfxBytes = [Convert]::FromBase64String($env:WINDOWS_SIGNING_PFX_BASE64)
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $pfxBytes,
    $env:WINDOWS_SIGNING_PFX_PASSWORD,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  )
  if (-not $certificate.HasPrivateKey) {
    throw "提供的 Authenticode PFX 不含私钥。"
  }

  $signature = Set-AuthenticodeSignature `
    -FilePath $resolvedExecutable `
    -Certificate $certificate `
    -HashAlgorithm SHA256 `
    -TimestampServer "http://timestamp.digicert.com"
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode 签名校验失败：$($signature.Status) $($signature.StatusMessage)"
  }

  $hash = (Get-FileHash -LiteralPath $resolvedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  $fileName = Split-Path -Leaf $resolvedExecutable
  $checksumContent = "$hash  $fileName`n"
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::GetFullPath($ChecksumPath),
    $checksumContent,
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Output "Authenticode signature valid; SHA-256 regenerated: $hash"
}
finally {
  if ($null -ne $certificate) {
    $certificate.Dispose()
  }
}
