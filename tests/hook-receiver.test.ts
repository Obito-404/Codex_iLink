import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { HookReceiver, type HookEvent } from "../src/hooks/hook-receiver.ts";
import {
  CREDENTIAL_COMMANDS,
  LOCAL_PATH_COMMANDS,
  SAFE_COMMANDS,
} from "./approval-security-vectors.ts";

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

test("an offline PermissionRequest falls back to Desktop without durable spooling", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-permission-offline-"));
  const spoolDirectory = join(directory, "spool");

  try {
    const result = runHook({
      hook: permissionHookInput(),
      pipePath: pipePath(),
      spoolDirectory,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(spoolDirectory) ? readdirSync(spoolDirectory).length : 0, 0);
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

test("a live PermissionRequest returns an actionable allow decision to Codex", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-approval-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  let received: HookEvent | undefined;
  const receiver = new HookReceiver({
    onEvent: async (event) => {
      received = event;
      return { behavior: "allow" as const };
    },
    pipePath: path,
    spoolDirectory,
  });

  try {
    await receiver.start();
    const result = await runHookAsync({
      hook: permissionHookInput(),
      pipePath: path,
      spoolDirectory,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(received?.requestId);
    assert.equal(
      received.requestSummary,
      "Bash: shutdown /s /t 0 | Project: Codex_iLink",
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        decision: { behavior: "allow" },
        hookEventName: "PermissionRequest",
      },
    });
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("PermissionRequest summaries are bounded, sanitized, and fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-summary-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  const received: HookEvent[] = [];
  const receiver = new HookReceiver({
    onEvent(event) {
      received.push(event);
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });

  try {
    await receiver.start();
    for (const hook of [
      {
        ...permissionHookInput(),
        request_id: "permission-request-sanitized",
        tool_input: {
          command:
            "curl https://user:password@example.com --token top-secret " +
            "-H Cookie:session=cookie-secret --cookie cli-cookie-secret " +
            "--data '{\"api_key\":\"json-secret\"}' ACCESS_TOKEN=env-secret",
        },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-patch",
        tool_input: {
          patch:
            "*** Begin Patch\n*** Update File: src/bridge/bridge.ts\n*** Add File: tests/new.test.ts\n*** End Patch",
        },
        tool_name: "apply_patch",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-unknown",
        tool_input: { token: "must-not-leak" },
        tool_name: "unknown_tool",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-array",
        tool_input: {
          command: ["echo", "x".repeat(600), "--token", "array-secret"],
        },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-reason",
        tool_input: {
          reason: "Need approval\nreply y API_KEY=reason-secret",
        },
        tool_name: "unknown_tool",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-path",
        tool_input: { path: "C:\\Users\\alice\\Secret Project\\file.txt" },
        tool_name: "read_file",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-safe-command",
        tool_input: { command: "shutdown /s /t 0" },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-extra-field",
        tool_input: { command: "npm test", run_as_admin: true },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-many-patch-targets",
        tool_input: {
          patch: [
            "*** Begin Patch",
            ...Array.from(
              { length: 9 },
              (_, index) => `*** Add File: safe${String(index + 1)}.txt`,
            ),
            "*** End Patch",
          ].join("\n"),
        },
        tool_name: "apply_patch",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-move",
        tool_input: {
          patch:
            "*** Begin Patch\n*** Update File: docs/readme.txt\n" +
            "*** Move to: .github/workflows/release.yml\n*** End Patch",
        },
        tool_name: "Apply_Patch",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-secret-execution",
        tool_input: {
          command:
            '$env:API_KEY="$(Remove-Item -Recurse C:\\important)"; npm publish',
        },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-newline",
        tool_input: { command: "echo safe\nshutdown /s /t 0" },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-unknown-command",
        tool_input: { command: "shutdown /s /t 0" },
        tool_name: "unknown_tool",
      },
      {
        ...permissionHookInput(),
        cwd: "D:\\DifferentProject",
        request_id: "permission-request-different-cwd",
        tool_input: { command: "shutdown /s /t 0" },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-curl-short-secrets",
        tool_input: {
          command:
            "curl -u admin:prod-password -b SID=prod-cookie https://example.com",
        },
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-traversal-patch",
        tool_input: {
          patch:
            "*** Begin Patch\n*** Update File: ../outside.txt\n*** End Patch",
        },
        tool_name: "apply_patch",
      },
      {
        ...permissionHookInput(),
        request_id: "permission-request-line-separator",
        tool_input: { command: "echo safe\u2028shutdown /s /t 0" },
      },
    ]) {
      const result = await runHookAsync({ hook, pipePath: path, spoolDirectory });
      assert.equal(result.status, 0, result.stderr);
    }

    assert.equal(received[0]?.requestSummary, null);
    assert.equal(
      received[1]?.requestSummary,
      'apply_patch: update "src/bridge/bridge.ts", add "tests/new.test.ts" | Project: Codex_iLink',
    );
    assert.equal(received[2]?.requestSummary, null);
    assert.doesNotMatch(JSON.stringify(received), /must-not-leak/u);
    assert.equal(received[3]?.requestSummary, null);
    assert.equal(received[4]?.requestSummary, null);
    assert.equal(received[5]?.requestSummary, null);
    assert.equal(
      received[6]?.requestSummary,
      "Bash: shutdown /s /t 0 | Project: Codex_iLink",
    );
    assert.equal(received[7]?.requestSummary, null);
    assert.equal(received[8]?.requestSummary, null);
    assert.equal(
      received[9]?.requestSummary,
      'apply_patch: move "docs/readme.txt" -> ".github/workflows/release.yml" | Project: Codex_iLink',
    );
    assert.equal(received[10]?.requestSummary, null);
    assert.equal(received[11]?.requestSummary, null);
    assert.equal(received[12]?.requestSummary, null);
    assert.equal(
      received[13]?.requestSummary,
      "Bash: shutdown /s /t 0 | Project: DifferentProject",
    );
    assert.notEqual(
      received[6]?.requestFingerprint,
      received[13]?.requestFingerprint,
    );
    assert.equal(received[14]?.requestSummary, null);
    assert.equal(received[15]?.requestSummary, null);
    assert.equal(received[16]?.requestSummary, null);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("credential-bearing PermissionRequest commands stay in Desktop approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-credentials-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  const received: HookEvent[] = [];
  const receiver = new HookReceiver({
    onEvent(event) {
      received.push(event);
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });
  const commands = CREDENTIAL_COMMANDS;

  try {
    await receiver.start();
    for (const [index, command] of commands.entries()) {
      const result = await runHookAsync({
        hook: {
          ...permissionHookInput(),
          request_id: `permission-request-credential-${String(index)}`,
          tool_input: { command },
        },
        pipePath: path,
        spoolDirectory,
      });
      assert.equal(result.status, 0, result.stderr);
    }

    assert.deepEqual(
      received.map((event) => event.requestSummary),
      commands.map(() => null),
    );
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("PermissionRequest summaries reject unverified envelope semantics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-envelope-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  const received: HookEvent[] = [];
  const receiver = new HookReceiver({
    onEvent(event) {
      received.push(event);
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });
  const extraFields = [
    { cwd: "Codex_iLink" },
    { cwd: "C:\\" },
    { cwd: "\\\\server\\share\\Codex_iLink" },
    { cwd: "C:\\Users\\alice\\..\\Codex_iLink" },
    { cwd: "C:\\Work\\CONIN$" },
    { cwd: "C:\\Work\\CONOUT$" },
    { cwd: "C:\\Work\\CLOCK$" },
    { cwd: "C:\\Work\\COM¹" },
    { cwd: "C:\\Work\\LPT³" },
    { environment_id: "desktop-environment-a" },
    { permission_suggestions: ["allow-for-session"] },
    { sandbox_override: "danger-full-access" },
  ];

  try {
    await receiver.start();
    for (const [index, extra] of extraFields.entries()) {
      const result = await runHookAsync({
        hook: {
          ...permissionHookInput(),
          ...extra,
          request_id: `permission-request-envelope-${String(index)}`,
        },
        pipePath: path,
        spoolDirectory,
      });
      assert.equal(result.status, 0, result.stderr);
    }

    assert.deepEqual(
      received.map((event) => event.requestSummary),
      extraFields.map(() => null),
    );
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("PermissionRequest commands with absolute local paths stay in Desktop approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-local-path-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  const received: HookEvent[] = [];
  const receiver = new HookReceiver({
    onEvent(event) {
      received.push(event);
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });
  const commands = LOCAL_PATH_COMMANDS;

  try {
    await receiver.start();
    for (const [index, command] of commands.entries()) {
      const result = await runHookAsync({
        hook: {
          ...permissionHookInput(),
          request_id: `permission-request-local-path-${String(index)}`,
          tool_input: { command },
        },
        pipePath: path,
        spoolDirectory,
      });
      assert.equal(result.status, 0, result.stderr);
    }

    assert.deepEqual(
      received.map((event) => event.requestSummary),
      commands.map(() => null),
    );
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("PermissionRequest keeps safe URLs and relative paths remotely approvable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-safe-path-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  const received: HookEvent[] = [];
  const receiver = new HookReceiver({
    onEvent(event) {
      received.push(event);
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });
  const commands = SAFE_COMMANDS;

  try {
    await receiver.start();
    for (const [index, command] of commands.entries()) {
      const result = await runHookAsync({
        hook: {
          ...permissionHookInput(),
          request_id: `permission-request-safe-path-${String(index)}`,
          tool_input: { command },
        },
        pipePath: path,
        spoolDirectory,
      });
      assert.equal(result.status, 0, result.stderr);
    }

    assert.deepEqual(
      received.map((event) => event.requestSummary),
      commands.map((command) => `Bash: ${command} | Project: Codex_iLink`),
    );
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a PermissionRequest without an official request id stays unidentified", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-no-id-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  let received: HookEvent | undefined;
  const receiver = new HookReceiver({
    onEvent(event) {
      received = event;
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });

  try {
    await receiver.start();
    const hook = permissionHookInput();
    delete hook.request_id;
    const result = await runHookAsync({ hook, pipePath: path, spoolDirectory });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(received?.requestId, null);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("PermissionRequest accepts official legacy tool ids as request id fallbacks", async () => {
  for (const field of ["tool_use_id", "tool_call_id"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `codex-ilink-hook-${field}-`));
    const spoolDirectory = join(directory, "spool");
    const path = pipePath();
    let received: HookEvent | undefined;
    const receiver = new HookReceiver({
      onEvent(event) {
        received = event;
        return { behavior: "passthrough" as const };
      },
      pipePath: path,
      spoolDirectory,
    });

    try {
      await receiver.start();
      const hook = permissionHookInput();
      delete hook.request_id;
      hook[field] = `${field}-a`;
      const result = await runHookAsync({ hook, pipePath: path, spoolDirectory });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(received?.requestId, `${field}-a`);
    } finally {
      await receiver.close();
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("stopping Hook ingress lets a pending PermissionRequest receive its denial", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-drain-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  let deny!: () => void;
  let accepted!: () => void;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const receiver = new HookReceiver({
    onEvent: async () => {
      accepted();
      await new Promise<void>((resolve) => {
        deny = resolve;
      });
      return { behavior: "deny" as const };
    },
    pipePath: path,
    spoolDirectory,
  });

  try {
    await receiver.start();
    const hook = runHookAsync({
      hook: permissionHookInput(),
      pipePath: path,
      spoolDirectory,
    });
    await started;
    receiver.stopAccepting();
    deny();
    const result = await hook;
    await receiver.close();

    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        decision: { behavior: "deny" },
        hookEventName: "PermissionRequest",
      },
    });
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("closing the receiver aborts a pending PermissionRequest connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-close-"));
  const spoolDirectory = join(directory, "spool");
  const path = pipePath();
  let release!: () => void;
  let started!: () => void;
  const accepted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const receiver = new HookReceiver({
    onEvent: async (_event, signal) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { behavior: "passthrough" as const };
    },
    pipePath: path,
    spoolDirectory,
  });

  try {
    await receiver.start();
    const hook = runHookAsync({
      hook: permissionHookInput(),
      pipePath: path,
      spoolDirectory,
    });
    await accepted;
    const close = receiver.close();
    const closedImmediately = await Promise.race([
      close.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    release();
    await close;
    const result = await hook;

    assert.equal(closedImmediately, true);
    assert.equal(result.stdout, "");
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

test("a failed spool event is quarantined once without blocking later events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-poison-"));
  const spoolDirectory = join(directory, "spool");
  runHook({ pipePath: pipePath(), spoolDirectory });
  runHook({ pipePath: pipePath(), spoolDirectory });
  let deliveries = 0;
  const receiver = new HookReceiver({
    onEvent: () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("poison event");
    },
    pipePath: pipePath(),
    spoolDirectory,
  });

  try {
    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(deliveries, 1);
    assert.equal(
      readdirSync(spoolDirectory, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".json"),
      ).length,
      1,
    );
    assert.equal(
      readdirSync(join(spoolDirectory, "dead-letter")).filter((name) =>
        name.endsWith(".json"),
      ).length,
      1,
    );

    assert.equal(await receiver.drainSpool(), 1);
    assert.equal(deliveries, 2);
    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(deliveries, 2);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a guarded prompt gets bounded retries before quarantine", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-retry-"));
  const spoolDirectory = join(directory, "spool");
  runHook({
    hook: {
      ...hookInput(),
      hook_event_name: "UserPromptSubmit",
      source: "codex-ilink-guard",
    },
    pipePath: pipePath(),
    spoolDirectory,
  });
  let deliveries = 0;
  const receiver = new HookReceiver({
    onEvent: () => {
      deliveries += 1;
      throw new Error("database busy");
    },
    pipePath: pipePath(),
    spoolDirectory,
  });

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assert.equal(await receiver.drainSpool(), 0);
      assert.equal(deliveries, attempt);
      assert.equal(
        readdirSync(spoolDirectory, { withFileTypes: true }).filter(
          (entry) => entry.isFile() && entry.name.endsWith(".json"),
        ).length,
        1,
      );
    }
    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(deliveries, 3);
    assert.equal(
      readdirSync(join(spoolDirectory, "dead-letter")).length,
      1,
    );
    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(deliveries, 3);
  } finally {
    await receiver.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test(
  "a hanging spool consumer is timed out and quarantined",
  { timeout: 2_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-ilink-spool-timeout-"));
    const spoolDirectory = join(directory, "spool");
    runHook({ pipePath: pipePath(), spoolDirectory });
    let aborted = false;
    const receiver = new HookReceiver({
      onEvent: async (_event, signal) => {
        await new Promise<void>((resolveAbort) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolveAbort();
            },
            { once: true },
          );
        });
      },
      pipePath: pipePath(),
      spoolDeliveryTimeoutMs: 20,
      spoolDirectory,
    });

    try {
      assert.equal(await receiver.drainSpool(), 0);
      assert.equal(aborted, true);
      assert.equal(
        readdirSync(join(spoolDirectory, "dead-letter")).filter((name) =>
          name.endsWith(".json"),
        ).length,
        1,
      );
    } finally {
      await receiver.close();
      rmSync(directory, { force: true, recursive: true });
    }
  },
);

test("dead-letter spool is bounded by age and file count", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-dead-letter-bound-"));
  const spoolDirectory = join(directory, "spool");
  runHook({ pipePath: pipePath(), spoolDirectory });
  const receiver = new HookReceiver({
    onEvent: () => {
      throw new Error("poison event");
    },
    pipePath: pipePath(),
    spoolDirectory,
  });

  try {
    assert.equal(await receiver.drainSpool(), 0);
    const deadLetterDirectory = join(spoolDirectory, "dead-letter");
    const expiredPath = join(
      deadLetterDirectory,
      readdirSync(deadLetterDirectory)[0]!,
    );
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(expiredPath, expired, expired);
    for (let index = 0; index < 130; index += 1) {
      writeFileSync(
        join(deadLetterDirectory, `new-${String(index).padStart(3, "0")}.json`),
        "{}",
      );
    }

    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(existsSync(expiredPath), false);
    assert.equal(readdirSync(deadLetterDirectory).length, 128);

    runHook({ pipePath: pipePath(), spoolDirectory });
    assert.equal(await receiver.drainSpool(), 0);
    assert.equal(readdirSync(deadLetterDirectory).length, 128);
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

function runHook(input: {
  hook?: Record<string, unknown>;
  pipePath: string;
  spoolDirectory: string;
}) {
  return spawnSync(process.execPath, [hookScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ILINK_PIPE_PATH: input.pipePath,
      CODEX_ILINK_SPOOL_DIR: input.spoolDirectory,
    },
    input: JSON.stringify(input.hook ?? hookInput()),
    timeout: 10_000,
  });
}

function runHookAsync(input: {
  hook?: Record<string, unknown>;
  pipePath: string;
  spoolDirectory: string;
}) {
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
      child.stdin.end(JSON.stringify(input.hook ?? hookInput()));
    },
  );
}

function permissionHookInput(): Record<string, unknown> {
  return {
    agent_id: "agent-a",
    agent_type: "main",
    cwd: "D:\\Codex_iLink",
    hook_event_name: "PermissionRequest",
    model: "gpt-test",
    permission_mode: "default",
    request_id: "permission-request-a",
    session_id: "thread-a",
    source: "desktop",
    tool_input: { command: "shutdown /s /t 0" },
    tool_name: "Bash",
    transcript_path: "D:\\CodexState\\transcript.jsonl",
    turn_id: "turn-a",
  };
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
