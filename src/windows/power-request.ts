import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

export type PowerRequestCommand = {
  (required: boolean): Promise<void> | void;
  close?: () => Promise<void> | void;
};

export type ManagedPowerRequestCommand = PowerRequestCommand & {
  close(): Promise<void>;
};

export type PowerRequestHelper = {
  release(): Promise<void>;
};

export type PowerRequestHelperStarter = (
  script: string,
) => Promise<PowerRequestHelper>;

export type PowerRequestCommandOptions = {
  helperCommand?: readonly [string, ...string[]];
  platform?: NodeJS.Platform;
  startHelper?: PowerRequestHelperStarter;
};

const WINDOWS_POWER_REQUEST_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CodexILinkPowerRequest
{
    [Flags]
    private enum ExecutionState : uint
    {
        SystemRequired = 0x00000001,
        Continuous = 0x80000000
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern ExecutionState SetThreadExecutionState(
        ExecutionState flags
    );

    public static void Hold()
    {
        ExecutionState result = SetThreadExecutionState(
            ExecutionState.Continuous | ExecutionState.SystemRequired
        );
        if (result == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Restore()
    {
        if (SetThreadExecutionState(ExecutionState.Continuous) == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@

[CodexILinkPowerRequest]::Hold()
try {
  [Console]::Out.WriteLine("READY")
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
}
finally {
  [CodexILinkPowerRequest]::Restore()
}
`;

export function createPowerRequestCommand(
  options: PowerRequestCommandOptions = {},
): ManagedPowerRequestCommand {
  if ((options.platform ?? process.platform) !== "win32") {
    let closed = false;
    const command = async (): Promise<void> => {
      if (closed) throw new Error("E_POWER_REQUEST_CLOSED");
    };
    return Object.assign(command, {
      async close(): Promise<void> {
        closed = true;
      },
    });
  }

  const helperCommand =
    options.helperCommand ?? defaultPowerRequestHelperCommand();
  const startHelper =
    options.startHelper ??
    ((script: string) =>
      startWindowsPowerRequestHelper(script, helperCommand));
  let helper: PowerRequestHelper | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const releaseHeldHelper = async (): Promise<void> => {
    if (!helper) return;
    const heldHelper = helper;
    await heldHelper.release();
    if (helper === heldHelper) helper = undefined;
  };
  const command = (required: boolean): Promise<void> => {
    if (closed) return Promise.reject(new Error("E_POWER_REQUEST_CLOSED"));
    return enqueue(async () => {
      if (required) {
        if (helper) return;
        helper = await startHelper(WINDOWS_POWER_REQUEST_SCRIPT);
        return;
      }
      await releaseHeldHelper();
    });
  };

  return Object.assign(command, {
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      const closing = enqueue(releaseHeldHelper);
      closePromise = closing;
      void closing.catch(() => {
        if (closePromise === closing) closePromise = undefined;
      });
      return closing;
    },
  });
}

async function startWindowsPowerRequestHelper(
  script: string,
  command: readonly [string, ...string[]],
): Promise<PowerRequestHelper> {
  const [executable, ...args] = command;
  const child = spawn(executable, [...args, script], {
    shell: false,
    stdio: "pipe",
    windowsHide: true,
  });
  const terminateOnParentExit = (): void => {
    child.kill();
  };
  const removeParentExitFallback = (): void => {
    process.off("exit", terminateOnParentExit);
  };
  process.once("exit", terminateOnParentExit);
  child.once("close", removeParentExitFallback);
  // Drain diagnostics without retaining them; otherwise a noisy helper can
  // block before it reaches the readiness handshake.
  child.stderr.resume();

  try {
    await waitForHelperReady(child);
  } catch (error) {
    child.kill();
    throw error;
  }

  child.stdout.resume();
  let releasePromise: Promise<void> | undefined;
  return {
    release(): Promise<void> {
      releasePromise ??= releaseHelper(child).finally(
        removeParentExitFallback,
      );
      return releasePromise;
    },
  };
}

function defaultPowerRequestHelperCommand(): readonly [string, ...string[]] {
  return [
    process.env.CODEX_ILINK_PWSH ?? "pwsh.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ];
}

function waitForHelperReady(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(
      () => fail(new Error("E_POWER_REQUEST_START_TIMEOUT")),
      10_000,
    );

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (): void => fail(new Error("E_POWER_REQUEST_START"));
    const onExit = (): void => fail(new Error("E_POWER_REQUEST_START"));
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 4_096) {
        fail(new Error("E_POWER_REQUEST_START"));
        return;
      }

      const newline = output.indexOf("\n");
      if (newline < 0) return;
      if (output.slice(0, newline).trim() !== "READY") {
        fail(new Error("E_POWER_REQUEST_START"));
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  });
}

function releaseHelper(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let forcedExitTimeout: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      if (!child.kill()) {
        finish(new Error("E_POWER_REQUEST_RELEASE_TIMEOUT"));
        return;
      }
      forcedExitTimeout = setTimeout(
        () => finish(new Error("E_POWER_REQUEST_RELEASE_TIMEOUT")),
        2_000,
      );
    }, 5_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forcedExitTimeout) clearTimeout(forcedExitTimeout);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdin.off("error", onStdinError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (): void => finish(new Error("E_POWER_REQUEST_RELEASE"));
    const onStdinError = (): void => undefined;
    // Execution-state requests are owned by the helper thread, so any process
    // exit restores normal sleep behavior even if its explicit restore failed.
    const onClose = (): void => finish();

    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.once("error", onStdinError);
    child.stdin.end("\n");
  });
}

export class PowerRequestController {
  readonly #command: PowerRequestCommand;
  #activeTaskCount = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #pendingUpdate: Promise<void> = Promise.resolve();

  constructor(command: PowerRequestCommand) {
    this.#command = command;
  }

  async setActiveTaskCount(count: number): Promise<void> {
    if (this.#closed) throw new Error("E_POWER_REQUEST_CLOSED");
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("E_POWER_REQUEST_COUNT");
    }

    const update = this.#pendingUpdate.then(() =>
      this.#applyActiveTaskCount(count),
    );
    this.#pendingUpdate = update.catch(() => undefined);
    await update;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const close = this.#pendingUpdate.then(async () => {
      if (this.#command.close) {
        await this.#command.close();
      } else if (this.#activeTaskCount > 0) {
        await this.#command(false);
      }
      this.#activeTaskCount = 0;
    });
    this.#pendingUpdate = close.catch(() => undefined);
    this.#closePromise = close;
    void close.catch(() => {
      if (this.#closePromise === close) this.#closePromise = undefined;
    });
    return close;
  }

  async #applyActiveTaskCount(count: number): Promise<void> {
    const wasRequired = this.#activeTaskCount > 0;
    const isRequired = count > 0;
    if (wasRequired !== isRequired) {
      await this.#command(isRequired);
    }
    this.#activeTaskCount = count;
  }
}
