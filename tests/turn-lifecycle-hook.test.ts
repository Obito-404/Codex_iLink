import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";

const hookScript = resolve(
  "plugins/codex-ilink-probe/scripts/turn-lifecycle-hook.mjs",
);
const hooksManifest = resolve(
  "plugins/codex-ilink-probe/hooks/hooks.json",
);
const threadId = "019f6663-3fa7-7581-93d6-f8a5aee9a067";
const blocked = {
  continue: false,
  stopReason: "CODEX_ILINK_THREAD_BUSY",
  systemMessage: "该会话正在执行另一个回合，请稍后重试。",
};

test("UserPromptSubmit emits telemetry only after the guard decides to fail open", () => {
  const manifest = JSON.parse(readFileSync(hooksManifest, "utf8")) as {
    hooks?: {
      UserPromptSubmit?: Array<{
        hooks?: Array<{ command?: string; commandWindows?: string }>;
      }>;
    };
  };
  const commands = (manifest.hooks?.UserPromptSubmit ?? []).flatMap(
    (group) => group.hooks ?? [],
  );
  assert.equal(commands.length, 1);
  assert.equal(
    commands[0]?.command,
    "ilink __hook turn UserPromptSubmit",
  );
  assert.equal(
    commands[0]?.commandWindows,
    "ilink __hook turn UserPromptSubmit",
  );
});

test("Desktop Stop is reconciled only after the exact turn is terminal", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-lease-"));
  const databasePath = join(directory, "coordination.sqlite");
  const store = new SqliteTurnLeaseStore(databasePath);

  try {
    assertAllowed(
      runHook(databasePath, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-turn-a",
      }),
    );
    assertBlocked(
      runHook(databasePath, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-turn-b",
      }),
    );

    assertAllowed(
      runHook(databasePath, "Stop", {
        hook_event_name: "Stop",
        session_id: threadId,
        turn_id: "desktop-turn-a",
      }),
    );
    assertBlocked(
      runHook(databasePath, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-turn-b",
      }),
    );

    assert.equal(
      store.releaseStoppedDesktop({ threadId, turnId: "desktop-turn-a" }),
      true,
    );
    assertAllowed(
      runHook(databasePath, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-turn-b",
      }),
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("only the owning Bridge instance can claim one concrete turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-lease-"));
  const databasePath = join(directory, "coordination.sqlite");
  const store = new SqliteTurnLeaseStore(databasePath);

  try {
    store.tryAcquire({
      createdAtMs: 1,
      instanceId: "bridge-instance-a",
      operationId: "dispatch-a",
      owner: "bridge",
      threadId,
      turnId: null,
    });

    assertBlocked(
      runHook(
        databasePath,
        "UserPromptSubmit",
        {
          hook_event_name: "UserPromptSubmit",
          session_id: threadId,
          turn_id: "bridge-turn-a",
        },
        {
          CODEX_ILINK_BRIDGE: "1",
          CODEX_ILINK_BRIDGE_INSTANCE: "bridge-instance-b",
        },
      ),
    );
    assertAllowed(
      runHook(
        databasePath,
        "UserPromptSubmit",
        {
          hook_event_name: "UserPromptSubmit",
          session_id: threadId,
          turn_id: "bridge-turn-a",
        },
        {
          CODEX_ILINK_BRIDGE: "1",
          CODEX_ILINK_BRIDGE_INSTANCE: "bridge-instance-a",
        },
      ),
    );
    assertBlocked(
      runHook(
        databasePath,
        "UserPromptSubmit",
        {
          hook_event_name: "UserPromptSubmit",
          session_id: threadId,
          turn_id: "bridge-turn-b",
        },
        {
          CODEX_ILINK_BRIDGE: "1",
          CODEX_ILINK_BRIDGE_INSTANCE: "bridge-instance-a",
        },
      ),
    );
    assert.equal(
      store.release({
        instanceId: "bridge-instance-a",
        operationId: "dispatch-a",
        owner: "bridge",
        threadId,
        turnId: "bridge-turn-a",
      }),
      true,
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Desktop turns are observed fail-open while arbitration is disabled", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-disabled-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const store = new SqliteTurnLeaseStore(databasePath);

  try {
    state.setMainThreadId(threadId);
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-observed-a",
      }),
    );
    assert.equal(store.getLease(threadId)?.turnId, "desktop-observed-a");

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-observed-b",
      }),
    );
    assert.equal(store.getLease(threadId)?.turnId, "desktop-observed-b");

    assertAllowed(
      runProductionHook(localAppData, "Stop", {
        hook_event_name: "Stop",
        session_id: threadId,
        turn_id: "desktop-observed-a",
      }),
    );
    assert.equal(store.getLease(threadId)?.turnId, "desktop-observed-b");
    assertAllowed(
      runProductionHook(localAppData, "Stop", {
        hook_event_name: "Stop",
        session_id: threadId,
        turn_id: "desktop-observed-b",
      }),
    );
    assert.equal(store.getLease(threadId), null);

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-before-enable",
      }),
    );
    state.enableArbitration("bridge-instance");
    assertBlocked(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-after-enable",
      }),
    );
  } finally {
    store.close();
    state.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("an unrelated Desktop turn does not create iLink state before login", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-first-"));
  try {
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: threadId,
        turn_id: "desktop-first-turn",
      }),
    );
    const databasePath = join(localAppData, "Codex_iLink", "state.sqlite");
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("production Hook never gates or records unrelated Desktop project threads", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-scoped-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const store = new SqliteTurnLeaseStore(databasePath);
  const sharedThreadId = "shared-thread";
  const unrelatedThreadId = "unrelated-thread";

  try {
    state.setMainThreadId(sharedThreadId);
    state.setSelectedProjectPath("D:\\Selected");
    state.enableArbitration("bridge-instance");

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "D:\\Other",
        hook_event_name: "UserPromptSubmit",
        session_id: unrelatedThreadId,
        turn_id: "unrelated-turn",
      }),
    );
    assert.equal(store.getLease(unrelatedThreadId), null);
    assert.equal(state.getDesktopTurnObservation(unrelatedThreadId), null);

    assertAllowed(
      runProductionHook(localAppData, "Stop", {
        cwd: "D:\\Other",
        hook_event_name: "Stop",
        session_id: unrelatedThreadId,
        turn_id: "unrelated-turn",
      }),
    );
    assert.equal(state.getDesktopTurnObservation(unrelatedThreadId), null);

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "D:\\Other",
        hook_event_name: "UserPromptSubmit",
        session_id: unrelatedThreadId,
        turn_id: "unrelated-turn",
      }),
    );
    assert.equal(
      state.getDesktopTurnObservation(unrelatedThreadId),
      null,
      "a replayed Prompt must not resurrect the stopped turn",
    );

    assertAllowed(
      runProductionHook(localAppData, "Stop", {
        cwd: "D:\\Other",
        hook_event_name: "Stop",
        session_id: "stop-before-prompt-thread",
        turn_id: "stop-before-prompt-turn",
      }),
    );
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "D:\\Other",
        hook_event_name: "UserPromptSubmit",
        session_id: "stop-before-prompt-thread",
        turn_id: "stop-before-prompt-turn",
      }),
    );
    assert.equal(
      state.getDesktopTurnObservation("stop-before-prompt-thread"),
      null,
      "Stop must suppress a Prompt that is drained later",
    );

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: sharedThreadId,
        turn_id: "shared-turn",
      }),
    );
    assert.equal(store.getLease(sharedThreadId)?.turnId, "shared-turn");
  } finally {
    store.close();
    state.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("production Hook observes only the selected iLink project", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-project-scope-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);

  try {
    state.setMainThreadId("main-thread");
    state.setSelectedProjectPath("D:\\Selected");
    state.enableArbitration("bridge-instance");

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "D:\\Other",
        hook_event_name: "UserPromptSubmit",
        session_id: "other-project-thread",
        turn_id: "other-project-turn",
      }),
    );
    assert.equal(state.getDesktopTurnObservation("other-project-thread"), null);

    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "d:/selected/",
        hook_event_name: "UserPromptSubmit",
        session_id: "selected-project-thread",
        turn_id: "selected-project-turn",
      }),
    );
    assert.equal(
      state.getDesktopTurnObservation("selected-project-thread")?.turnId,
      "selected-project-turn",
    );
  } finally {
    state.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("an observed turn is cleared after iLink selects another project", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-project-change-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);

  try {
    state.setMainThreadId("main-thread");
    state.setSelectedProjectPath("D:\\First");
    state.enableArbitration("bridge-instance");
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "D:\\First",
        hook_event_name: "UserPromptSubmit",
        session_id: "first-project-thread",
        turn_id: "first-project-turn",
      }),
    );
    assert.equal(
      state.getDesktopTurnObservation("first-project-thread")?.turnId,
      "first-project-turn",
    );

    state.setSelectedProjectPath("D:\\Second");
    assertAllowed(
      runProductionHook(localAppData, "Stop", {
        cwd: "D:\\First",
        hook_event_name: "Stop",
        session_id: "first-project-thread",
        turn_id: "first-project-turn",
      }),
    );
    assert.equal(state.getDesktopTurnObservation("first-project-thread"), null);
  } finally {
    state.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("an exact Stop is retained after a guarded Desktop thread becomes unguarded", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-exit-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const store = new SqliteTurnLeaseStore(databasePath);
  const sharedThreadId = "shared-thread";

  try {
    state.setMainThreadId("main-thread");
    state.setBindingForNavigation({
      expiresAtMs: Date.now() + 60_000,
      projectPath: "D:\\Project",
      threadId: sharedThreadId,
      updatedAtMs: 1,
    });
    state.enableArbitration("bridge-instance");
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: sharedThreadId,
        turn_id: "desktop-turn",
      }),
    );
    state.clearNavigationRoutes();
    assertAllowed(
      runProductionHook(localAppData, "Stop", {
        hook_event_name: "Stop",
        session_id: sharedThreadId,
        turn_id: "desktop-turn",
      }),
    );
    assert.equal(
      store.releaseStoppedDesktop({
        threadId: sharedThreadId,
        turnId: "desktop-turn",
      }),
      true,
    );
  } finally {
    store.close();
    state.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("production malformed prompts fail open unless their thread is guarded", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-shape-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);

  try {
    state.setMainThreadId("shared-thread");
    state.enableArbitration("bridge-instance");
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: "unrelated-thread",
      }),
    );
    assertBlocked(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: "shared-thread",
      }),
    );
  } finally {
    state.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("a busy lease database does not spool an unrelated Desktop project thread", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-busy-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const sharedThreadId = "shared-thread";
  const unrelatedThreadId = "unrelated-thread";

    state.setMainThreadId(sharedThreadId);
    state.setSelectedProjectPath("D:\\Selected");
  state.enableArbitration("bridge-instance");
  state.close();

  const blocker = new DatabaseSync(databasePath);
  try {
    blocker.exec("BEGIN IMMEDIATE");
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        cwd: "D:\\Other",
        hook_event_name: "UserPromptSubmit",
        session_id: unrelatedThreadId,
        turn_id: "unrelated-turn",
      }),
    );
    const spoolDirectory = join(dataDirectory, "spool");
    assert.equal(existsSync(spoolDirectory), false);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("a guarded prompt stays observable when disabled arbitration meets a write lock", () => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-hook-disabled-busy-"));
  const dataDirectory = join(localAppData, "Codex_iLink");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const sharedThreadId = "shared-disabled-thread";
  state.setMainThreadId(sharedThreadId);
  state.close();

  const blocker = new DatabaseSync(databasePath);
  try {
    blocker.exec("BEGIN IMMEDIATE");
    assertAllowed(
      runProductionHook(localAppData, "UserPromptSubmit", {
        hook_event_name: "UserPromptSubmit",
        session_id: sharedThreadId,
        turn_id: "shared-disabled-turn",
      }),
    );
    const spoolDirectory = join(dataDirectory, "spool");
    const files = existsSync(spoolDirectory)
      ? readdirSync(spoolDirectory).filter((name) => name.endsWith(".json"))
      : [];
    assert.equal(files.length, 1);
    const event = JSON.parse(
      readFileSync(join(spoolDirectory, files[0]!), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(event.source, "codex-ilink-guard");
    assert.equal(event.sessionId, sharedThreadId);
    assert.equal(event.turnId, "shared-disabled-turn");
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    rmSync(localAppData, { force: true, recursive: true });
  }
});

test("malformed UserPromptSubmit input fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-hook-lease-"));
  try {
    const result = spawnSync(
      process.execPath,
      [hookScript, "UserPromptSubmit"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ILINK_LEASE_DB: join(directory, "coordination.sqlite"),
        },
        input: "not-json",
        timeout: 10_000,
      },
    );
    assertBlocked(result);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runHook(
  databasePath: string,
  expectedEvent: string,
  input: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [hookScript, expectedEvent], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      CODEX_ILINK_LEASE_DB: databasePath,
    },
    input: JSON.stringify(input),
    timeout: 10_000,
  });
}

function runProductionHook(
  localAppData: string,
  expectedEvent: string,
  input: Record<string, unknown>,
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: localAppData,
  };
  delete environment.CODEX_ILINK_BRIDGE;
  delete environment.CODEX_ILINK_BRIDGE_INSTANCE;
  delete environment.CODEX_ILINK_LEASE_DB;
  return spawnSync(process.execPath, [hookScript, expectedEvent], {
    encoding: "utf8",
    env: environment,
    input: JSON.stringify(input),
    timeout: 10_000,
  });
}

function assertAllowed(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "");
}

function assertBlocked(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.status, 0, String(result.stderr));
  assert.deepEqual(JSON.parse(String(result.stdout)), blocked);
}
