import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { HookReceiver, type HookEvent } from "../src/hooks/hook-receiver.ts";

const hookScript = resolve(
  "plugins/codex-ilink-probe/scripts/lifecycle-notify.mjs",
);

test("a lifecycle Hook spools only routing metadata when the pipe is offline", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-"));
  const spoolDirectory = join(directory, "spool");

  try {
    const result = runHook({
      pipePath: pipePath(),
      spoolDirectory,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");

    const files = readdirSync(spoolDirectory);
    assert.equal(files.length, 1);
    const event = JSON.parse(
      readFileSync(join(spoolDirectory, files[0]!), "utf8"),
    ) as HookEvent;
    assert.deepEqual(Object.keys(event).sort(), [
      "capturedAtMs",
      "cwd",
      "eventName",
      "model",
      "permissionMode",
      "schemaVersion",
      "sessionId",
      "source",
      "toolName",
      "turnId",
    ]);
    assert.equal(event.sessionId, "thread-a");
    assert.equal(event.turnId, "turn-a");
    assert.equal(event.cwd, "D:\\Codex_iLink");
    assert.ok(!JSON.stringify(event).includes("secret prompt"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the receiver accepts a live Hook and drains an earlier spool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  const events: HookEvent[] = [];

  runHook({ pipePath: pipePath(), spoolDirectory });
  const receiver = new HookReceiver({
    onEvent: (event) => {
      events.push(event);
    },
    pipePath: path,
    spoolDirectory,
  });

  try {
    await receiver.start();
    assert.equal(await receiver.drainSpool(), 1);

    const result = await runHookAsync({ pipePath: path, spoolDirectory });
    assert.equal(result.status, 0, result.stderr);
    await waitFor(() => events.length === 2);
    assert.deepEqual(
      events.map((event) => event.eventName),
      ["Stop", "Stop"],
    );
    assert.equal(readdirSync(spoolDirectory).length, 0);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("concurrent spool drains share one delivery pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-flight-"));
  const spoolDirectory = join(directory, "spool");
  runHook({ pipePath: pipePath(), spoolDirectory });
  let deliveries = 0;
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolveDelivery) => {
    releaseDelivery = resolveDelivery;
  });
  const receiver = new HookReceiver({
    onEvent: async () => {
      deliveries += 1;
      await deliveryGate;
    },
    pipePath: pipePath(),
    spoolDirectory,
  });

  try {
    const first = receiver.drainSpool();
    const second = receiver.drainSpool();
    assert.equal(first, second);
    await waitFor(() => deliveries === 1);
    releaseDelivery();
    assert.equal(await first, 1);
    assert.equal(await second, 1);
    assert.equal(readdirSync(spoolDirectory).length, 0);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the receiver deletes expired spool events without delivering them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-expired-"));
  const spoolDirectory = join(directory, "spool");
  runHook({ pipePath: pipePath(), spoolDirectory });
  const file = join(spoolDirectory, readdirSync(spoolDirectory)[0]!);
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  utimesSync(file, expired, expired);
  let deliveries = 0;
  const receiver = new HookReceiver({
    onEvent: () => {
      deliveries += 1;
    },
    pipePath: pipePath(),
    spoolDirectory,
  });

  try {
    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(deliveries, 0);
    assert.deepEqual(readdirSync(spoolDirectory), []);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

function runHook(input: { pipePath: string; spoolDirectory: string }) {
  return spawnSync(process.execPath, [hookScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ILINK_PIPE_PATH: input.pipePath,
      CODEX_ILINK_SPOOL_DIR: input.spoolDirectory,
    },
    input: JSON.stringify(hookInput()),
    timeout: 10_000,
  });
}

function runHookAsync(input: { pipePath: string; spoolDirectory: string }) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [hookScript], {
        env: {
          ...process.env,
          CODEX_ILINK_PIPE_PATH: input.pipePath,
          CODEX_ILINK_SPOOL_DIR: input.spoolDirectory,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", rejectRun);
      child.once("close", (status) => resolveRun({ status, stderr, stdout }));
      child.stdin.end(JSON.stringify(hookInput()));
    },
  );
}

function hookInput(): Record<string, unknown> {
  return {
    cwd: "D:\\Codex_iLink",
    hook_event_name: "Stop",
    model: "gpt-test",
    permission_mode: "workspace-write",
    prompt: "secret prompt",
    session_id: "thread-a",
    source: "desktop",
    tool_input: { token: "must-not-leak" },
    tool_name: null,
    transcript_path: "secret transcript",
    turn_id: "turn-a",
  };
}

function pipePath(): string {
  return `\\\\.\\pipe\\codex-ilink-test-${randomUUID()}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail("timed out waiting for Hook event");
}
