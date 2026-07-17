import { execFile } from "node:child_process";

export type PresenceState = "present" | "away";

export type PresenceSample = {
  idleMilliseconds: number;
  locked: boolean;
};

export type PresenceProbe = () => Promise<PresenceSample>;

export type PresenceCommand = (script: string) => Promise<string>;

export type WindowsPresenceProbeOptions = {
  command?: PresenceCommand;
  platform?: NodeJS.Platform;
};

export const AWAY_IDLE_MILLISECONDS = 5 * 60 * 1_000;

const WINDOWS_PRESENCE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CodexILinkPresence
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    private const uint DESKTOP_SWITCHDESKTOP = 0x0100;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(
        uint flags,
        bool inherit,
        uint desiredAccess
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SwitchDesktop(IntPtr desktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);

    public static uint GetIdleMilliseconds()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        uint now = unchecked((uint)Environment.TickCount);
        return unchecked(now - info.dwTime);
    }

    public static bool IsLocked()
    {
        IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
        if (desktop == IntPtr.Zero)
        {
            // Failure to inspect the interactive desktop is treated as away.
            return true;
        }

        try
        {
            return !SwitchDesktop(desktop);
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }
}
'@

$sample = [ordered]@{
  idleMilliseconds = [uint64][CodexILinkPresence]::GetIdleMilliseconds()
  locked = [bool][CodexILinkPresence]::IsLocked()
}
[Console]::Out.Write(($sample | ConvertTo-Json -Compress))
`;

export function createWindowsPresenceProbe(
  options: WindowsPresenceProbeOptions = {},
): PresenceProbe {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return async () => {
      throw new Error("E_PRESENCE_WINDOWS_ONLY");
    };
  }

  const command = options.command ?? runPresencePowerShell;
  return async () => {
    const output = await command(WINDOWS_PRESENCE_SCRIPT);
    return parsePresenceSample(output);
  };
}

export const windowsPresenceProbe = createWindowsPresenceProbe();

export async function getPresence(
  probe: PresenceProbe = windowsPresenceProbe,
): Promise<PresenceState> {
  const sample = await probe();
  return sample.locked || sample.idleMilliseconds >= AWAY_IDLE_MILLISECONDS
    ? "away"
    : "present";
}

function runPresencePowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.CODEX_ILINK_PWSH ?? "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1_024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("E_PRESENCE_PROBE_FAILED", { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parsePresenceSample(output: string): PresenceSample {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch (error) {
    throw new Error("E_PRESENCE_PROBE_INVALID", { cause: error });
  }

  if (typeof value !== "object" || value === null) {
    throw new Error("E_PRESENCE_PROBE_INVALID");
  }

  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.idleMilliseconds) ||
    (candidate.idleMilliseconds as number) < 0 ||
    typeof candidate.locked !== "boolean"
  ) {
    throw new Error("E_PRESENCE_PROBE_INVALID");
  }

  return {
    idleMilliseconds: candidate.idleMilliseconds as number,
    locked: candidate.locked,
  };
}
