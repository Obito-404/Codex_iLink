import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";

import {
  createWindowsPresenceProbe,
  getPresence,
} from "../src/windows/presence.ts";
import {
  createPowerRequestCommand,
  PowerRequestController,
} from "../src/windows/power-request.ts";
import {
  desktopCodexAppServerCommand,
  findDesktopCodexExecutable,
  HostControlServer,
  requestHostControl,
  runHostLifecycle,
  runSerialPollingLoop,
} from "../src/windows/host.ts";
import { ILinkError } from "../src/ilink/protocol.ts";

test("a locked Windows session is away even after recent input", async () => {
  const presence = await getPresence(async () => ({
    idleMilliseconds: 1_000,
    locked: true,
  }));

  assert.equal(presence, "away");
});

test("an unlocked session becomes away at five minutes idle", async () => {
  const presence = await getPresence(async () => ({
    idleMilliseconds: 5 * 60 * 1_000,
    locked: false,
  }));

  assert.equal(presence, "away");
});

test("an unlocked session remains present just before five minutes idle", async () => {
  const presence = await getPresence(async () => ({
    idleMilliseconds: 5 * 60 * 1_000 - 1,
    locked: false,
  }));

  assert.equal(presence, "present");
});

test("the presence threshold can be configured without delaying lock detection", async () => {
  const tenMinutes = 10 * 60 * 1_000;
  assert.equal(
    await getPresence(
      async () => ({ idleMilliseconds: 5 * 60 * 1_000, locked: false }),
      tenMinutes,
    ),
    "present",
  );
  assert.equal(
    await getPresence(
      async () => ({ idleMilliseconds: tenMinutes, locked: false }),
      tenMinutes,
    ),
    "away",
  );
  assert.equal(
    await getPresence(
      async () => ({ idleMilliseconds: 0, locked: true }),
      tenMinutes,
    ),
    "away",
  );
});

test("the production presence probe rejects non-Windows hosts explicitly", async () => {
  let commandCalled = false;
  const probe = createWindowsPresenceProbe({
    command: async () => {
      commandCalled = true;
      return "{}";
    },
    platform: "linux",
  });

  await assert.rejects(probe(), /E_PRESENCE_WINDOWS_ONLY/u);
  assert.equal(commandCalled, false);
});

test("the Windows presence probe returns only lock and idle facts", async () => {
  const probe = createWindowsPresenceProbe({
    command: async (script) => {
      assert.match(script, /GetLastInputInfo/u);
      assert.match(script, /OpenInputDesktop/u);
      return '{"idleMilliseconds":42000,"locked":false}';
    },
    platform: "win32",
  });

  assert.deepEqual(await probe(), {
    idleMilliseconds: 42_000,
    locked: false,
  });
});

test("power is requested only while the active task count is nonzero", async () => {
  const commands: boolean[] = [];
  const controller = new PowerRequestController(async (required) => {
    commands.push(required);
  });

  await controller.setActiveTaskCount(1);
  await controller.setActiveTaskCount(3);
  await controller.setActiveTaskCount(2);
  await controller.setActiveTaskCount(0);

  assert.deepEqual(commands, [true, false]);
});

test("invalid active task counts cannot alter the power request", async () => {
  const commands: boolean[] = [];
  const controller = new PowerRequestController(async (required) => {
    commands.push(required);
  });

  await assert.rejects(
    controller.setActiveTaskCount(-1),
    /E_POWER_REQUEST_COUNT/u,
  );
  await assert.rejects(
    controller.setActiveTaskCount(1.5),
    /E_POWER_REQUEST_COUNT/u,
  );
  assert.deepEqual(commands, []);
});

test("overlapping task-count updates preserve their requested order", async () => {
  const commands: boolean[] = [];
  let finishAcquire: (() => void) | undefined;
  let markAcquireStarted: (() => void) | undefined;
  const acquireStarted = new Promise<void>((resolve) => {
    markAcquireStarted = resolve;
  });
  const controller = new PowerRequestController(async (required) => {
    commands.push(required);
    if (required) {
      markAcquireStarted?.();
      await new Promise<void>((resolve) => {
        finishAcquire = resolve;
      });
    }
  });

  const acquire = controller.setActiveTaskCount(1);
  await acquireStarted;
  const release = controller.setActiveTaskCount(0);
  finishAcquire?.();
  await Promise.all([acquire, release]);

  assert.deepEqual(commands, [true, false]);
});

test("closing an active controller restores power and prevents reuse", async () => {
  const commands: boolean[] = [];
  const controller = new PowerRequestController(async (required) => {
    commands.push(required);
  });

  await controller.setActiveTaskCount(1);
  await controller.close();
  await controller.close();

  assert.deepEqual(commands, [true, false]);
  await assert.rejects(
    controller.setActiveTaskCount(1),
    /E_POWER_REQUEST_CLOSED/u,
  );
});

test("controller close can retry a failed restore", async () => {
  let releaseAttempts = 0;
  const controller = new PowerRequestController(async (required) => {
    if (required) return;
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw new Error("transient release failure");
  });

  await controller.setActiveTaskCount(1);
  await assert.rejects(controller.close(), /transient release failure/u);
  await controller.close();

  assert.equal(releaseAttempts, 2);
});

test("the default power command is an explicit no-op off Windows", async () => {
  let helperStarted = false;
  const command = createPowerRequestCommand({
    platform: "linux",
    startHelper: async () => {
      helperStarted = true;
      return { release: async () => undefined };
    },
  });

  await command(true);
  await command(false);

  assert.equal(helperStarted, false);
});

test("the Windows power command holds one system-only request until release", async () => {
  const scripts: string[] = [];
  let releases = 0;
  const command = createPowerRequestCommand({
    platform: "win32",
    startHelper: async (script) => {
      scripts.push(script);
      return {
        release: async () => {
          releases += 1;
        },
      };
    },
  });

  await command(true);
  await command(true);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0] ?? "", /SystemRequired/u);
  assert.match(scripts[0] ?? "", /Continuous/u);
  assert.doesNotMatch(scripts[0] ?? "", /DisplayRequired/u);

  await command(false);
  await command(false);
  assert.equal(releases, 1);
});

test("managed command close retries when helper release fails", async () => {
  let releaseAttempts = 0;
  const command = createPowerRequestCommand({
    platform: "win32",
    startHelper: async () => ({
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("release failed");
      },
    }),
  });

  await command(true);
  await assert.rejects(async () => {
    await command.close();
  }, /release failed/u);
  await command.close();

  assert.equal(releaseAttempts, 2);
});

test("the production helper holds the request process until it is released", async (t) => {
  const fakeHelper = [
    'process.stdout.write("READY\\n");',
    'process.stdin.once("data", () => process.exit(0));',
  ].join("");
  const command = createPowerRequestCommand({
    helperCommand: [process.execPath, "-e", fakeHelper],
    platform: "win32",
  });
  t.after(async () => {
    await command.close();
  });

  await command(true);
  await command(false);
});

test("closing the Windows command terminates its active helper", async (t) => {
  const fakeHelper = [
    'process.stdout.write("READY\\n");',
    'process.stdin.once("data", () => process.exit(0));',
  ].join("");
  const command = createPowerRequestCommand({
    helperCommand: [process.execPath, "-e", fakeHelper],
    platform: "win32",
  });
  t.after(async () => {
    await command.close();
  });

  await command(true);
  await command.close();
  await command.close();
});

test("helper exit restores the OS request even when its exit code is nonzero", async (t) => {
  const fakeHelper = [
    'process.stdout.write("READY\\n");',
    'process.stdin.once("data", () => process.exit(7));',
  ].join("");
  const command = createPowerRequestCommand({
    helperCommand: [process.execPath, "-e", fakeHelper],
    platform: "win32",
  });
  t.after(async () => {
    await command.close();
  });

  await command(true);
  await command(false);
});

test("Desktop codex discovery chooses the newest installed runtime", (t) => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-host-"));
  t.after(() => rmSync(localAppData, { force: true, recursive: true }));
  const olderDirectory = join(localAppData, "OpenAI", "Codex", "bin", "older");
  const newerDirectory = join(localAppData, "OpenAI", "Codex", "bin", "newer");
  mkdirSync(olderDirectory, { recursive: true });
  mkdirSync(newerDirectory, { recursive: true });
  const older = join(olderDirectory, "codex.exe");
  const newer = join(newerDirectory, "codex.exe");
  writeFileSync(older, "older");
  writeFileSync(newer, "newer");
  utimesSync(older, new Date(1_000), new Date(1_000));
  utimesSync(newer, new Date(2_000), new Date(2_000));

  assert.equal(findDesktopCodexExecutable({ LOCALAPPDATA: localAppData }), newer);
});

test("configured Desktop codex path is validated before use", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-host-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const executable = join(directory, "codex.exe");
  writeFileSync(executable, "fixture");

  assert.equal(
    findDesktopCodexExecutable({ CODEX_ILINK_CODEX_EXE: executable }),
    executable,
  );
  assert.throws(
    () =>
      findDesktopCodexExecutable({
        CODEX_ILINK_CODEX_EXE: join(directory, "missing.exe"),
      }),
    /E_DESKTOP_CODEX_NOT_FOUND/u,
  );
});

test("the Bridge App Server does not override Codex feature settings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-host-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const executable = join(directory, "codex.exe");
  writeFileSync(executable, "fixture");

  assert.deepEqual(
    desktopCodexAppServerCommand({ CODEX_ILINK_CODEX_EXE: executable }),
    [executable, "app-server"],
  );
});

test("the control pipe is both a status endpoint and a crash-safe singleton", async (t) => {
  const pipePath = `\\\\.\\pipe\\codex-ilink-test-${randomUUID()}`;
  let stopRequests = 0;
  const status = {
    ilinkAuthPausedUntilMs: 1_721_003_600_000,
    phase: "running" as const,
    pid: process.pid,
    startedAtMs: 1_721_000_000_000,
  };
  const control = await HostControlServer.start({
    onStatus: () => status,
    onStop: () => {
      stopRequests += 1;
    },
    pipePath,
  });
  t.after(() => control.close());

  assert.deepEqual(await requestHostControl(pipePath, "status"), {
    ok: true,
    status,
  });
  await assert.rejects(
    HostControlServer.start({
      onStatus: () => status,
      onStop: () => undefined,
      pipePath,
    }),
    /E_HOST_ALREADY_RUNNING/u,
  );
  assert.deepEqual(await requestHostControl(pipePath, "stop"), {
    ok: true,
    status,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(stopRequests, 1);
});

test("a stop acknowledgement is flushed before shutdown closes the control pipe", async (t) => {
  const pipePath = `\\\\.\\pipe\\codex-ilink-test-${randomUUID()}`;
  const status = {
    phase: "running" as const,
    pid: process.pid,
    startedAtMs: 1_721_000_000_000,
  };
  let control: HostControlServer;
  let closed: Promise<void> | undefined;
  control = await HostControlServer.start({
    onStatus: () => status,
    onStop: () => {
      closed ??= control.close();
    },
    pipePath,
  });
  t.after(() => control.close());

  assert.deepEqual(await requestHostControl(pipePath, "stop"), {
    ok: true,
    status,
  });
  await closed;
});

test("an incomplete control client cannot block graceful host shutdown", async () => {
  const pipePath = `\\\\.\\pipe\\codex-ilink-test-${randomUUID()}`;
  const control = await HostControlServer.start({
    onStatus: () => ({
      phase: "running",
      pid: process.pid,
      startedAtMs: Date.now(),
    }),
    onStop: () => undefined,
    pipePath,
  });
  const incompleteClient = createConnection(pipePath);
  await new Promise<void>((resolve, reject) => {
    incompleteClient.once("connect", resolve);
    incompleteClient.once("error", reject);
  });
  const clientClosed = new Promise<void>((resolve) => {
    incompleteClient.once("close", () => resolve());
  });

  await control.close();
  await clientClosed;
  assert.equal(incompleteClient.destroyed, true);
});

test("polling is serial, resets backoff after success, and stops on AbortSignal", async () => {
  const abort = new AbortController();
  const delays: number[] = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;

  await runSerialPollingLoop({
    backoffMs: [10, 20, 40],
    poll: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      await Promise.resolve();
      active -= 1;
      if (calls === 1 || calls === 2 || calls === 4) throw new Error("offline");
      if (calls === 5) abort.abort();
    },
    signal: abort.signal,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(maxActive, 1);
  assert.equal(calls, 5);
  assert.deepEqual(delays, [10, 20, 10]);
});

test("aborting during polling backoff exits without another request", async () => {
  const abort = new AbortController();
  let calls = 0;
  const loop = runSerialPollingLoop({
    backoffMs: [60_000],
    poll: async () => {
      calls += 1;
      throw new Error("offline");
    },
    signal: abort.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await loop;

  assert.equal(calls, 1);
});

test("expired iLink authentication uses the official one-hour cooldown", async () => {
  const abort = new AbortController();
  const delays: number[] = [];
  let calls = 0;
  await runSerialPollingLoop({
    poll: async () => {
      calls += 1;
      if (calls === 1) {
        throw new ILinkError({
          kind: "auth-expired",
          message: "getUpdates ret=-14",
        });
      }
      abort.abort();
    },
    signal: abort.signal,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(delays, [60 * 60 * 1_000]);
});

test("host lifecycle closes every owned resource in a deterministic order", async () => {
  const abort = new AbortController();
  const operations: string[] = [];
  await runHostLifecycle(
    {
      daemon: {
        pollOnce: async () => {
          operations.push("poll");
          abort.abort();
        },
        start: async () => {
          operations.push("daemon:start");
        },
        stop: async () => {
          operations.push("daemon:stop");
        },
      },
      leases: { close: () => operations.push("leases:close") },
      power: { close: async () => void operations.push("power:close") },
      state: { close: () => operations.push("state:close") },
    },
    { signal: abort.signal },
  );

  assert.deepEqual(operations, [
    "daemon:start",
    "poll",
    "daemon:stop",
    "power:close",
    "leases:close",
    "state:close",
  ]);
});

test("a failed daemon start still releases all host resources", async () => {
  const operations: string[] = [];
  await assert.rejects(
    runHostLifecycle(
      {
        daemon: {
          pollOnce: async () => undefined,
          start: async () => {
            operations.push("daemon:start");
            throw new Error("start failed");
          },
          stop: async () => {
            operations.push("daemon:stop");
          },
        },
        leases: { close: () => operations.push("leases:close") },
        power: { close: async () => void operations.push("power:close") },
        state: { close: () => operations.push("state:close") },
      },
      { signal: new AbortController().signal },
    ),
    /start failed/u,
  );
  assert.deepEqual(operations, [
    "daemon:start",
    "daemon:stop",
    "power:close",
    "leases:close",
    "state:close",
  ]);
});
