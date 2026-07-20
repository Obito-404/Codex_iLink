import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BridgeDaemon } from "../src/daemon/bridge-daemon.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { serializeDurableTurnInput } from "../src/bridge/turn-input.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";
import { HookReceiver } from "../src/hooks/hook-receiver.ts";
import type { ILinkSession } from "../src/ilink/protocol.ts";
import { stageOutboundMedia } from "../src/media/outbound-media.ts";
import { PowerRequestController } from "../src/windows/power-request.ts";

const session: ILinkSession = {
  baseUrl: "https://ilink.example",
  botId: "bot-a",
  botToken: "token",
  controllerUserId: "controller-a",
};

const turnLifecycleHook = resolve(
  "plugins/codex-ilink-probe/scripts/turn-lifecycle-hook.mjs",
);

test("daemon creates one persistent main thread and polls iLink", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new RetryOnceTurnLeaseStore(databasePath);
  const sent: string[] = [];
  let starts = 0;
  let startedPermissions: Record<string, unknown> | undefined;
  const resumed: string[] = [];
  let receiverStarted = 0;
  let spoolDrains = 0;
  let desktopTurnTerminal = false;
  let desktopQueuedStarted = 0;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setDefaultPermissionProfile(":read-only");
  state.setDefaultApprovalPolicy("never");
  state.setDefaultApprovalsReviewer("user");

  const runtime = {
    close() {},
    onEvent() {
      return () => undefined;
    },
    async readThread(input: { threadId: string }) {
      return {
        thread: {
          id: input.threadId,
          turns:
            input.threadId === "thread-desktop" && desktopTurnTerminal
              ? [{ id: "desktop-turn", status: "completed" }]
              : [],
        },
      };
    },
    async resumeThread(threadId: string) {
      resumed.push(threadId);
      return { thread: { id: threadId } };
    },
    async setThreadName() {
      return {};
    },
    async startThread(inputCwd: string, permissions?: Record<string, unknown>) {
      starts += 1;
      startedPermissions = permissions;
      assert.equal(inputCwd, join(directory, "Inbox"));
      return { thread: { id: "thread-main" } };
    },
    async startTurn(input: {
      clientUserMessageId: string;
      text: string;
      threadId: string;
    }) {
      assert.equal(input.text, "queued behind Desktop");
      assert.equal(input.threadId, "thread-desktop");
      desktopQueuedStarted += 1;
      assert.equal(
        leases.claimBridgeTurn({
          instanceId: "bridge-instance",
          threadId: input.threadId,
          turnId: "bridge-after-desktop",
        }),
        true,
      );
      return { turn: { id: "bridge-after-desktop" } };
    },
  };
  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: runtime,
    hookReceiver: {
      async close() {},
      async drainSpool() { spoolDrains += 1; return 0; },
      async start() { receiverStarted += 1; },
    },
    ilink: {
      async getUpdates() {
        return {
          cursor: "cursor-1",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-1",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "help" }, type: 1 }],
              message_id: 1,
            },
          ],
        };
      },
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "outbox-1",
    now: () => 1_000,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.equal(receiverStarted, 1);
    assert.equal(spoolDrains, 1);
    assert.equal(starts, 1);
    assert.deepEqual(startedPermissions, {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":read-only",
    });
    assert.equal(state.getBridgeSettings().mainThreadId, "thread-main");
    assert.deepEqual(state.getBridgeRuntime(), {
      arbitrationEnabled: true,
      instanceId: "bridge-instance",
    });

    assert.deepEqual(await daemon.pollOnce(), { accepted: 1, sent: 1 });
    assert.equal(spoolDrains, 4);
    assert.equal(sent.length, 1);

    leases.tryAcquire({
      createdAtMs: 1_001,
      instanceId: "desktop",
      operationId: "desktop-turn",
      owner: "desktop",
      threadId: "thread-desktop",
      turnId: "desktop-turn",
    });
    leases.markDesktopStop({
      stoppedAtMs: 1_002,
      threadId: "thread-desktop",
      turnId: "desktop-turn",
    });
    state.enqueueQueuedTurn({
      body: turnBody("queued behind Desktop"),
      contextToken: "ctx-desktop-queue",
      createdAtMs: 1_002,
      dedupeKey: "desktop-queued-message",
      threadId: "thread-desktop",
    });
    desktopTurnTerminal = true;
    daemon.ingestHookEvent({
      capturedAtMs: 1_002,
      cwd: "D:\\Project",
      eventName: "Stop",
      model: null,
      permissionMode: null,
      schemaVersion: 1,
      sessionId: "thread-desktop",
      source: null,
      toolName: null,
      turnId: "desktop-turn",
    });
    await waitFor(
      () =>
        !leases.isHeldBy({
          instanceId: "desktop",
          operationId: "desktop-turn",
          owner: "desktop",
          threadId: "thread-desktop",
          turnId: "desktop-turn",
        }),
    );
    await waitFor(() => desktopQueuedStarted === 1);
    assert.equal(leases.releaseAttempts, 2);
    await daemon.stop();
    assert.deepEqual(state.getBridgeRuntime(), {
      arbitrationEnabled: false,
      instanceId: "bridge-instance",
    });

    const restarted = new BridgeDaemon({
      bridgeInstanceId: "bridge-instance-2",
      codex: runtime,
      hookReceiver: {
        async close() {}, async drainSpool() { return 0; }, async start() {},
      },
      ilink: {
        async getUpdates() { return { cursor: "cursor-1", kind: "timeout" as const }; },
        async sendText() { assert.fail("nothing to send"); },
      },
      inboxDirectory: join(directory, "Inbox"),
      leases,
      newId: () => "unused",
      now: () => 2_000,
      session,
      state,
    });
    await restarted.start();
    assert.equal(starts, 1);
    assert.deepEqual(resumed, ["thread-desktop"]);
    await restarted.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon periodically prunes expired transport state and orphaned media", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-media-prune-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const inboxDirectory = join(directory, "Inbox");
  const workspaceRoot = join(directory, "workspace");
  const orphanSource = join(workspaceRoot, "orphan.txt");
  mkdirSync(workspaceRoot);
  writeFileSync(orphanSource, "orphan snapshot");
  const orphanSnapshot = stageOutboundMedia({
    exportRoot: join(directory, "Outbound"),
    label: "orphan.txt",
    path: orphanSource,
    workspaceRoot,
  });
  const dayMs = 24 * 60 * 60 * 1_000;
  let nowMs = 31 * dayMs;
  let protectedKeys: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setMainThreadId("thread-main");
  state.enqueueQueuedTurn({
    body: turnBody("keep media"),
    contextToken: "ctx-media",
    createdAtMs: 1,
    dedupeKey: "bot-a/controller-a/media-message",
    threadId: "thread-media",
  });
  state.enqueueOutbox({
    body: "expired before startup",
    clientId: "codex-ilink:expired-before-startup",
    contextToken: "ctx-expired-startup",
    createdAtMs: 1,
    targetUserId: "controller-a",
  });
  state.confirmOutbox("codex-ilink:expired-before-startup", 1);

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() { return { thread: { status: { type: "active" } } }; },
      async resumeThread() { throw new Error("keep queued"); },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("queued media must not start"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText(input) {
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory,
    leases,
    media: {
      async cleanup() {},
      async prune(activeDedupeKeys) {
        protectedKeys = [...activeDedupeKeys].sort();
        return 0;
      },
      async resolve() {
        assert.fail("startup recovery must use the durable local path");
      },
    },
    newId: () => "unused",
    now: () => nowMs,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.deepEqual(protectedKeys, ["bot-a/controller-a/media-message"]);
    assert.equal(existsSync(orphanSnapshot.path), false);
    assert.equal(state.getOutbox("codex-ilink:expired-before-startup"), null);

    state.enqueueOutbox({
      body: "expired during runtime",
      clientId: "codex-ilink:expired-during-runtime",
      contextToken: "ctx-expired-runtime",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    state.confirmOutbox("codex-ilink:expired-during-runtime", 1);
    nowMs += 60 * 60 * 1_000;
    await daemon.pollOnce();
    assert.equal(state.getOutbox("codex-ilink:expired-during-runtime"), null);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a spooled Desktop prompt is observed before the same iLink batch enters its thread", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-prompt-spool-"));
  const dataDirectory = join(directory, "Codex_iLink");
  const spoolDirectory = join(dataDirectory, "spool");
  const databasePath = join(dataDirectory, "state.sqlite");
  mkdirSync(dataDirectory, { recursive: true });
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const targetThreadId = "thread-desktop-during-poll";
  const sent: string[] = [];
  let starts = 0;
  let daemon!: BridgeDaemon;

  state.setMainThreadId("thread-main");
  state.setSelectedProjectPath("D:\\Project");
  state.bindController({
    accountId: "bot-a",
    boundAtMs: 1,
    userId: "controller-a",
  });
  state.replaceSessionSnapshot({
    archived: false,
    createdAtMs: 1,
    expiresAtMs: 60_000,
    hasNext: false,
    page: 1,
    projectPath: "D:\\Project",
    threads: [
      {
        archived: false,
        projectPath: "D:\\Project",
        threadId: targetThreadId,
      },
    ],
  });

  const hookReceiver = new HookReceiver({
    onEvent: (event) => daemon.ingestHookEvent(event),
    pipePath: testPipePath(),
    spoolDirectory,
  });
  daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() {
        return {
          thread: {
            id: targetThreadId,
            name: "Desktop active thread",
            status: { type: "active" },
            turns: [],
          },
        };
      },
      async resumeThread(threadId: string) {
        return { thread: { id: threadId } };
      },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() {
        starts += 1;
        return { turn: { id: "unsafe-concurrent-turn" } };
      },
    },
    hookReceiver,
    ilink: {
      async getUpdates() {
        const blocker = new DatabaseSync(databasePath);
        try {
          blocker.exec("BEGIN IMMEDIATE");
          const hookEnvironment: NodeJS.ProcessEnv = {
            ...process.env,
            LOCALAPPDATA: directory,
          };
          delete hookEnvironment.CODEX_ILINK_BRIDGE;
          delete hookEnvironment.CODEX_ILINK_BRIDGE_INSTANCE;
          const result = spawnSync(
            process.execPath,
            [turnLifecycleHook, "UserPromptSubmit"],
            {
              encoding: "utf8",
              env: hookEnvironment,
              input: JSON.stringify({
                cwd: "D:\\Project",
                hook_event_name: "UserPromptSubmit",
                session_id: targetThreadId,
                turn_id: "desktop-turn-during-poll",
              }),
              timeout: 10_000,
            },
          );
          assert.equal(result.status, 0, String(result.stderr));
          assert.equal(result.stdout, "", "unrelated Desktop work must stay fail-open");
          assert.equal(
            readdirSync(spoolDirectory).filter((name) => name.endsWith(".json"))
              .length,
            1,
            "the locked observation must be durable before Desktop continues",
          );
        } finally {
          blocker.exec("ROLLBACK");
          blocker.close();
        }
        return {
          cursor: "cursor-prompt-spool",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-go",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "s1" }, type: 1 }],
              message_id: 1,
            },
            {
              context_token: "ctx-body",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "must wait for Desktop" }, type: 1 }],
              message_id: 2,
            },
          ],
        };
      },
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "queued-operation",
    now: () => 10_000,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.deepEqual(await daemon.pollOnce(), { accepted: 2, sent: 2 });
    assert.equal(starts, 0, "WeChat must not start beside the Desktop turn");
    assert.equal(state.countQueuedTurns(), 1);
    const queued = state.peekQueuedTurn(targetThreadId);
    assert.equal(queued?.body, turnBody("must wait for Desktop"));
    assert.equal(queued?.threadId, targetThreadId);
    assert.equal(state.countActiveDispatches(), 0);
    assert.equal(leases.getLease(targetThreadId), null);
    assert.equal(state.getBinding(10_001)?.threadId, targetThreadId);
    assert.equal(
      state.getDesktopTurnObservation(targetThreadId)?.turnId,
      "desktop-turn-during-poll",
    );
    assert.deepEqual(readdirSync(spoolDirectory), []);
    assert.ok(sent.some((text) => /^Queued #\d+$/u.test(text)));
    await daemon.stop();
  } finally {
    await hookReceiver.close().catch(() => undefined);
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("prompt telemetry ignores Bridge and rejected competing Desktop turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-prompt-owner-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() { return { thread: {} }; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { return { thread: { id: "unused" } }; },
      async startTurn() { return { turn: { id: "unused" } }; },
    },
    hookReceiver: {
      async close() {},
      async drainSpool() { return 0; },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText(input) {
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 1,
    session,
    state,
  });

  try {
    assert.equal(
      leases.tryAcquire({
        createdAtMs: 1,
        instanceId: "bridge-instance",
        operationId: "bridge-operation",
        owner: "bridge",
        threadId: "thread-bridge",
        turnId: null,
      }).acquired,
      true,
    );
    await daemon.ingestHookEvent(
      desktopPromptEvent("thread-bridge", "turn-bridge"),
    );
    assert.equal(state.getDesktopTurnObservation("thread-bridge"), null);

    assert.equal(
      leases.tryAcquire({
        createdAtMs: 2,
        instanceId: "desktop",
        operationId: "desktop-turn-a",
        owner: "desktop",
        threadId: "thread-desktop",
        turnId: "desktop-turn-a",
      }).acquired,
      true,
    );
    await daemon.ingestHookEvent(
      desktopPromptEvent("thread-desktop", "desktop-turn-b"),
    );
    assert.equal(state.getDesktopTurnObservation("thread-desktop"), null);

    await daemon.ingestHookEvent(
      desktopPromptEvent("thread-desktop", "desktop-turn-a"),
    );
    assert.equal(
      state.getDesktopTurnObservation("thread-desktop")?.turnId,
      "desktop-turn-a",
    );

    await daemon.ingestHookEvent(
      desktopPromptEvent("thread-unmanaged", "desktop-turn-unmanaged"),
    );
    assert.equal(
      state.getDesktopTurnObservation("thread-unmanaged")?.turnId,
      "desktop-turn-unmanaged",
    );

    await daemon.ingestHookEvent({
      ...desktopPromptEvent("thread-delayed-rejected", "desktop-turn-rejected"),
      source: "desktop-lifecycle-before-guard",
    });
    assert.equal(
      state.getDesktopTurnObservation("thread-delayed-rejected"),
      null,
      "pre-guard telemetry must not create an activity observation",
    );
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a prompt spooled after the poll snapshot is drained between s<n> and body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-message-barrier-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const targetThreadId = "thread-between-messages";
  let daemon!: BridgeDaemon;
  let drainCalls = 0;
  let starts = 0;
  state.setMainThreadId("thread-main");
  state.bindController({
    accountId: "bot-a",
    boundAtMs: 1,
    userId: "controller-a",
  });
  state.replaceSessionSnapshot({
    archived: false,
    createdAtMs: 1,
    expiresAtMs: 60_000,
    hasNext: false,
    page: 1,
    projectPath: "D:\\Project",
    threads: [
      {
        archived: false,
        projectPath: "D:\\Project",
        threadId: targetThreadId,
      },
    ],
  });

  daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() {
        return { thread: { id: targetThreadId, name: "Target", turns: [] } };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() {
        starts += 1;
        return { turn: { id: "unsafe-turn" } };
      },
    },
    hookReceiver: {
      async close() {},
      async drainSpool() {
        drainCalls += 1;
        if (drainCalls === 5) {
          await daemon.ingestHookEvent(
            desktopPromptEvent(targetThreadId, "desktop-between-messages"),
          );
          return 1;
        }
        return 0;
      },
      async start() {},
    },
    ilink: {
      async getUpdates() {
        return {
          cursor: "cursor-message-barrier",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-go",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "s1" }, type: 1 }],
              message_id: 10,
            },
            {
              context_token: "ctx-body",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "wait behind Desktop" }, type: 1 }],
              message_id: 11,
            },
          ],
        };
      },
      async sendText(input) {
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "message-barrier-operation",
    now: () => 10_000,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.deepEqual(await daemon.pollOnce(), { accepted: 2, sent: 2 });
    assert.equal(drainCalls, 5);
    assert.equal(starts, 0);
    assert.equal(
      state.peekQueuedTurn(targetThreadId)?.body,
      turnBody("wait behind Desktop"),
    );
  } finally {
    await daemon.stop().catch(() => undefined);
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon reconciles a spooled Desktop Stop during startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-spool-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  state.setMainThreadId("thread-main");
  state.setBinding({
    expiresAtMs: 100,
    projectPath: "D:\\Project",
    threadId: "thread-desktop",
    updatedAtMs: 1,
  });
  leases.tryAcquire({
    createdAtMs: 1,
    instanceId: "desktop",
    operationId: "desktop-turn",
    owner: "desktop",
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });
  leases.markDesktopStop({
    stoppedAtMs: 2,
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });

  let daemon!: BridgeDaemon;
  let ensured = false;
  daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      async ensureThread(threadId) {
        assert.equal(threadId, "thread-desktop");
        ensured = true;
      },
      onEvent() { return () => undefined; },
      async readThread() {
        if (!ensured) throw new Error("thread not loaded");
        return {
          thread: {
            turns: [{ id: "desktop-turn", status: "completed" }],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {},
      async drainSpool() {
        daemon.ingestHookEvent(desktopStopEvent());
        return 1;
      },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 3,
    session,
    state,
  });

  try {
    await daemon.start();
    await waitFor(
      () =>
        !leases.isHeldBy({
          instanceId: "desktop",
          operationId: "desktop-turn",
          owner: "desktop",
          threadId: "thread-desktop",
          turnId: "desktop-turn",
        }),
    );
    assert.equal(ensured, true);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an unmatched CLI Stop is inspected once and still suppresses a late Prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-stale-stop-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let reads = 0;
  state.setMainThreadId("thread-main");
  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() {
        reads += 1;
        return {
          thread: {
            source: "cli",
            turns: [{ id: "stale-turn", status: "completed" }],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {},
      async drainSpool() { return 0; },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 1,
    presence: async () => "away",
    session,
    state,
  });

  try {
    await daemon.start();
    reads = 0;
    await daemon.ingestHookEvent({
      ...desktopStopEvent(),
      sessionId: "stale-thread",
      turnId: "stale-turn",
    });
    assert.equal(reads, 1);
    assert.deepEqual(state.listPendingOutbox(), []);
    await daemon.ingestHookEvent(
      desktopPromptEvent("stale-thread", "stale-turn"),
    );
    assert.equal(
      state.getDesktopTurnObservation("stale-thread"),
      null,
      "a Prompt drained after its Stop must stay completed",
    );
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an away Desktop completion from an unselected project is sent without changing navigation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-global-notify-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: Array<{ clientId: string; text: string }> = [];
  state.setMainThreadId("thread-main");
  state.setSelectedProjectPath("D:\\Selected");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "help",
        contextToken: "ctx-global-notify",
        messageId: "seed-global-notify",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-global-notify",
    updatedAtMs: 1,
  });
  state.clearInboundBody("bot-a", "controller-a", "seed-global-notify");

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread(input) {
        assert.equal(input.threadId, "other-project-thread");
        return {
          thread: {
            cwd: "D:\\Other",
            name: "跨项目后台任务",
            source: "vscode",
            turns: [
              {
                id: "other-project-turn",
                items: [
                  {
                    content: [{ text: "完成跨项目测试", type: "text" }],
                    type: "userMessage",
                  },
                  {
                    phase: "final_answer",
                    text: "跨项目通知已完成。",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() {
        return { cursor: "cursor-global-notify", kind: "timeout" as const };
      },
      async sendText(input) {
        sent.push(input);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 30_000,
    presence: async () => "away",
    session,
    state,
  });

  try {
    await daemon.start();
    await daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 29_000,
      cwd: "D:\\Other",
      sessionId: "other-project-thread",
      turnId: "other-project-turn",
    });
    await waitFor(() => sent.length === 1);
    assert.match(
      sent[0]?.text ?? "",
      /项目：Other[\s\S]*会话：跨项目后台任务[\s\S]*Codex：跨项目通知已完成/u,
    );
    assert.equal(
      state.getBridgeSettings().selectedProjectPath,
      "D:\\Selected",
    );
    assert.equal(state.getDesktopTurnObservation("other-project-thread"), null);
    assert.equal(leases.getLease("other-project-thread"), null);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("periodic reconciliation requires Stop evidence before releasing a terminal Desktop turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-stale-desktop-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let publicRead: "interrupted" | "notLoaded" = "notLoaded";
  let started = 0;
  const sent: string[] = [];
  state.setMainThreadId("thread-main");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  leases.tryAcquire({
    createdAtMs: 1,
    instanceId: "desktop",
    operationId: "desktop-turn",
    owner: "desktop",
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });
  state.enqueueQueuedTurn({
    body: turnBody("queued after lost Stop"),
    contextToken: "ctx-queued",
    createdAtMs: 2,
    dedupeKey: "queued-after-lost-stop",
    threadId: "thread-desktop",
  });

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread(input) {
        if (input.threadId !== "thread-desktop") {
          return { thread: { turns: [] } };
        }
        if (publicRead === "notLoaded") throw new Error("thread notLoaded");
        return {
          thread: {
            turns: [{ id: "desktop-turn", status: "interrupted" }],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn(input) {
        started += 1;
        assert.equal(input.threadId, "thread-desktop");
        assert.equal(input.text, "queued after lost Stop");
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "bridge-instance",
            threadId: input.threadId,
            turnId: "bridge-after-desktop",
          }),
          true,
        );
        return { turn: { id: "bridge-after-desktop" } };
      },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "bridge-after-desktop-operation",
    now: () => 60_000,
    presence: async () => "away",
    session,
    state,
  });

  try {
    await daemon.start();
    assert.equal(started, 0);
    assert.equal(leases.getLease("thread-desktop")?.owner, "desktop");

    await daemon.pollOnce();
    assert.equal(started, 0, "thread notLoaded must retain the Desktop lease");
    assert.equal(leases.getLease("thread-desktop")?.owner, "desktop");

    publicRead = "interrupted";
    await daemon.pollOnce();
    assert.equal(
      started,
      0,
      "public interrupted state alone is not trustworthy cross-process",
    );
    assert.equal(leases.getLease("thread-desktop")?.owner, "desktop");

    assert.equal(
      leases.markDesktopStop({
        stoppedAtMs: 60_000,
        threadId: "thread-desktop",
        turnId: "desktop-turn",
      }),
      true,
    );
    await daemon.pollOnce();
    assert.equal(started, 1);
    assert.equal(leases.getLease("thread-desktop")?.owner, "bridge");
    assert.deepEqual(sent, []);
    assert.deepEqual(state.listLiveNotificationRoutes(60_001), []);
    assert.equal(
      state.listPendingOutbox().some(({ clientId }) => clientId.includes(":desktop:")),
      false,
    );
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an away Desktop Stop opens its reply route after delivery without replacing an active binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-notify-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let deliveryAvailable = false;
  let desktopTerminal = false;
  let nowMs = 30_000;
  state.setMainThreadId("thread-main");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "help",
        contextToken: "ctx-latest",
        messageId: "seed-context",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-seed",
    updatedAtMs: 1,
  });
  state.clearInboundBody("bot-a", "controller-a", "seed-context");
  state.setBinding({
    expiresAtMs: 60_000,
    projectPath: "D:\\Other",
    threadId: "thread-existing-binding",
    updatedAtMs: 1,
  });
  leases.tryAcquire({
    createdAtMs: 2,
    instanceId: "desktop",
    operationId: "desktop-turn",
    owner: "desktop",
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });
  leases.markDesktopStop({
    stoppedAtMs: 3,
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread(input) {
        return input.includeTurns
          ? {
              thread: {
                turns: [
                  {
                    id: "desktop-turn",
                    status: desktopTerminal ? "completed" : "inProgress",
                  },
                ],
              },
            }
          : { thread: { cwd: "D:\\Project", name: "后台任务" } };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "cursor-seed", kind: "timeout" as const }; },
      async sendText(input) {
        if (!deliveryAvailable) throw new Error("offline");
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => nowMs,
    presence: async () => "away",
    session,
    state,
  });

  try {
    await daemon.start();
    let persisted = false;
    const reconciliation = daemon.ingestHookEvent(desktopStopEvent()).then(() => {
      persisted = true;
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(persisted, false, "the Hook must not be acknowledged before persistence");
    desktopTerminal = true;
    await reconciliation;
    await waitFor(() => state.listPendingOutbox().length === 1);
    assert.deepEqual(state.listLiveNotificationRoutes(nowMs), []);

    deliveryAvailable = true;
    nowMs = 31_000;
    await daemon.pollOnce();
    assert.deepEqual(state.listLiveNotificationRoutes(nowMs), [
      {
        deliveredAtMs: 31_000,
        eventId: "desktop:desktop-turn",
        expiresAtMs: 1_831_000,
        threadId: "thread-desktop",
      },
    ]);
    assert.deepEqual(state.getBinding(nowMs), {
      expiresAtMs: 60_000,
      projectPath: "D:\\Other",
      threadId: "thread-existing-binding",
      updatedAtMs: 1,
    });
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a recently active Desktop completion is sent after five idle minutes without new input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-presence-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: Array<{ clientId: string; text: string }> = [];
  let failLastPart = true;
  let nowMs = 300_000;
  let idleMilliseconds = 60_000;
  state.setMainThreadId("thread-main");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "help",
        contextToken: "ctx-presence",
        messageId: "seed-presence",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-presence",
    updatedAtMs: 1,
  });
  state.clearInboundBody("bot-a", "controller-a", "seed-presence");
  assert.equal(
    leases.tryAcquire({
      createdAtMs: 2,
      instanceId: "desktop",
      operationId: "desktop-turn",
      owner: "desktop",
      threadId: "thread-desktop",
      turnId: "desktop-turn",
    }).acquired,
    true,
  );

  const createDaemon = () => new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() {
        return {
          thread: {
            cwd: "D:\\Project",
            name: "离开后完成",
            turns: [
              {
                id: "desktop-turn",
                items: [
                  {
                    content: [{ text: "检查后台任务", type: "text" }],
                    type: "userMessage",
                  },
                  {
                    phase: "final_answer",
                    text: `${"后台任务已经完成。".repeat(120)}结束。`,
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() {
        return { cursor: "cursor-presence", kind: "timeout" as const };
      },
      async sendText(input) {
        if (failLastPart && input.clientId.endsWith(":part:2")) {
          throw new Error("second part offline");
        }
        sent.push(input);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => nowMs,
    presence: async () => "present",
    presenceObservation: async () => ({
      idleMilliseconds,
      locked: false,
      state: idleMilliseconds >= 5 * 60 * 1_000 ? "away" : "present",
    }),
    session,
    state,
  });
  let daemon = createDaemon();

  try {
    await daemon.start();
    await daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: nowMs,
    });
    assert.equal(sent.length, 0);

    nowMs += 4 * 60 * 1_000;
    idleMilliseconds = 5 * 60 * 1_000;
    await daemon.pollOnce();
    assert.equal(sent.length, 1);
    assert.deepEqual(state.listLiveNotificationRoutes(nowMs), []);

    await daemon.stop();
    failLastPart = false;
    daemon = createDaemon();
    await daemon.start();
    assert.equal(sent.length, 2);
    assert.match(
      sent.map(({ text }) => text).join(""),
      /你问：检查后台任务[\s\S]*Codex：后台任务已经完成/u,
    );
    assert.deepEqual(state.listLiveNotificationRoutes(nowMs), [
      {
        deliveredAtMs: nowMs,
        eventId: "desktop:desktop-turn",
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-desktop",
      },
    ]);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon startup cancels a completion followed by input and sends the unseen completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-presence-restart-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: string[] = [];
  state.setMainThreadId("thread-main");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "help",
        contextToken: "ctx-restart",
        messageId: "seed-restart",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-restart",
    updatedAtMs: 1,
  });
  state.clearInboundBody("bot-a", "controller-a", "seed-restart");
  state.putPendingDesktopNotification({
    completedAtMs: 100_000,
    cwd: "D:\\Project",
    status: "completed",
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });
  state.putPendingDesktopNotification({
    completedAtMs: 40_000,
    cwd: "D:\\Seen",
    status: "completed",
    threadId: "thread-seen-after-completion",
    turnId: "seen-turn",
  });

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() {
        return {
          thread: {
            cwd: "D:\\Project",
            name: "重启恢复任务",
            turns: [
              {
                id: "desktop-turn",
                items: [
                  {
                    phase: "final_answer",
                    text: "重启后成功补发。",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "cursor-restart", kind: "timeout" as const }; },
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 500_000,
    presence: async () => "present",
    presenceObservation: async () => ({
      idleMilliseconds: 450_000,
      locked: false,
      state: "away",
    }),
    session,
    state,
  });

  try {
    await daemon.start();
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /重启后成功补发/u);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Desktop user approval is actionable in WeChat while auto_review stays silent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-permission-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: Array<{ clientId: string; text: string }> = [];
  let blockResume = false;
  let releaseResume!: () => void;
  let resumeStarted!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const resumeObserved = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  let reviewer: "auto_review" | "user" = "user";
  let updates: "approve" | "timeout" = "timeout";
  state.setMainThreadId("thread-main");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "help",
        contextToken: "ctx-permission",
        messageId: "seed-permission",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-permission",
    updatedAtMs: 1,
  });
  state.clearInboundBody("bot-a", "controller-a", "seed-permission");

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      isServerRequestLive() { return true; },
      onEvent() { return () => undefined; },
      async readThread() {
        return { thread: { cwd: "D:\\Project", name: "审批中的任务" } };
      },
      async resumeThread(threadId: string) {
        if (blockResume) {
          resumeStarted();
          await resumeGate;
        }
        return {
          approvalPolicy: "on-request",
          approvalsReviewer: reviewer,
          thread: { id: threadId },
        };
      },
      respondToServerRequest() { return true; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() {
        if (updates === "timeout") {
          return { cursor: "cursor-permission", kind: "timeout" as const };
        }
        updates = "timeout";
        return {
          cursor: "cursor-approved",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-permission",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "ok" }, type: 1 }],
              message_id: 2,
            },
          ],
        };
      },
      async sendText(input) {
        sent.push(input);
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 40_000,
    session,
    state,
  });

  try {
    await daemon.start();
    const approval = daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 40_000,
      eventName: "PermissionRequest",
      requestId: "desktop-request-1",
      requestSummary: "shutdown /s /t 0",
      toolName: "Bash",
    });
    await waitFor(() => sent.length === 1);
    assert.match(sent[0]?.text ?? "", /需要批准[\s\S]*shutdown \/s \/t 0/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /微信不能批准|回到电脑/u);

    updates = "approve";
    await daemon.pollOnce();
    assert.deepEqual(await approval, { behavior: "allow" });

    reviewer = "auto_review";
    assert.deepEqual(await daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 40_001,
      eventName: "PermissionRequest",
      requestId: "desktop-request-2",
      requestSummary: "npm test",
      toolName: "apply_patch",
    }), { behavior: "passthrough" });
    assert.equal(sent.length, 1);

    reviewer = "user";
    assert.deepEqual(await daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 40_002,
      eventName: "PermissionRequest",
      requestSummary: "missing official request id",
      toolName: "Bash",
    }), { behavior: "passthrough" });
    assert.equal(sent.length, 1);

    const shutdownApproval = daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 40_003,
      eventName: "PermissionRequest",
      requestId: "desktop-request-3",
      requestSummary: "npm publish",
      toolName: "Bash",
    });
    await waitFor(() => sent.length === 2);

    blockResume = true;
    const lateShutdownApproval = daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 40_004,
      eventName: "PermissionRequest",
      requestId: "desktop-request-4",
      requestSummary: "late shutdown request",
      toolName: "Bash",
    });
    await resumeObserved;
    await daemon.stop();
    assert.deepEqual(await shutdownApproval, { behavior: "deny" });
    releaseResume();
    assert.deepEqual(await lateShutdownApproval, { behavior: "deny" });
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon holds Windows awake exactly while a WeChat turn is active", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-power-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const powerCommands: boolean[] = [];
  const power = new PowerRequestController(async (required) => {
    powerCommands.push(required);
  });
  let listener: ((event: {
    method: string;
    params: Record<string, unknown>;
  }) => void) | undefined;
  state.setMainThreadId("thread-main");
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const daemon = new BridgeDaemon({
    activeTaskCounter: power,
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
      async readThread() {
        return {
          thread: {
            turns: [
              {
                id: "wechat-turn",
                items: [
                  {
                    phase: "final_answer",
                    text: "完成",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn(input) {
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "bridge-instance",
            threadId: input.threadId,
            turnId: "wechat-turn",
          }),
          true,
        );
        return { turn: { id: "wechat-turn" } };
      },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() {
        return {
          cursor: "cursor-1",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-1",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "执行任务" }, type: 1 }],
              message_id: 1,
            },
          ],
        };
      },
      async sendText() {
        throw new Error("offline");
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "operation-1",
    now: () => 1_000,
    session,
    state,
  });

  try {
    await daemon.start();
    await daemon.pollOnce();
    assert.deepEqual(powerCommands, [true]);

    assert.ok(listener);
    listener({
      method: "turn/completed",
      params: { threadId: "thread-main", turn: { id: "wechat-turn" } },
    });
    await waitFor(() => powerCommands.length === 2);
    assert.deepEqual(powerCommands, [true, false]);
    await daemon.stop();
    await power.close();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon counts an active Desktop lease when deciding whether Windows must stay awake", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-desktop-power-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const activeCounts: number[] = [];
  state.setMainThreadId("thread-main");
  state.setBinding({
    expiresAtMs: 100,
    projectPath: "D:\\Project",
    threadId: "thread-desktop",
    updatedAtMs: 1,
  });
  leases.tryAcquire({
    createdAtMs: 1,
    instanceId: "desktop",
    operationId: "desktop-turn",
    owner: "desktop",
    threadId: "thread-desktop",
    turnId: "desktop-turn",
  });

  const daemon = new BridgeDaemon({
    activeTaskCounter: {
      async setActiveTaskCount(count) {
        activeCounts.push(count);
      },
    },
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() { return { thread: { status: { type: "active" }, turns: [] } }; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 2,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.equal(activeCounts.at(-1), 1);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon polling reconciles an unknown lease after the public thread becomes idle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-periodic-reconcile-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let idle = false;
  state.setMainThreadId("thread-main");
  state.createDispatchIntent({
    body: "unknown across poll",
    contextToken: "ctx-periodic",
    createdAtMs: 1,
    dedupeKey: "periodic-unknown",
    operationId: "periodic-operation",
    threadId: "thread-periodic",
  });
  state.markDispatchUnknown("periodic-operation", 2);
  leases.tryAcquire({
    createdAtMs: 1,
    instanceId: "old-instance",
    operationId: "periodic-operation",
    owner: "bridge",
    threadId: "thread-periodic",
    turnId: null,
  });

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "new-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread({ threadId }) {
        return {
          thread: {
            id: threadId,
            status: { type: idle ? "idle" : "active" },
            turns: [],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("unknown work must not be retried"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 10,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.equal(state.getDispatchIntent("periodic-operation")?.completedAtMs, null);
    idle = true;
    await daemon.pollOnce();
    assert.equal(state.getDispatchIntent("periodic-operation")?.completedAtMs, 10);
    assert.equal(leases.getLease("thread-periodic"), null);
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon handles an asynchronous Codex event failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-event-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  state.setMainThreadId("thread-main");
  state.createDispatchIntent({
    body: "run",
    createdAtMs: 1,
    dedupeKey: "message-1",
    operationId: "operation-1",
    threadId: "thread-main",
  });
  state.markDispatchAccepted("operation-1", "turn-1", 2);
  let listener: ((event: {
    method: string;
    params: Record<string, unknown>;
  }) => void) | undefined;

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
      async readThread() { throw new Error("read failed"); },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 3,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.ok(listener);
    listener({
      method: "turn/completed",
      params: { threadId: "thread-main", turn: { id: "turn-1" } },
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon waits for an in-flight Codex completion before notifyStop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-event-stop-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const order: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setMainThreadId("thread-main");

  let listener: ((event: {
    method: string;
    params: Record<string, unknown>;
  }) => void) | undefined;
  let releaseRead: (() => void) | undefined;
  let queuedStarts = 0;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() { order.push("codex.close"); },
      onEvent(nextListener) {
        listener = nextListener;
        return () => order.push("codex.unsubscribe");
      },
      async readThread() {
        await readGate;
        return {
          thread: {
            status: { type: "idle" },
            turns: [
              {
                id: "turn-event-stop",
                items: [
                  {
                    phase: "final_answer",
                    text: "done",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() {
        queuedStarts += 1;
        return { turn: { id: "must-not-start-during-stop" } };
      },
    },
    hookReceiver: {
      async close() { order.push("hook.close"); },
      async drainSpool() { return 0; },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async notifyStop() { order.push("ilink.notifyStop"); },
      async sendText(input) {
        order.push("ilink.sendText");
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 3,
    session,
    state,
  });

  try {
    await daemon.start();
    state.createDispatchIntent({
      body: "run",
      contextToken: "ctx-event",
      createdAtMs: 1,
      dedupeKey: "message-event-stop",
      operationId: "operation-event-stop",
      threadId: "thread-main",
    });
    state.markDispatchAccepted("operation-event-stop", "turn-event-stop", 2);
    leases.tryAcquire({
      createdAtMs: 1,
      instanceId: "bridge-instance",
      operationId: "operation-event-stop",
      owner: "bridge",
      threadId: "thread-main",
      turnId: "turn-event-stop",
    });
    state.enqueueQueuedTurn({
      body: turnBody("wait until restart"),
      contextToken: "ctx-event",
      createdAtMs: 2,
      dedupeKey: "queued-during-stop",
      threadId: "thread-main",
    });
    assert.ok(listener);
    listener({
      method: "turn/completed",
      params: { threadId: "thread-main", turn: { id: "turn-event-stop" } },
    });
    const stopping = daemon.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const notifyStopRanWhileReadWasBlocked = order.includes("ilink.notifyStop");
    releaseRead?.();
    await stopping;
    await waitFor(() => order.includes("ilink.sendText"));

    assert.equal(notifyStopRanWhileReadWasBlocked, false);
    assert.ok(
      order.indexOf("ilink.sendText") < order.indexOf("ilink.notifyStop"),
    );
    assert.equal(queuedStarts, 0);
  } finally {
    releaseRead?.();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon bounds event quiescence before forcing Codex closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-quiesce-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const order: string[] = [];
  state.setMainThreadId("thread-main");

  let listener: ((event: {
    method: string;
    params: Record<string, unknown>;
  }) => void) | undefined;
  let rejectRead: ((reason: Error) => void) | undefined;
  const readGate = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {
        order.push("codex.close");
        rejectRead?.(new Error("Codex closed"));
      },
      onEvent(nextListener) {
        listener = nextListener;
        return () => order.push("codex.unsubscribe");
      },
      async readThread() { return await readGate; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    eventQuiesceTimeoutMs: 5,
    hookReceiver: {
      async close() { order.push("hook.close"); },
      async drainSpool() { return 0; },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async notifyStop() { order.push("ilink.notifyStop"); },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 3,
    session,
    state,
  });

  try {
    await daemon.start();
    state.createDispatchIntent({
      body: "run",
      contextToken: "ctx-quiesce",
      createdAtMs: 1,
      dedupeKey: "message-quiesce",
      operationId: "operation-quiesce",
      threadId: "thread-main",
    });
    state.markDispatchAccepted("operation-quiesce", "turn-quiesce", 2);
    assert.ok(listener);
    listener({
      method: "turn/completed",
      params: { threadId: "thread-main", turn: { id: "turn-quiesce" } },
    });

    const stopping = daemon.stop();
    const stoppedBeforeFallback = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
    ]);
    if (!stoppedBeforeFallback) rejectRead?.(new Error("test fallback"));
    await stopping;

    assert.equal(stoppedBeforeFallback, true);
    assert.ok(order.indexOf("codex.close") < order.indexOf("ilink.notifyStop"));
    assert.equal(state.getBridgeRuntime()?.arbitrationEnabled, false);
  } finally {
    rejectRead?.(new Error("test cleanup"));
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon startup recovers unprocessed inbound and safe queued turns without retrying unknown work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-recovery-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: Array<{ text: string; threadId: string }> = [];
  const resumed: string[] = [];
  let nextId = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setMainThreadId("thread-main");
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: turnBody("recover inbound"),
        contextToken: "ctx-inbound",
        messageId: "recovery-inbound",
        receivedAtMs: 10,
      },
    ],
    nextCursor: "cursor-recovery",
    updatedAtMs: 11,
  });
  state.enqueueQueuedTurn({
    body: turnBody("recover queued"),
    contextToken: "ctx-queued",
    createdAtMs: 12,
    dedupeKey: "recovery-queued",
    threadId: "thread-queued",
  });
  state.createDispatchIntent({
    body: "must not retry",
    contextToken: "ctx-unknown",
    createdAtMs: 13,
    dedupeKey: "recovery-unknown",
    operationId: "operation-unknown",
    threadId: "thread-unknown",
  });

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() { return { thread: { turns: [] } }; },
      async resumeThread(threadId: string) {
        resumed.push(threadId);
        return { thread: { id: threadId } };
      },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn(input) {
        const turnId = `turn-${String(started.length + 1)}`;
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "bridge-instance",
            threadId: input.threadId,
            turnId,
          }),
          true,
        );
        started.push({ text: input.text, threadId: input.threadId });
        return { turn: { id: turnId } };
      },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async sendText(input) {
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => `recovery-operation-${String(nextId++)}`,
    now: () => 20,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.deepEqual(started, [
      { text: "recover inbound", threadId: "thread-main" },
      { text: "recover queued", threadId: "thread-queued" },
    ]);
    assert.deepEqual(resumed, ["thread-main", "thread-queued"]);
    assert.equal(state.listInboundMessages()[0]?.body, null);
    assert.equal(state.countQueuedTurns(), 0);
    assert.equal(state.getDispatchIntent("operation-unknown")?.status, "unknown");
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the next real controller message retries a delivery deferred for this daemon run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-deferred-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let updateCalls = 0;
  let transportAvailable = false;
  const sendTexts: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setMainThreadId("thread-main");
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "help",
        contextToken: "ctx-duplicate",
        messageId: "900",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-before-duplicate",
    updatedAtMs: 1,
  });
  state.clearInboundBody("bot-a", "controller-a", "900");
  state.enqueueOutbox({
    body: "original undelivered reply",
    clientId: "original-deferred-client",
    contextToken: "ctx-original",
    createdAtMs: 1,
    targetUserId: "controller-a",
  });

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() { return { thread: { turns: [] } }; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("help is handled without a Codex turn"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() {
        updateCalls += 1;
        if (updateCalls === 1) {
          return { cursor: "cursor-timeout", kind: "timeout" as const };
        }
        if (updateCalls === 2) {
          return {
            cursor: "cursor-duplicate",
            kind: "updates" as const,
            messages: [
              {
                context_token: "ctx-duplicate",
                from_user_id: "controller-a",
                item_list: [{ text_item: { text: "help" }, type: 1 }],
                message_id: 900,
              },
            ],
          };
        }
        transportAvailable = true;
        return {
          cursor: "cursor-inbound",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-inbound",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "help" }, type: 1 }],
              message_id: 901,
            },
          ],
        };
      },
      async sendText(input) {
        sendTexts.push(input.text);
        if (!transportAvailable) throw new Error("offline");
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 10,
    session,
    state,
  });

  try {
    await daemon.start();
    assert.equal(sendTexts.length, 3);
    await daemon.pollOnce();
    assert.equal(sendTexts.length, 3, "a timeout must not unlock unbounded retries");

    await daemon.pollOnce();
    assert.equal(sendTexts.length, 3, "a duplicate inbound must not unlock retries");

    await daemon.pollOnce();
    assert.equal(state.getOutbox("original-deferred-client")?.status, "confirmed");
    assert.equal(sendTexts.length, 5);
    assert.equal(sendTexts.at(-2), "original undelivered reply");
    assert.ok(sendTexts.at(-1)?.includes("s<n>"));
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a Desktop approval without a WeChat reply context falls back to Desktop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-no-context-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: Array<{ clientId: string; contextToken: string; text: string }> = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setMainThreadId("thread-main");

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() {
        return { thread: { cwd: "D:\\Project", name: "无上下文审批" } };
      },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("help is handled without a Codex turn"); },
    },
    hookReceiver: {
      async close() {}, async drainSpool() { return 0; }, async start() {},
    },
    ilink: {
      async getUpdates() {
        return {
          cursor: "cursor-first-context",
          kind: "updates" as const,
          messages: [
            {
              context_token: "ctx-first-controller",
              from_user_id: "controller-a",
              item_list: [{ text_item: { text: "help" }, type: 1 }],
              message_id: 1_001,
            },
          ],
        };
      },
      async sendText(input) {
        sent.push(input);
        if (input.text.includes("p — projects")) {
          throw new Error("reply transport failed after accepting inbound");
        }
        return { accepted: true as const, clientId: input.clientId };
      },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "help-reply",
    now: () => 50_000,
    presence: async () => "away",
    session,
    state,
  });

  try {
    await daemon.start();
    assert.deepEqual(await daemon.ingestHookEvent({
      ...desktopStopEvent(),
      capturedAtMs: 49_000,
      eventName: "PermissionRequest",
      requestId: "desktop-without-context",
      requestSummary: "npm publish",
      toolName: "shell_command",
    }), { behavior: "passthrough" });
    assert.deepEqual(state.listPendingOutbox(), []);
    assert.equal(sent.length, 0);

    await assert.rejects(
      daemon.pollOnce(),
      /reply transport failed after accepting inbound/u,
    );
    assert.ok(sent[0]?.text.includes("s<n>"));
    assert.equal(sent[0]?.contextToken, "ctx-first-controller");
    await daemon.stop();
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon announces iLink availability and closes ingress before Codex", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-stop-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const order: string[] = [];
  state.setMainThreadId("thread-main");

  const arbitrationIsEnabled = () =>
    state.getBridgeRuntime()?.arbitrationEnabled === true;
  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {
        assert.equal(arbitrationIsEnabled(), true);
        order.push("codex.close");
      },
      onEvent() {
        return () => {
          assert.equal(arbitrationIsEnabled(), true);
          order.push("codex.unsubscribe");
        };
      },
      async readThread() { return { thread: { turns: [] } }; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {
        assert.equal(arbitrationIsEnabled(), true);
        order.push("hook.close");
      },
      async drainSpool() { return 0; },
      async start() {
        assert.equal(arbitrationIsEnabled(), true);
        order.push("hook.start");
      },
      stopAccepting() {
        assert.equal(arbitrationIsEnabled(), true);
        order.push("hook.stopAccepting");
      },
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async notifyStart() {
        assert.equal(arbitrationIsEnabled(), true);
        order.push("ilink.notifyStart");
      },
      async notifyStop() {
        assert.equal(arbitrationIsEnabled(), true);
        order.push("ilink.notifyStop");
      },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 1,
    session,
    state,
  });

  try {
    await daemon.start();
    await daemon.stop();
    assert.deepEqual(order, [
      "ilink.notifyStart",
      "hook.start",
      "hook.stopAccepting",
      "codex.unsubscribe",
      "codex.close",
      "hook.close",
      "ilink.notifyStop",
    ]);
    assert.equal(arbitrationIsEnabled(), false);
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a throwing lifecycle warning sink cannot break startup or shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-lifecycle-warning-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const warnings: string[] = [];
  state.setMainThreadId("thread-main");

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() {},
      onEvent() { return () => undefined; },
      async readThread() { return { thread: { turns: [] } }; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {},
      async drainSpool() { return 0; },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async notifyStart() { throw new Error("notify start failed"); },
      async notifyStop() { throw new Error("notify stop failed"); },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 1,
    onLifecycleWarning(operation) {
      warnings.push(operation);
      throw new Error("warning sink failed");
    },
    session,
    state,
  });

  try {
    await daemon.start();
    await daemon.stop();
    assert.deepEqual(warnings, ["notifyStart", "notifyStop"]);
    assert.equal(state.getBridgeRuntime()?.arbitrationEnabled, false);
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("daemon finishes shutdown and disables arbitration after a cleanup failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-daemon-stop-failure-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const order: string[] = [];
  state.setMainThreadId("thread-main");

  const daemon = new BridgeDaemon({
    bridgeInstanceId: "bridge-instance",
    codex: {
      close() { order.push("codex.close"); },
      onEvent() { return () => order.push("codex.unsubscribe"); },
      async readThread() { return { thread: { turns: [] } }; },
      async resumeThread(threadId: string) { return { thread: { id: threadId } }; },
      async setThreadName() { return {}; },
      async startThread() { assert.fail("main thread already exists"); },
      async startTurn() { assert.fail("no inbound messages"); },
    },
    hookReceiver: {
      async close() {
        order.push("hook.close");
        throw new Error("hook close failed");
      },
      async drainSpool() { return 0; },
      async start() {},
    },
    ilink: {
      async getUpdates() { return { cursor: "", kind: "timeout" as const }; },
      async notifyStop() { order.push("ilink.notifyStop"); },
      async sendText() { assert.fail("nothing to send"); },
    },
    inboxDirectory: join(directory, "Inbox"),
    leases,
    newId: () => "unused",
    now: () => 1,
    session,
    state,
  });

  try {
    await daemon.start();
    await assert.rejects(daemon.stop(), /E_DAEMON_STOP/u);
    assert.deepEqual(order, [
      "codex.unsubscribe",
      "codex.close",
      "hook.close",
      "ilink.notifyStop",
    ]);
    assert.equal(state.getBridgeRuntime()?.arbitrationEnabled, false);
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

function desktopStopEvent() {
  return {
    capturedAtMs: 2,
    cwd: "D:\\Project",
    eventName: "Stop",
    model: null,
    permissionMode: null,
    schemaVersion: 1 as const,
    sessionId: "thread-desktop",
    source: null,
    toolName: null,
    turnId: "desktop-turn",
  };
}

function desktopPromptEvent(sessionId: string, turnId: string) {
  return {
    ...desktopStopEvent(),
    eventName: "UserPromptSubmit",
    sessionId,
    source: "codex-ilink-guard",
    turnId,
  };
}

function testPipePath(): string {
  const suffix = randomUUID();
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codex-ilink-test-${suffix}`
    : join(tmpdir(), `codex-ilink-test-${suffix}.sock`);
}

function turnBody(text: string): string {
  return serializeDurableTurnInput({ attachments: [], text, version: 1 });
}

class RetryOnceTurnLeaseStore extends SqliteTurnLeaseStore {
  releaseAttempts = 0;

  override releaseStoppedDesktop(input: {
    threadId: string;
    turnId: string;
  }): boolean {
    this.releaseAttempts += 1;
    if (this.releaseAttempts === 1) return false;
    return super.releaseStoppedDesktop(input);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail("timed out waiting for Desktop lease reconciliation");
}
