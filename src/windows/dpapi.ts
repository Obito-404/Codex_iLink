import { spawnSync } from "node:child_process";

const ENTROPY = "Codex_iLink/v1";

const PROTECT_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd().Trim()
$plain = [Convert]::FromBase64String($raw)
$entropy = [Text.Encoding]::UTF8.GetBytes("${ENTROPY}")
$cipher = [Security.Cryptography.ProtectedData]::Protect(
  $plain,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($raw)
$entropy = [Text.Encoding]::UTF8.GetBytes("${ENTROPY}")
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipher,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

export function protectForCurrentUser(plaintext: string): string {
  assertWindows();
  const encoded = Buffer.from(plaintext, "utf8").toString("base64");
  return runDpapi(PROTECT_SCRIPT, encoded, "E_CREDENTIAL_ENCRYPT");
}

export function unprotectForCurrentUser(protectedValue: string): string {
  assertWindows();
  const encoded = runDpapi(
    UNPROTECT_SCRIPT,
    protectedValue,
    "E_CREDENTIAL_DECRYPT",
  );
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new Error("E_CREDENTIAL_DECRYPT");
  }
}

function runDpapi(script: string, input: string, errorCode: string): string {
  const configuredShell = process.env.CODEX_ILINK_PWSH;
  const shells = configuredShell
    ? [configuredShell]
    : ["pwsh.exe", "powershell.exe"];

  for (const shell of shells) {
    const result = spawnSync(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShellCommand(script),
      ],
      {
        encoding: "utf8",
        input,
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      continue;
    }

    const output = result.stdout?.trim() ?? "";
    if (result.status !== 0 || !output) throw new Error(errorCode);
    return output;
  }

  throw new Error(errorCode);
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("E_DPAPI_WINDOWS_ONLY");
  }
}
