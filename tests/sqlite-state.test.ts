import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";

test("a constructor waiting on a concurrent migration does not replay a stale schema version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-race-"));
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);
  let child: ChildProcessWithoutNullStreams | null = null;
  let childExit: Promise<number | null> | null = null;

  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    applyMigrations(database, 1, 5);
    database.exec("PRAGMA user_version = 5");

    const stateModuleUrl = new URL(
      "../src/bridge/sqlite-state.ts",
      import.meta.url,
    ).href;
    child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const originalExec = DatabaseSync.prototype.exec;
let configurationPaused = false;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === "BEGIN IMMEDIATE") process.stdout.write("begin-attempt\\n");
  if (!configurationPaused && sql.startsWith("PRAGMA busy_timeout = 5000")) {
    const result = originalExec.call(this, sql);
    configurationPaused = true;
    process.stdout.write("configured\\n");
    readSync(0, Buffer.alloc(1), 0, 1, null);
    return result;
  }
  return originalExec.call(this, sql);
};
const { SqliteState } = await import(${JSON.stringify(stateModuleUrl)});
try {
  const state = new SqliteState(${JSON.stringify(path)});
  process.stdout.write(JSON.stringify(state.storageDiagnostics()) + "\\n");
  state.close();
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exitCode = 1;
}`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    childExit = new Promise<number | null>((resolveExit, rejectExit) => {
      child!.once("error", rejectExit);
      child!.once("close", resolveExit);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    await waitFor(() => stdout.includes("configured\n"));
    database.exec("BEGIN IMMEDIATE");
    child.stdin.end("x");
    await waitFor(() => stdout.includes("begin-attempt\n"));

    applyMigrations(database, 6, 12);
    database
      .prepare(
        `INSERT INTO queued_turns
          (dedupe_key, thread_id, body, created_at_ms, context_token)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("fresh-queue", "thread-race", "must survive", 1, "context-race");
    database.exec("PRAGMA user_version = 12; COMMIT");

    const exitCode = await childExit;
    assert.equal(exitCode, 0, stderr);

    const reopened = new SqliteState(path);
    assert.deepEqual(reopened.storageDiagnostics(), {
      journalMode: "wal",
      schemaVersion: 14,
      synchronous: "full",
    });
    assert.deepEqual(reopened.listQueuedTurns(), [
      {
        body: "must survive",
        contextToken: "context-race",
        createdAtMs: 1,
        dedupeKey: "fresh-queue",
        id: 1,
        threadId: "thread-race",
      },
    ]);
    reopened.close();
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (childExit) {
      try {
        await childExit;
      } catch {}
    }
    if (database.isOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      database.close();
    }
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a failed migration rolls back the entire schema upgrade", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-rollback-"));
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);

  try {
    database.exec("PRAGMA journal_mode = WAL");
    applyMigrations(database, 1, 5);
    database
      .prepare(
        `INSERT INTO queued_turns
          (dedupe_key, thread_id, body, created_at_ms, context_token)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-queue", "thread-rollback", "must remain", 1, "context");
    database.exec(
      `CREATE TABLE thread_permission_profiles (
        thread_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT;
      PRAGMA user_version = 5;`,
    );
    database.close();

    const stateModuleUrl = new URL(
      "../src/bridge/sqlite-state.ts",
      import.meta.url,
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from "node:sqlite";
import { SqliteState } from ${JSON.stringify(stateModuleUrl)};
let migrationError = "";
try {
  new SqliteState(${JSON.stringify(path)});
} catch (error) {
  migrationError = String(error instanceof Error ? error.message : error);
}
const database = new DatabaseSync(${JSON.stringify(path)});
const version = database.prepare("PRAGMA user_version").get().user_version;
const queuedCount = database.prepare("SELECT COUNT(*) AS count FROM queued_turns").get().count;
database.close();
process.stdout.write(JSON.stringify({ migrationError, queuedCount, version }));`,
      ],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      migrationError: "table thread_permission_profiles already exists",
      queuedCount: 1,
      version: 5,
    });
  } finally {
    if (database.isOpen) database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("schema v11 attachment intents migrate as untrusted legacy paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-legacy-outbound-"));
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);
  let migrated: SqliteState | null = null;

  try {
    database.exec("PRAGMA journal_mode = WAL");
    applyMigrations(database, 1, 11);
    database
      .prepare(
        `INSERT INTO outbound_attachment_intents
          (operation_id, thread_id, turn_id, call_id, path, path_key,
           name, kind, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-operation",
        "legacy-thread",
        "legacy-turn",
        "legacy-call",
        "C:\\legacy\\original.txt",
        "c:\\legacy\\original.txt",
        "original.txt",
        "file",
        1,
      );
    database.exec("PRAGMA user_version = 11");
    database.close();

    migrated = new SqliteState(path);
    assert.equal(migrated.storageDiagnostics().schemaVersion, 14);
    assert.equal(
      migrated.listOutboundAttachmentIntents("legacy-turn")[0]
        ?.snapshotProvenance,
      "legacy",
    );
    assert.deepEqual(migrated.listOutboundAttachmentPathKeys(), [
      "c:\\legacy\\original.txt",
    ]);

    migrated.close();
    migrated = null;
    const upgraded = new DatabaseSync(path);
    try {
      upgraded
        .prepare(
          `INSERT INTO outbound_attachment_intents
            (operation_id, thread_id, turn_id, call_id, path, path_key,
             name, kind, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "late-legacy-operation",
          "late-legacy-thread",
          "late-legacy-turn",
          "late-legacy-call",
          "C:\\legacy\\late.txt",
          "c:\\legacy\\late.txt",
          "late.txt",
          "file",
          2,
        );
      upgraded
        .prepare("DELETE FROM outbound_attachment_intents WHERE turn_id = ?")
        .run("late-legacy-turn");
      const protectedPaths = upgraded
        .prepare(
          `SELECT path_key FROM protected_legacy_outbound_paths
           ORDER BY path_key`,
        )
        .all() as Array<{ path_key: string }>;
      assert.deepEqual(
        protectedPaths.map(({ path_key }) => path_key),
        ["c:\\legacy\\late.txt", "c:\\legacy\\original.txt"],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    migrated?.close();
    if (database.isOpen) database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("schema v13 adds bounded transport indexes without losing state", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-v13-indexes-"));
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);
  let state: SqliteState | null = null;

  try {
    database.exec("PRAGMA journal_mode = WAL");
    applyMigrations(database, 1, 12);
    database
      .prepare(
        `INSERT INTO inbound_messages
          (account_id, controller_user_id, message_id, context_token, body,
           received_at_ms)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run("bot-index", "controller-index", "message-index", "ctx-index", 1);
    database.exec("PRAGMA user_version = 12");
    database.close();

    state = new SqliteState(path);
    assert.equal(state.storageDiagnostics().schemaVersion, 14);
    assert.equal(state.listInboundMessages()[0]?.messageId, "message-index");
    state.close();
    state = null;

    const upgraded = new DatabaseSync(path);
    try {
      const indexes = upgraded
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index' AND name IN (
             'dispatch_intents_turn_id',
             'inbound_messages_terminal_retention',
             'notification_routes_expiry',
             'outbox_confirmed_retention'
           )
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      assert.deepEqual(
        indexes.map(({ name }) => name),
        [
          "dispatch_intents_turn_id",
          "inbound_messages_terminal_retention",
          "notification_routes_expiry",
          "outbox_confirmed_retention",
        ],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    state?.close();
    if (database.isOpen) database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("schema v13 gives legacy inbound dedupe a fresh local retention window", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "codex-ilink-state-v13-inbound-retention-"),
  );
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);
  let state: SqliteState | null = null;

  try {
    database.exec("PRAGMA journal_mode = WAL");
    applyMigrations(database, 1, 12);
    database
      .prepare(
        `INSERT INTO inbound_messages
          (account_id, controller_user_id, message_id, context_token, body,
           received_at_ms)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        "bot-legacy-retention",
        "controller-legacy-retention",
        "message-legacy-retention",
        "ctx-legacy-retention",
        0,
      );
    database.exec("PRAGMA user_version = 12");
    database.close();

    state = new SqliteState(path);
    assert.equal(
      state.pruneExpiredTransportState(Date.now()).terminalInboundMessages,
      0,
    );
    assert.deepEqual(
      state.listInboundMessages().map(({ messageId }) => messageId),
      ["message-legacy-retention"],
    );
  } finally {
    state?.close();
    if (database.isOpen) database.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("transport retention starts when an inbound message is accepted locally", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "codex-ilink-state-inbound-acceptance-retention-"),
  );
  const state = new SqliteState(join(directory, "state.db"));
  const dayMs = 24 * 60 * 60 * 1_000;
  const acceptedAtMs = 40 * dayMs;

  try {
    state.bindController({
      accountId: "bot-inbound-acceptance",
      boundAtMs: 1,
      userId: "controller-inbound-acceptance",
    });
    state.acceptInboundBatch({
      accountId: "bot-inbound-acceptance",
      controllerUserId: "controller-inbound-acceptance",
      messages: [
        {
          body: "missing remote timestamp",
          contextToken: "ctx-missing-timestamp",
          messageId: "missing-timestamp",
          receivedAtMs: 0,
        },
        {
          body: "old remote timestamp",
          contextToken: "ctx-old-timestamp",
          messageId: "old-timestamp",
          receivedAtMs: dayMs,
        },
      ],
      nextCursor: "cursor-inbound-acceptance",
      updatedAtMs: acceptedAtMs,
    });
    assert.equal(
      state.clearInboundBody(
        "bot-inbound-acceptance",
        "controller-inbound-acceptance",
        "missing-timestamp",
      ),
      true,
    );
    assert.equal(
      state.clearInboundBody(
        "bot-inbound-acceptance",
        "controller-inbound-acceptance",
        "old-timestamp",
      ),
      true,
    );

    assert.equal(
      state.pruneExpiredTransportState(acceptedAtMs).terminalInboundMessages,
      0,
    );
    assert.deepEqual(
      state.listInboundMessages().map(({ messageId }) => messageId),
      ["missing-timestamp", "old-timestamp"],
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("transport retention deletes only metadata past its safe terminal window", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-retention-"));
  const path = join(directory, "state.db");
  const state = new SqliteState(path);
  const dayMs = 24 * 60 * 60 * 1_000;
  const nowMs = 40 * dayMs;
  const cutoffMs = nowMs - 30 * dayMs;
  const controller = {
    accountId: "bot-retention",
    boundAtMs: 1,
    userId: "controller-retention",
  };
  const dedupeKey = (messageId: string) =>
    `${controller.accountId}/${controller.userId}/${messageId}`;
  const createAcceptedDispatch = (
    name: string,
    dedupe: string,
  ): { operationId: string; turnId: string } => {
    const operationId = `operation-${name}`;
    const turnId = `turn-${name}`;
    state.createDispatchIntent({
      body: `body-${name}`,
      createdAtMs: 1,
      dedupeKey: dedupe,
      operationId,
      threadId: `thread-${name}`,
    });
    state.markDispatchAccepted(operationId, turnId, 2);
    return { operationId, turnId };
  };
  const completeWithFinal = (
    name: string,
    completedAtMs: number,
  ): { clientId: string; operationId: string; turnId: string } => {
    const dispatch = createAcceptedDispatch(name, `dedupe-${name}`);
    const clientId = `codex-ilink:${dispatch.turnId}:final`;
    state.completeDispatchWithOutbox({
      completedAtMs,
      operationId: dispatch.operationId,
      outbox: [
        {
          body: `reply-${name}`,
          clientId,
          contextToken: `context-${name}`,
          createdAtMs: completedAtMs,
          targetUserId: controller.userId,
        },
      ],
      turnId: dispatch.turnId,
    });
    return { clientId, ...dispatch };
  };

  try {
    state.bindController(controller);
    state.acceptInboundBatch({
      accountId: controller.accountId,
      controllerUserId: controller.userId,
      messages: [
        {
          body: "expired terminal",
          contextToken: "ctx-expired",
          messageId: "expired-terminal",
          receivedAtMs: cutoffMs,
        },
      ],
      nextCursor: "cursor-retention-expired",
      updatedAtMs: cutoffMs,
    });
    state.acceptInboundBatch({
      accountId: controller.accountId,
      controllerUserId: controller.userId,
      messages: [
        {
          body: "recent terminal",
          contextToken: "ctx-recent",
          messageId: "recent-terminal",
          receivedAtMs: cutoffMs + 1,
        },
      ],
      nextCursor: "cursor-retention-recent",
      updatedAtMs: cutoffMs + 1,
    });
    state.acceptInboundBatch({
      accountId: controller.accountId,
      controllerUserId: controller.userId,
      messages: [
        {
          body: "still active",
          contextToken: "ctx-body",
          messageId: "active-body",
          receivedAtMs: 1,
        },
        {
          body: "queued",
          contextToken: "ctx-queued",
          messageId: "queued-active",
          receivedAtMs: 1,
        },
        {
          body: "dispatching",
          contextToken: "ctx-dispatch",
          messageId: "dispatch-active",
          receivedAtMs: 1,
        },
        {
          body: "awaiting final delivery",
          contextToken: "ctx-final",
          messageId: "completed-pending-final",
          receivedAtMs: 1,
        },
      ],
      nextCursor: "cursor-retention",
      updatedAtMs: nowMs,
    });
    for (const messageId of [
      "expired-terminal",
      "recent-terminal",
      "queued-active",
      "dispatch-active",
      "completed-pending-final",
    ]) {
      assert.equal(
        state.clearInboundBody(
          controller.accountId,
          controller.userId,
          messageId,
        ),
        true,
      );
    }
    state.enqueueQueuedTurn({
      body: "queued body",
      createdAtMs: 1,
      dedupeKey: dedupeKey("queued-active"),
      threadId: "thread-queued-active",
    });
    state.createDispatchIntent({
      body: "active dispatch body",
      createdAtMs: 1,
      dedupeKey: dedupeKey("dispatch-active"),
      operationId: "operation-active",
      threadId: "thread-dispatch-active",
    });

    const expired = createAcceptedDispatch("expired", "dedupe-expired");
    state.markDispatchCompleted(
      expired.operationId,
      expired.turnId,
      cutoffMs,
    );
    const recent = createAcceptedDispatch("recent", "dedupe-recent");
    state.markDispatchCompleted(
      recent.operationId,
      recent.turnId,
      cutoffMs + 1,
    );
    const pendingFinalDispatch = createAcceptedDispatch(
      "pending-final",
      dedupeKey("completed-pending-final"),
    );
    const pendingFinalClientId =
      `codex-ilink:${pendingFinalDispatch.turnId}:final`;
    state.completeDispatchWithOutbox({
      completedAtMs: cutoffMs,
      operationId: pendingFinalDispatch.operationId,
      outbox: [
        {
          body: "pending final reply",
          clientId: pendingFinalClientId,
          contextToken: "ctx-pending-final",
          createdAtMs: cutoffMs,
          targetUserId: controller.userId,
        },
      ],
      turnId: pendingFinalDispatch.turnId,
    });
    const recentFinal = completeWithFinal("recent-final", cutoffMs);
    state.confirmOutbox(recentFinal.clientId, cutoffMs + 1);
    const expiredFinal = completeWithFinal("expired-final", cutoffMs);
    state.confirmOutbox(expiredFinal.clientId, cutoffMs);
    state.putNotificationRoute({
      deliveredAtMs: nowMs - 1,
      eventId: "route-expired",
      expiresAtMs: nowMs,
      threadId: "thread-route-expired",
    });
    state.putNotificationRoute({
      deliveredAtMs: nowMs,
      eventId: "route-live",
      expiresAtMs: nowMs + 1,
      threadId: "thread-route-live",
    });

    assert.deepEqual(state.pruneExpiredTransportState(nowMs), {
      completedDispatchIntents: 2,
      confirmedOutbox: 1,
      expiredNotificationRoutes: 1,
      terminalInboundMessages: 1,
    });
    assert.deepEqual(
      state.listInboundMessages().map(({ messageId }) => messageId),
      [
        "recent-terminal",
        "active-body",
        "queued-active",
        "dispatch-active",
        "completed-pending-final",
      ],
    );
    assert.equal(state.getDispatchIntent(expired.operationId), null);
    assert.equal(state.getDispatchIntent(expiredFinal.operationId), null);
    assert.notEqual(state.getDispatchIntent(recent.operationId), null);
    assert.notEqual(
      state.getDispatchIntent(pendingFinalDispatch.operationId),
      null,
    );
    assert.notEqual(state.getDispatchIntent(recentFinal.operationId), null);
    assert.equal(state.getOutbox(expiredFinal.clientId), null);
    assert.equal(state.getOutbox(pendingFinalClientId)?.status, "pending");
    assert.equal(state.getOutbox(recentFinal.clientId)?.status, "confirmed");
    assert.deepEqual(state.listLiveNotificationRoutes(nowMs), [
      {
        deliveredAtMs: nowMs,
        eventId: "route-live",
        expiresAtMs: nowMs + 1,
        threadId: "thread-route-live",
      },
    ]);

    state.confirmOutbox(pendingFinalClientId, nowMs);
    const futureNowMs = nowMs + 31 * dayMs;
    assert.deepEqual(state.pruneExpiredTransportState(futureNowMs), {
      completedDispatchIntents: 3,
      confirmedOutbox: 2,
      expiredNotificationRoutes: 1,
      terminalInboundMessages: 2,
    });
    assert.deepEqual(
      state.listInboundMessages().map(({ messageId }) => messageId),
      ["active-body", "queued-active", "dispatch-active"],
    );
    assert.deepEqual(state.pruneExpiredTransportState(futureNowMs), {
      completedDispatchIntents: 0,
      confirmedOutbox: 0,
      expiredNotificationRoutes: 0,
      terminalInboundMessages: 0,
    });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("controller identity and database configuration survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");

  try {
    const first = new SqliteState(path);
    assert.deepEqual(first.storageDiagnostics(), {
      journalMode: "wal",
      schemaVersion: 14,
      synchronous: "full",
    });
    assert.deepEqual(
      first.bindController({
        accountId: "bot-account",
        boundAtMs: 1_721_000_000_000,
        userId: "wechat-user",
      }),
      {
        accountId: "bot-account",
        boundAtMs: 1_721_000_000_000,
        userId: "wechat-user",
      },
    );
    assert.equal(first.isController("bot-account", "wechat-user"), true);
    assert.equal(first.isController("bot-account", "someone-else"), false);
    assert.throws(
      () =>
        first.bindController({
          accountId: "bot-account",
          boundAtMs: 1_721_000_000_001,
          userId: "someone-else",
        }),
      /controller mismatch/u,
    );
    first.close();

    const reopened = new SqliteState(path);
    assert.deepEqual(reopened.getController(), {
      accountId: "bot-account",
      boundAtMs: 1_721_000_000_000,
      userId: "wechat-user",
    });
    reopened.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("schema v14 removes legacy local permission profiles", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-permissions-v14-"));
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);
  let migrated: SqliteState | null = null;

  try {
    applyMigrations(database, 1, 13);
    database.exec("PRAGMA user_version = 13");
    database
      .prepare(
        `INSERT INTO thread_permission_profiles
          (thread_id, profile_id, approval_policy, approvals_reviewer, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "thread-legacy-permission",
        ":danger-full-access",
        "never",
        "user",
        300,
      );
    database.close();

    migrated = new SqliteState(path);
    assert.equal(migrated.storageDiagnostics().schemaVersion, 14);
    migrated.close();
    migrated = null;

    const inspected = new DatabaseSync(path);
    try {
      assert.equal(
        inspected
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name = 'thread_permission_profiles'`,
          )
          .get(),
        undefined,
      );
    } finally {
      inspected.close();
    }
  } finally {
    migrated?.close();
    try {
      database.close();
    } catch {}
    rmSync(directory, { force: true, recursive: true });
  }
});

test("inbound messages and the polling cursor commit together with deduplication", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.bindController({
      accountId: "bot-account",
      boundAtMs: 1,
      userId: "wechat-user",
    });

    assert.deepEqual(
      state.acceptInboundBatch({
        accountId: "bot-account",
        controllerUserId: "wechat-user",
        messages: [
          {
            body: "first request",
            contextToken: "context-1",
            messageId: "1001",
            receivedAtMs: 10,
          },
          {
            body: "second request",
            contextToken: "context-2",
            messageId: "1002",
            receivedAtMs: 11,
          },
        ],
        nextCursor: "cursor-1",
        updatedAtMs: 12,
      }),
      { acceptedMessageIds: ["1001", "1002"], duplicateCount: 0 },
    );

    assert.deepEqual(
      state.acceptInboundBatch({
        accountId: "bot-account",
        controllerUserId: "wechat-user",
        messages: [
          {
            body: "duplicate must not replace original",
            contextToken: "context-2",
            messageId: "1002",
            receivedAtMs: 13,
          },
        ],
        nextCursor: "cursor-2",
        updatedAtMs: 14,
      }),
      { acceptedMessageIds: [], duplicateCount: 1 },
    );

    assert.deepEqual(state.getILinkState("bot-account"), {
      contextToken: "context-2",
      cursor: "cursor-2",
      updatedAtMs: 14,
    });
    assert.deepEqual(
      state.listInboundMessages().map(({ body, messageId }) => ({ body, messageId })),
      [
        { body: "first request", messageId: "1001" },
        { body: "second request", messageId: "1002" },
      ],
    );

    assert.throws(
      () =>
        state.acceptInboundBatch({
          accountId: "bot-account",
          controllerUserId: "intruder",
          messages: [],
          nextCursor: "attacker-cursor",
          updatedAtMs: 15,
        }),
      /controller mismatch/u,
    );
    assert.equal(state.getILinkState("bot-account")?.cursor, "cursor-2");
    assert.throws(
      () =>
        state.acceptInboundBatch({
          accountId: "bot-account",
          controllerUserId: "wechat-user",
          messages: [
            {
              body: "invalid timestamp",
              contextToken: "context-invalid",
              messageId: "1003",
              receivedAtMs: -1,
            },
          ],
          nextCursor: "invalid-cursor",
          updatedAtMs: 16,
        }),
      /constraint failed/u,
    );
    assert.equal(state.getILinkState("bot-account")?.cursor, "cursor-2");
    assert.equal(state.listInboundMessages().length, 2);
    assert.equal(
      state.clearInboundBody("bot-account", "wechat-user", "missing"),
      false,
    );
    assert.equal(
      state.clearInboundBody("bot-account", "wechat-user", "1001"),
      true,
    );
    assert.equal(
      state.listInboundMessages().find(({ messageId }) => messageId === "1001")?.body,
      null,
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("inbound dedupe lookup returns only matching candidate ids for the controller", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-dedupe-lookup-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.bindController({
      accountId: "bot-account",
      boundAtMs: 1,
      userId: "wechat-user",
    });
    state.acceptInboundBatch({
      accountId: "bot-account",
      controllerUserId: "wechat-user",
      messages: [
        {
          body: "first request",
          contextToken: "context-1",
          messageId: "1001",
          receivedAtMs: 10,
        },
        {
          body: "second request",
          contextToken: "context-2",
          messageId: "1002",
          receivedAtMs: 11,
        },
      ],
      nextCursor: "cursor-1",
      updatedAtMs: 12,
    });

    assert.deepEqual(
      state.findExistingInboundMessageIds({
        accountId: "bot-account",
        candidateMessageIds: ["1002", "missing", "1002"],
        controllerUserId: "wechat-user",
      }),
      new Set(["1002"]),
    );
    assert.deepEqual(
      state.findExistingInboundMessageIds({
        accountId: "other-account",
        candidateMessageIds: ["1001", "1002"],
        controllerUserId: "wechat-user",
      }),
      new Set(),
    );
    assert.deepEqual(
      state.findExistingInboundMessageIds({
        accountId: "bot-account",
        candidateMessageIds: ["1001", "1002"],
        controllerUserId: "other-user",
      }),
      new Set(),
    );
    assert.deepEqual(
      state.findExistingInboundMessageIds({
        accountId: "bot-account",
        candidateMessageIds: [],
        controllerUserId: "wechat-user",
      }),
      new Set(),
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("inbound dedupe lookup chunks oversized candidate batches", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-dedupe-chunks-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.bindController({
      accountId: "bot-account",
      boundAtMs: 1,
      userId: "wechat-user",
    });
    state.acceptInboundBatch({
      accountId: "bot-account",
      controllerUserId: "wechat-user",
      messages: [
        {
          body: "existing request",
          contextToken: "context-existing",
          messageId: "existing",
          receivedAtMs: 10,
        },
      ],
      nextCursor: "cursor-1",
      updatedAtMs: 11,
    });
    const candidateMessageIds = Array.from(
      { length: 33_000 },
      (_, index) => `missing-${String(index)}`,
    );
    candidateMessageIds.push("existing");

    assert.deepEqual(
      state.findExistingInboundMessageIds({
        accountId: "bot-account",
        candidateMessageIds,
        controllerUserId: "wechat-user",
      }),
      new Set(["existing"]),
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("binding, notification routes, and queued turns preserve routing order", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.setBinding({
      expiresAtMs: 500,
      projectPath: "D:\\Project",
      threadId: "thread-a",
      updatedAtMs: 100,
    });
    assert.deepEqual(state.getBinding(499), {
      expiresAtMs: 500,
      projectPath: "D:\\Project",
      threadId: "thread-a",
      updatedAtMs: 100,
    });
    assert.equal(state.getBinding(500), null);

    state.putNotificationRoute({
      deliveredAtMs: 101,
      eventId: "event-a",
      expiresAtMs: 300,
      threadId: "thread-a",
    });
    state.putNotificationRoute({
      deliveredAtMs: 102,
      eventId: "event-b",
      expiresAtMs: 400,
      threadId: "thread-b",
    });
    assert.deepEqual(
      state.listLiveNotificationRoutes(300).map(({ eventId }) => eventId),
      ["event-b"],
    );

    const first = state.enqueueQueuedTurn({
      body: "first",
      contextToken: "context-first",
      createdAtMs: 110,
      dedupeKey: "bot/user/1001",
      threadId: "thread-a",
    });
    const second = state.enqueueQueuedTurn({
      body: "second",
      contextToken: "context-second",
      createdAtMs: 109,
      dedupeKey: "bot/user/1002",
      threadId: "thread-a",
    });
    assert.equal(state.peekQueuedTurn("thread-a")?.id, first.id);
    assert.equal(state.peekQueuedTurn("thread-a")?.contextToken, "context-first");
    assert.equal(state.deleteQueuedTurn(first.id), true);
    assert.equal(state.peekQueuedTurn("thread-a")?.id, second.id);
    assert.throws(
      () =>
        state.enqueueQueuedTurn({
          body: "duplicate",
          contextToken: "context-duplicate",
          createdAtMs: 111,
          dedupeKey: "bot/user/1002",
          threadId: "thread-a",
        }),
      /queued turn already exists/u,
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("queued rejection and failure outbox commit atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-queued-rejection-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    const first = state.enqueueQueuedTurn({
      body: "first",
      contextToken: "context-first",
      createdAtMs: 1,
      dedupeKey: "dedupe-first",
      threadId: "thread-first",
    });
    const rejected = state.rejectQueuedTurnWithOutbox({
      dedupeKey: first.dedupeKey,
      queuedTurnId: first.id,
      threadId: first.threadId,
      outbox: {
        body: "resume failed",
        clientId: "queued-first-failed",
        contextToken: "context-first",
        createdAtMs: 2,
        targetUserId: "wechat-user",
      },
    });
    assert.ok(rejected);
    assert.equal(state.peekQueuedTurn("thread-first"), null);
    assert.equal(rejected.status, "pending");
    assert.equal(state.getOutbox("queued-first-failed")?.body, "resume failed");

    const second = state.enqueueQueuedTurn({
      body: "second",
      contextToken: "context-second",
      createdAtMs: 3,
      dedupeKey: "dedupe-second",
      threadId: "thread-second",
    });
    state.enqueueOutbox({
      body: "existing",
      clientId: "queued-collision",
      contextToken: "context-second",
      createdAtMs: 4,
      targetUserId: "wechat-user",
    });
    assert.throws(
      () =>
        state.rejectQueuedTurnWithOutbox({
          dedupeKey: second.dedupeKey,
          queuedTurnId: second.id,
          threadId: second.threadId,
          outbox: {
            body: "different",
            clientId: "queued-collision",
            contextToken: "context-second",
            createdAtMs: 5,
            targetUserId: "wechat-user",
          },
        }),
      /client id collision/u,
    );
    assert.equal(state.peekQueuedTurn("thread-second")?.id, second.id);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a stale queued drainer cannot touch a replacement that reused its integer id", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-queued-reuse-"));
  const databasePath = join(directory, "state.db");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);

  try {
    const original = state.enqueueQueuedTurn({
      body: "original body",
      contextToken: "context-original",
      createdAtMs: 1,
      dedupeKey: "dedupe-original",
      threadId: "thread-original",
    });
    const originalLease = leases.tryAcquire({
      createdAtMs: 2,
      instanceId: "bridge-original",
      operationId: "operation-original",
      owner: "bridge",
      threadId: original.threadId,
      turnId: null,
    });
    assert.equal(originalLease.acquired, true);
    if (!originalLease.acquired) assert.fail("expected original lease");
    assert.equal(leases.release(originalLease.lease), true);
    assert.ok(
      state.rejectQueuedTurnWithOutbox({
        dedupeKey: original.dedupeKey,
        queuedTurnId: original.id,
        threadId: original.threadId,
        outbox: {
          body: "original removed",
          clientId: "queued-original-removed",
          contextToken: original.contextToken,
          createdAtMs: 3,
          targetUserId: "wechat-user",
        },
      }),
    );

    const replacement = state.enqueueQueuedTurn({
      body: "replacement body",
      contextToken: "context-replacement",
      createdAtMs: 4,
      dedupeKey: "dedupe-replacement",
      threadId: "thread-replacement",
    });
    assert.equal(replacement.id, original.id);
    const replacementLease = leases.tryAcquire({
      createdAtMs: 5,
      instanceId: "bridge-replacement",
      operationId: "operation-replacement",
      owner: "bridge",
      threadId: replacement.threadId,
      turnId: null,
    });
    assert.equal(replacementLease.acquired, true);
    if (!replacementLease.acquired) assert.fail("expected replacement lease");

    assert.equal(
      state.rejectQueuedTurnAndReleaseLeaseWithOutbox({
        dedupeKey: original.dedupeKey,
        lease: originalLease.lease,
        queuedTurnId: original.id,
        threadId: original.threadId,
        outbox: {
          body: "stale rejection",
          clientId: "queued-stale-rejection",
          contextToken: original.contextToken,
          createdAtMs: 6,
          targetUserId: "wechat-user",
        },
      }),
      null,
    );
    assert.deepEqual(
      state.promoteQueuedTurnWithLease({
        contextToken: original.contextToken,
        createdAtMs: 7,
        dedupeKey: original.dedupeKey,
        lease: originalLease.lease,
        maxActiveDispatches: 3,
        operationId: originalLease.lease.operationId,
        queuedTurnId: original.id,
        threadId: original.threadId,
      }),
      { kind: "stale" },
    );
    assert.deepEqual(state.peekQueuedTurn(replacement.threadId), replacement);
    assert.deepEqual(
      leases.getLease(replacement.threadId),
      replacementLease.lease,
    );
    assert.equal(state.getOutbox("queued-stale-rejection"), null);

    const promoted = state.promoteQueuedTurnWithLease({
      contextToken: replacement.contextToken,
      createdAtMs: 8,
      dedupeKey: replacement.dedupeKey,
      lease: replacementLease.lease,
      maxActiveDispatches: 3,
      operationId: replacementLease.lease.operationId,
      queuedTurnId: replacement.id,
      threadId: replacement.threadId,
    });
    assert.equal(promoted.kind, "promoted");
    assert.deepEqual(
      promoted.kind === "promoted"
        ? {
            body: promoted.dispatch.body,
            dedupeKey: promoted.dispatch.dedupeKey,
            threadId: promoted.dispatch.threadId,
          }
        : null,
      {
        body: replacement.body,
        dedupeKey: replacement.dedupeKey,
        threadId: replacement.threadId,
      },
    );
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("inbound rejection releases only its exact lease in the same transaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-inbound-rejection-"));
  const databasePath = join(directory, "state.db");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const accountId = "bot-inbound-rejection";
  const controllerUserId = "controller-inbound-rejection";

  try {
    state.bindController({ accountId, boundAtMs: 1, userId: controllerUserId });
    state.acceptInboundBatch({
      accountId,
      controllerUserId,
      messages: [
        {
          body: "first message",
          contextToken: "context-first",
          messageId: "message-first",
          receivedAtMs: 1,
        },
      ],
      nextCursor: "cursor-first",
      updatedAtMs: 1,
    });
    const firstLease = leases.tryAcquire({
      createdAtMs: 2,
      instanceId: "bridge-first",
      operationId: "operation-first",
      owner: "bridge",
      threadId: "thread-first",
      turnId: null,
    });
    assert.equal(firstLease.acquired, true);
    if (!firstLease.acquired) assert.fail("expected first lease");

    const rejected = state.rejectInboundMessageAndReleaseLeaseWithOutbox({
      accountId,
      controllerUserId,
      lease: firstLease.lease,
      messageId: "message-first",
      outbox: {
        body: "resume failed",
        clientId: "inbound-first-failed",
        contextToken: "context-first",
        createdAtMs: 3,
        targetUserId: controllerUserId,
      },
    });
    assert.ok(rejected);
    assert.equal(rejected.status, "pending");
    assert.equal(leases.getLease("thread-first"), null);
    assert.equal(state.listInboundMessages()[0]?.body, null);
    assert.equal(state.getOutbox("inbound-first-failed")?.body, "resume failed");

    const staleLease = leases.tryAcquire({
      createdAtMs: 4,
      instanceId: "bridge-stale",
      operationId: "operation-stale",
      owner: "bridge",
      threadId: "thread-first",
      turnId: null,
    });
    assert.equal(staleLease.acquired, true);
    if (!staleLease.acquired) assert.fail("expected stale lease");
    assert.equal(leases.release(staleLease.lease), true);
    const replacementLease = leases.tryAcquire({
      createdAtMs: 5,
      instanceId: "bridge-replacement",
      operationId: "operation-replacement",
      owner: "bridge",
      threadId: "thread-first",
      turnId: null,
    });
    assert.equal(replacementLease.acquired, true);
    if (!replacementLease.acquired) assert.fail("expected replacement lease");
    assert.deepEqual(
      state.admitInboundDispatchWithLease({
        accountId,
        body: "first message",
        contextToken: "context-first",
        controllerUserId,
        createdAtMs: 4,
        dedupeKey: `${accountId}/${controllerUserId}/message-first`,
        lease: staleLease.lease,
        maxActiveDispatches: 3,
        messageId: "message-first",
        operationId: "operation-stale",
        threadId: "thread-first",
      }),
      { kind: "terminal" },
    );
    assert.deepEqual(
      leases.getLease("thread-first"),
      replacementLease.lease,
    );
    assert.equal(state.getDispatchIntent("operation-stale"), null);
    assert.equal(
      state.rejectInboundMessageAndReleaseLeaseWithOutbox({
        accountId,
        controllerUserId,
        lease: staleLease.lease,
        messageId: "message-first",
        outbox: {
          body: "stale failure must not be sent",
          clientId: "inbound-stale-failed",
          contextToken: "context-first",
          createdAtMs: 5,
          targetUserId: controllerUserId,
        },
      }),
      null,
    );
    assert.deepEqual(
      leases.getLease("thread-first"),
      replacementLease.lease,
    );
    assert.equal(state.getOutbox("inbound-stale-failed"), null);
    assert.equal(leases.release(replacementLease.lease), true);

    state.acceptInboundBatch({
      accountId,
      controllerUserId,
      messages: [
        {
          body: "second message",
          contextToken: "context-second",
          messageId: "message-second",
          receivedAtMs: 4,
        },
      ],
      nextCursor: "cursor-second",
      updatedAtMs: 4,
    });
    const secondLease = leases.tryAcquire({
      createdAtMs: 5,
      instanceId: "bridge-second",
      operationId: "operation-second",
      owner: "bridge",
      threadId: "thread-second",
      turnId: null,
    });
    assert.equal(secondLease.acquired, true);
    if (!secondLease.acquired) assert.fail("expected second lease");

    assert.throws(
      () =>
        state.rejectInboundMessageAndReleaseLeaseWithOutbox({
          accountId,
          controllerUserId,
          lease: { ...secondLease.lease, operationId: "wrong-operation" },
          messageId: "message-second",
          outbox: {
            body: "must roll back",
            clientId: "inbound-second-failed",
            contextToken: "context-second",
            createdAtMs: 6,
            targetUserId: controllerUserId,
          },
        }),
      /lost lease ownership/u,
    );
    assert.deepEqual(leases.getLease("thread-second"), secondLease.lease);
    assert.equal(
      state
        .listInboundMessages()
        .find(({ messageId }) => messageId === "message-second")?.body,
      "second message",
    );
    assert.equal(state.getOutbox("inbound-second-failed"), null);

    const admitted = state.admitInboundDispatchWithLease({
      accountId,
      body: "second message",
      contextToken: "context-second",
      controllerUserId,
      createdAtMs: 7,
      dedupeKey: `${accountId}/${controllerUserId}/message-second`,
      lease: secondLease.lease,
      maxActiveDispatches: 3,
      messageId: "message-second",
      operationId: "operation-second",
      threadId: "thread-second",
    });
    assert.equal(admitted.kind, "created");
    const lateRejectLease = leases.tryAcquire({
      createdAtMs: 8,
      instanceId: "bridge-late-reject",
      operationId: "operation-late-reject",
      owner: "bridge",
      threadId: "thread-late-reject",
      turnId: null,
    });
    assert.equal(lateRejectLease.acquired, true);
    if (!lateRejectLease.acquired) assert.fail("expected late rejection lease");
    assert.equal(
      state.rejectInboundMessageAndReleaseLeaseWithOutbox({
        accountId,
        controllerUserId,
        lease: lateRejectLease.lease,
        messageId: "message-second",
        outbox: {
          body: "must not be sent",
          clientId: "inbound-late-failed",
          contextToken: "context-second",
          createdAtMs: 9,
          targetUserId: controllerUserId,
        },
      }),
      null,
    );
    assert.equal(leases.getLease("thread-late-reject"), null);
    assert.deepEqual(leases.getLease("thread-second"), secondLease.lease);
    assert.equal(
      state.getDispatchIntent("operation-second")?.dedupeKey,
      `${accountId}/${controllerUserId}/message-second`,
    );
    assert.equal(state.getOutbox("inbound-late-failed"), null);
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("changing the session timeout immediately recalculates an active binding", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-timeout-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.setBinding({
      expiresAtMs: 1_800_100,
      projectPath: "D:\\Project",
      threadId: "thread-configured",
      updatedAtMs: 100,
    });

    state.setSessionTimeoutMinutes(60, 1_000);
    assert.equal(state.getBinding(3_600_099)?.expiresAtMs, 3_600_100);

    state.resetUserTimingSettings(1_000);
    assert.equal(state.getBinding(1_800_099)?.expiresAtMs, 1_800_100);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Desktop observations require an exact Stop before release", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-observation-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.observeDesktopTurn({
      createdAtMs: 1,
      threadId: "thread-observed",
      turnId: "turn-a",
    });
    assert.deepEqual(state.getDesktopTurnObservation("thread-observed"), {
      createdAtMs: 1,
      stopSeenAtMs: null,
      threadId: "thread-observed",
      turnId: "turn-a",
    });
    assert.equal(
      state.markDesktopTurnObservationStopped({
        stoppedAtMs: 2,
        threadId: "thread-observed",
        turnId: "wrong-turn",
      }),
      false,
    );
    assert.equal(
      state.releaseStoppedDesktopTurnObservation({
        threadId: "thread-observed",
        turnId: "turn-a",
      }),
      false,
    );
    assert.equal(
      state.markDesktopTurnObservationStopped({
        stoppedAtMs: 3,
        threadId: "thread-observed",
        turnId: "turn-a",
      }),
      true,
    );
    assert.equal(state.listStoppedDesktopTurnObservations().length, 1);
    assert.equal(
      state.releaseStoppedDesktopTurnObservation({
        threadId: "thread-observed",
        turnId: "turn-a",
      }),
      true,
    );
    assert.equal(state.getDesktopTurnObservation("thread-observed"), null);
    assert.equal(
      state.observeDesktopTurn({
        createdAtMs: 1,
        threadId: "thread-observed",
        turnId: "turn-a",
      }),
      false,
      "a delayed Prompt copy must not resurrect a completed observation",
    );
    assert.equal(state.getDesktopTurnObservation("thread-observed"), null);
    assert.equal(
      state.observeDesktopTurn({
        createdAtMs: 4,
        threadId: "thread-observed",
        turnId: "turn-b",
      }),
      true,
    );
    assert.equal(
      state.observeDesktopTurn({
        createdAtMs: 2,
        threadId: "thread-observed",
        turnId: "turn-older",
      }),
      false,
    );
    assert.equal(
      state.getDesktopTurnObservation("thread-observed")?.turnId,
      "turn-b",
    );
    const afterTombstoneExpiry = 3 + 7 * 24 * 60 * 60 * 1_000 + 1;
    assert.equal(
      state.pruneExpiredDesktopObservationTombstones(afterTombstoneExpiry),
      1,
    );
    assert.equal(
      state.observeDesktopTurn({
        createdAtMs: afterTombstoneExpiry,
        threadId: "thread-observed",
        turnId: "turn-a",
      }),
      true,
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("guarded threads include only live WeChat routing and work", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-guarded-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.setMainThreadId("thread-main");
    state.setBinding({
      expiresAtMs: 500,
      projectPath: "D:\\Project",
      threadId: "thread-binding",
      updatedAtMs: 100,
    });
    state.putNotificationRoute({
      deliveredAtMs: 100,
      eventId: "live-route",
      expiresAtMs: 500,
      threadId: "thread-notification",
    });
    state.enqueueQueuedTurn({
      body: "queued",
      createdAtMs: 100,
      dedupeKey: "queued-work",
      threadId: "thread-queued",
    });
    state.createDispatchIntent({
      body: "active",
      contextToken: "ctx-active",
      createdAtMs: 100,
      dedupeKey: "active-work",
      operationId: "active-operation",
      threadId: "thread-active",
    });

    assert.deepEqual(state.listGuardedThreadIds(200), [
      "thread-active",
      "thread-binding",
      "thread-main",
      "thread-notification",
      "thread-queued",
    ]);
    assert.deepEqual(state.listGuardedThreadIds(500), [
      "thread-active",
      "thread-main",
      "thread-queued",
    ]);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("dispatch admission cannot bypass a thread queue or promote a non-head turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-fifo-admission-"));
  const databasePath = join(directory, "state.db");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);

  try {
    state.bindController({
      accountId: "bot-fifo",
      boundAtMs: 1,
      userId: "controller-fifo",
    });
    state.acceptInboundBatch({
      accountId: "bot-fifo",
      controllerUserId: "controller-fifo",
      messages: [
        {
          body: "newer direct request",
          contextToken: "ctx-newer",
          messageId: "message-newer",
          receivedAtMs: 3,
        },
      ],
      nextCursor: "cursor-newer",
      updatedAtMs: 3,
    });
    const first = state.enqueueQueuedTurn({
      body: "first",
      contextToken: "ctx-first",
      createdAtMs: 1,
      dedupeKey: "fifo-first",
      threadId: "thread-fifo",
    });
    const second = state.enqueueQueuedTurn({
      body: "second",
      contextToken: "ctx-second",
      createdAtMs: 2,
      dedupeKey: "fifo-second",
      threadId: "thread-fifo",
    });
    const acquired = leases.tryAcquire({
      createdAtMs: 3,
      instanceId: "bridge-fifo",
      operationId: "fifo-newer-operation",
      owner: "bridge",
      threadId: "thread-fifo",
      turnId: null,
    });
    assert.equal(acquired.acquired, true);
    if (!acquired.acquired) assert.fail("expected FIFO admission lease");

    const admission = state.admitInboundDispatchWithLease({
      accountId: "bot-fifo",
      body: "newer direct request",
      contextToken: "ctx-newer",
      controllerUserId: "controller-fifo",
      createdAtMs: 3,
      dedupeKey: "fifo-newer",
      lease: acquired.lease,
      maxActiveDispatches: 3,
      messageId: "message-newer",
      operationId: "fifo-newer-operation",
      threadId: "thread-fifo",
    });
    assert.equal(admission.kind, "queued");
    assert.equal(
      admission.kind === "queued" ? admission.queued.dedupeKey : null,
      "fifo-newer",
    );
    assert.equal(leases.getLease("thread-fifo"), null);
    const secondLease = leases.tryAcquire({
      createdAtMs: 4,
      instanceId: "bridge-fifo",
      operationId: "fifo-second-operation",
      owner: "bridge",
      threadId: "thread-fifo",
      turnId: null,
    });
    assert.equal(secondLease.acquired, true);
    if (!secondLease.acquired) assert.fail("expected second FIFO lease");
    assert.deepEqual(
      state.promoteQueuedTurnWithLease({
        createdAtMs: 4,
        dedupeKey: second.dedupeKey,
        lease: secondLease.lease,
        maxActiveDispatches: 3,
        operationId: "fifo-second-operation",
        queuedTurnId: second.id,
        threadId: second.threadId,
      }),
      { kind: "blocked" },
    );
    const firstLease = leases.tryAcquire({
      createdAtMs: 5,
      instanceId: "bridge-fifo",
      operationId: "fifo-first-operation",
      owner: "bridge",
      threadId: "thread-fifo",
      turnId: null,
    });
    assert.equal(firstLease.acquired, true);
    if (!firstLease.acquired) assert.fail("expected first FIFO lease");
    const promoted = state.promoteQueuedTurnWithLease({
        createdAtMs: 5,
      dedupeKey: first.dedupeKey,
      lease: firstLease.lease,
        maxActiveDispatches: 3,
        operationId: "fifo-first-operation",
        queuedTurnId: first.id,
      threadId: first.threadId,
    });
    assert.equal(promoted.kind, "promoted");
    assert.equal(
      promoted.kind === "promoted" ? promoted.dispatch.dedupeKey : null,
      "fifo-first",
    );
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("active turn dedupe keys cover inbound, queued, and unresolved dispatch work", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-media-keys-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.bindController({ accountId: "bot", boundAtMs: 1, userId: "user" });
    state.acceptInboundBatch({
      accountId: "bot",
      controllerUserId: "user",
      messages: [
        {
          body: "inbound-payload",
          contextToken: "ctx-inbound",
          messageId: "11",
          receivedAtMs: 1,
        },
      ],
      nextCursor: "cursor",
      updatedAtMs: 1,
    });
    state.enqueueQueuedTurn({
      body: "queued-payload",
      createdAtMs: 2,
      dedupeKey: "bot/user/12",
      threadId: "thread-queued",
    });
    state.createDispatchIntent({
      body: "dispatch-payload",
      createdAtMs: 3,
      dedupeKey: "bot/user/13",
      operationId: "operation-active",
      threadId: "thread-active",
    });
    state.markDispatchAccepted("operation-active", "turn-active", 4);
    state.createDispatchIntent({
      body: "completed-payload",
      createdAtMs: 5,
      dedupeKey: "bot/user/14",
      operationId: "operation-completed",
      threadId: "thread-completed",
    });
    state.markDispatchAccepted("operation-completed", "turn-completed", 6);
    state.markDispatchCompleted("operation-completed", "turn-completed", 7);

    assert.deepEqual(state.listActiveTurnDedupeKeys(), [
      "bot/user/11",
      "bot/user/12",
      "bot/user/13",
    ]);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("dispatch intents discard message bodies after accepted or unknown outcomes", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    state.createDispatchIntent({
      body: "accepted body",
      contextToken: "context-accepted",
      createdAtMs: 200,
      dedupeKey: "bot/user/2001",
      operationId: "dispatch-a",
      threadId: "thread-a",
    });
    state.createDispatchIntent({
      body: "unknown body",
      contextToken: "context-unknown",
      createdAtMs: 201,
      dedupeKey: "bot/user/2002",
      operationId: "dispatch-b",
      threadId: "thread-b",
    });
    state.markDispatchAccepted("dispatch-a", "turn-a", 202);
    state.markDispatchUnknown("dispatch-b", 203);
    state.close();

    state = new SqliteState(path);
    assert.deepEqual(state.getDispatchIntent("dispatch-a"), {
      body: null,
      completedAtMs: null,
      contextToken: "context-accepted",
      createdAtMs: 200,
      dedupeKey: "bot/user/2001",
      operationId: "dispatch-a",
      status: "accepted",
      threadId: "thread-a",
      turnId: "turn-a",
      updatedAtMs: 202,
    });
    assert.deepEqual(state.getDispatchIntent("dispatch-b"), {
      body: null,
      completedAtMs: null,
      contextToken: "context-unknown",
      createdAtMs: 201,
      dedupeKey: "bot/user/2002",
      operationId: "dispatch-b",
      status: "unknown",
      threadId: "thread-b",
      turnId: null,
      updatedAtMs: 203,
    });
    assert.throws(
      () => state.markDispatchUnknown("dispatch-a", 204),
      /dispatch is already accepted/u,
    );
    assert.equal(state.countActiveDispatches(), 2);
    assert.equal(
      state.markDispatchCompleted("dispatch-a", "turn-a", 205).completedAtMs,
      205,
    );
    assert.equal(
      state.markDispatchCompleted("dispatch-a", "turn-a", 206).completedAtMs,
      205,
    );
    assert.equal(state.countActiveDispatches(), 1);
    state.resolveUnknownDispatch("dispatch-b", 207);
    assert.equal(state.countActiveDispatches(), 0);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("outbound attachment intents survive restart and deduplicate call retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-attachment-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    state.createDispatchIntent({
      body: "send the report",
      contextToken: "context-attachment",
      createdAtMs: 100,
      dedupeKey: "bot/user/attachment",
      operationId: "dispatch-attachment",
      threadId: "thread-attachment",
    });
    state.markDispatchAccepted(
      "dispatch-attachment",
      "turn-attachment",
      101,
    );
    const input = {
      callId: "call-attachment",
      createdAtMs: 102,
      kind: "file" as const,
      name: "report.xlsx",
      operationId: "dispatch-attachment",
      path: "C:\\Reports\\report.xlsx",
      threadId: "thread-attachment",
      turnId: "turn-attachment",
    };
    const first = state.registerOutboundAttachmentIntent(input);

    assert.deepEqual(state.registerOutboundAttachmentIntent(input), first);
    assert.deepEqual(
      state.registerOutboundAttachmentIntent({
        ...input,
        callId: "call-retry",
      }),
      first,
    );
    state.close();

    state = new SqliteState(path);
    assert.deepEqual(state.listOutboundAttachmentIntents("turn-attachment"), [
      first,
    ]);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("outbound attachment intents reject call collisions and a third file", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-attachment-limit-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.createDispatchIntent({
      body: "send files",
      createdAtMs: 100,
      dedupeKey: "bot/user/attachment-limit",
      operationId: "dispatch-attachment-limit",
      threadId: "thread-attachment-limit",
    });
    state.markDispatchAccepted(
      "dispatch-attachment-limit",
      "turn-attachment-limit",
      101,
    );
    const register = (callId: string, name: string) =>
      state.registerOutboundAttachmentIntent({
        callId,
        createdAtMs: 102,
        kind: "file",
        name,
        operationId: "dispatch-attachment-limit",
        path: `C:\\Reports\\${name}`,
        threadId: "thread-attachment-limit",
        turnId: "turn-attachment-limit",
      });

    register("call-a", "a.xlsx");
    assert.throws(
      () => register("call-a", "collision.xlsx"),
      /E_OUTBOUND_ATTACHMENT_CALL_ID_COLLISION/u,
    );
    register("call-b", "b.xlsx");
    assert.throws(
      () => register("call-c", "c.xlsx"),
      /E_OUTBOUND_ATTACHMENT_TOO_MANY_ATTACHMENTS/u,
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("dispatch completion and every final reply part commit in one transaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-atomic-final-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.createDispatchIntent({
      body: "make a long answer",
      contextToken: "context-final",
      createdAtMs: 100,
      dedupeKey: "bot/user/final",
      operationId: "dispatch-final",
      threadId: "thread-final",
    });
    state.markDispatchAccepted("dispatch-final", "turn-final", 101);
    state.registerOutboundAttachmentIntent({
      callId: "call-final",
      createdAtMs: 102,
      kind: "file",
      name: "report.xlsx",
      operationId: "dispatch-final",
      path: "C:\\Reports\\report.xlsx",
      threadId: "thread-final",
      turnId: "turn-final",
    });
    state.enqueueOutbox({
      body: "collision",
      clientId: "codex-ilink:turn-final:final:part:2",
      contextToken: "context-final",
      createdAtMs: 102,
      targetUserId: "controller-a",
    });

    assert.throws(
      () =>
        state.completeDispatchWithOutbox({
          completedAtMs: 103,
          operationId: "dispatch-final",
          outbox: [
            {
              body: "part one",
              clientId: "codex-ilink:turn-final:final:part:1",
              contextToken: "context-final",
              createdAtMs: 103,
              targetUserId: "controller-a",
            },
            {
              body: "part two",
              clientId: "codex-ilink:turn-final:final:part:2",
              contextToken: "context-final",
              createdAtMs: 103,
              targetUserId: "controller-a",
            },
          ],
          turnId: "turn-final",
        }),
      /client id collision/u,
    );
    assert.equal(state.getDispatchIntent("dispatch-final")?.completedAtMs, null);
    assert.equal(state.getOutbox("codex-ilink:turn-final:final:part:1"), null);
    assert.equal(state.listOutboundAttachmentIntents("turn-final").length, 1);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("atomic final completion is idempotent with confirmed and pending parts", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-final-idempotent-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.createDispatchIntent({
      body: "answer",
      contextToken: "context-final",
      createdAtMs: 100,
      dedupeKey: "bot/user/idempotent-final",
      operationId: "dispatch-final-idempotent",
      threadId: "thread-final-idempotent",
    });
    state.markDispatchAccepted(
      "dispatch-final-idempotent",
      "turn-final-idempotent",
      101,
    );
    state.registerOutboundAttachmentIntent({
      callId: "call-final-idempotent",
      createdAtMs: 102,
      kind: "file",
      name: "report.xlsx",
      operationId: "dispatch-final-idempotent",
      path: "C:\\Reports\\report.xlsx",
      threadId: "thread-final-idempotent",
      turnId: "turn-final-idempotent",
    });
    const outbox = ["part one", "part two"].map((body, index) => ({
      body,
      clientId: `codex-ilink:turn-final-idempotent:final:part:${String(index + 1)}`,
      contextToken: "context-final",
      createdAtMs: 102,
      targetUserId: "controller-a",
    }));
    state.completeDispatchWithOutbox({
      completedAtMs: 102,
      operationId: "dispatch-final-idempotent",
      outbox,
      turnId: "turn-final-idempotent",
    });
    assert.deepEqual(
      state.listOutboundAttachmentIntents("turn-final-idempotent"),
      [],
    );
    state.confirmOutbox(outbox[0]!.clientId, 103);

    const repeated = state.completeDispatchWithOutbox({
      completedAtMs: 104,
      operationId: "dispatch-final-idempotent",
      outbox,
      turnId: "turn-final-idempotent",
    });
    assert.equal(repeated.dispatch.completedAtMs, 102);
    assert.deepEqual(repeated.outbox.map(({ status }) => status), [
      "confirmed",
      "pending",
    ]);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("confirming a Bridge final reply atomically refreshes only its current session binding", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-final-binding-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.setSessionTimeoutMinutes(60);
    state.setBinding({
      expiresAtMs: 1_500,
      projectPath: "D:\\Project",
      threadId: "thread-a",
      updatedAtMs: 100,
    });
    state.createDispatchIntent({
      body: "run a",
      contextToken: "ctx-a",
      createdAtMs: 100,
      dedupeKey: "message-a",
      operationId: "operation-a",
      threadId: "thread-a",
    });
    state.markDispatchAccepted("operation-a", "turn-a", 101);
    state.markDispatchCompleted("operation-a", "turn-a", 102);
    state.enqueueOutbox({
      body: "final a",
      clientId: "codex-ilink:turn-a:final",
      contextToken: "ctx-a",
      createdAtMs: 102,
      targetUserId: "controller-a",
    });

    state.confirmOutbox("codex-ilink:turn-a:final", 1_000);
    assert.deepEqual(state.getBinding(3_600_999), {
      expiresAtMs: 3_601_000,
      projectPath: "D:\\Project",
      threadId: "thread-a",
      updatedAtMs: 1_000,
    });

    state.setBinding({
      expiresAtMs: 4_000,
      projectPath: "D:\\Project",
      threadId: "thread-expired",
      updatedAtMs: 3_500,
    });
    state.createDispatchIntent({
      body: "run expired",
      contextToken: "ctx-expired",
      createdAtMs: 3_500,
      dedupeKey: "message-expired",
      operationId: "operation-expired",
      threadId: "thread-expired",
    });
    state.markDispatchAccepted("operation-expired", "turn-expired", 3_600);
    state.markDispatchCompleted("operation-expired", "turn-expired", 3_700);
    state.enqueueOutbox({
      body: "late final",
      clientId: "codex-ilink:turn-expired:final",
      contextToken: "ctx-expired",
      createdAtMs: 3_700,
      targetUserId: "controller-a",
    });
    state.confirmOutbox("codex-ilink:turn-expired:final", 4_001);
    assert.equal(state.getBinding(4_001), null);

    state.setBinding({
      expiresAtMs: 9_000,
      projectPath: "D:\\Other",
      threadId: "thread-other",
      updatedAtMs: 2_000,
    });
    state.createDispatchIntent({
      body: "run a again",
      contextToken: "ctx-a2",
      createdAtMs: 2_001,
      dedupeKey: "message-a2",
      operationId: "operation-a2",
      threadId: "thread-a",
    });
    state.markDispatchAccepted("operation-a2", "turn-a2", 2_002);
    state.markDispatchCompleted("operation-a2", "turn-a2", 2_003);
    state.enqueueOutbox({
      body: "final a2",
      clientId: "codex-ilink:turn-a2:final",
      contextToken: "ctx-a2",
      createdAtMs: 2_003,
      targetUserId: "controller-a",
    });
    state.confirmOutbox("codex-ilink:turn-a2:final", 3_000);
    assert.deepEqual(state.getBinding(3_001), {
      expiresAtMs: 9_000,
      projectPath: "D:\\Other",
      threadId: "thread-other",
      updatedAtMs: 2_000,
    });

    state.enqueueOutbox({
      body: "Desktop completed",
      clientId: "codex-ilink:desktop:thread-other:desktop-turn:final",
      contextToken: "ctx-desktop",
      createdAtMs: 3_001,
      targetUserId: "controller-a",
    });
    state.confirmOutbox(
      "codex-ilink:desktop:thread-other:desktop-turn:final",
      4_000,
    );
    assert.equal(state.getBinding(4_001)?.expiresAtMs, 9_000);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an unresolved unknown dispatch remains active until public reconciliation resolves it", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-unknown-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.createDispatchIntent({
      body: "possibly submitted",
      contextToken: "context-unknown-active",
      createdAtMs: 300,
      dedupeKey: "bot/user/unknown-active",
      operationId: "dispatch-unknown-active",
      threadId: "thread-unknown-active",
    });
    state.markDispatchUnknown("dispatch-unknown-active", 301, "turn-unknown-active");

    assert.equal(state.countActiveDispatches(), 1);
    assert.equal(state.hasActiveDispatchForThread("thread-unknown-active"), true);
    assert.equal(
      state.getDispatchIntent("dispatch-unknown-active")?.turnId,
      "turn-unknown-active",
    );

    state.resolveUnknownDispatch("dispatch-unknown-active", 302);
    assert.equal(state.countActiveDispatches(), 0);
    assert.equal(state.hasActiveDispatchForThread("thread-unknown-active"), false);
    assert.equal(
      state.getDispatchIntent("dispatch-unknown-active")?.completedAtMs,
      302,
    );
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("schema v6 deletes legacy plain-text scheduler payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-v2-"));
  const path = join(directory, "state.db");
  const database = new DatabaseSync(path);
  let state: SqliteState | undefined;

  try {
    const migrations = join(process.cwd(), "src", "bridge", "migrations");
    database.exec(readFileSync(join(migrations, "001-initial.sql"), "utf8"));
    database.exec(readFileSync(join(migrations, "002-list-snapshots.sql"), "utf8"));
    database.exec("PRAGMA user_version = 2");
    database
      .prepare(
        `INSERT INTO queued_turns
          (dedupe_key, thread_id, body, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run("legacy-queue", "thread-legacy", "legacy queued", 1);
    database
      .prepare(
        `INSERT INTO dispatch_intents
          (operation_id, dedupe_key, thread_id, body, status, turn_id,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, NULL, 'accepted', ?, ?, ?)`,
      )
      .run(
        "legacy-operation",
        "legacy-dispatch",
        "thread-active",
        "legacy-turn",
        2,
        3,
      );
    database.close();

    state = new SqliteState(path);
    assert.equal(state.storageDiagnostics().schemaVersion, 14);
    assert.deepEqual(state.listQueuedTurns(), []);
    assert.equal(state.getDispatchIntent("legacy-operation"), null);
    assert.equal(state.countActiveDispatches(), 0);
  } finally {
    try {
      state?.close();
    } finally {
      try {
        database.close();
      } catch {
        // The successful migration path already closed the setup connection.
      }
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("outbox keeps a stable client id across restart and deletes confirmed text", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    const input = {
      body: "final reply",
      clientId: "codex-ilink:event-a",
      contextToken: "context-a",
      createdAtMs: 300,
      targetUserId: "wechat-user",
    };
    const first = state.enqueueOutbox(input);
    assert.deepEqual(state.enqueueOutbox(input), first);
    assert.throws(
      () => state.enqueueOutbox({ ...input, body: "different reply" }),
      /client id collision/u,
    );
    state.close();

    state = new SqliteState(path);
    assert.deepEqual(
      state.listPendingOutbox().map(({ body, clientId }) => ({ body, clientId })),
      [{ body: "final reply", clientId: "codex-ilink:event-a" }],
    );
    state.confirmOutbox("codex-ilink:event-a", 301);
    assert.deepEqual(state.getOutbox("codex-ilink:event-a"), {
      body: null,
      clientId: "codex-ilink:event-a",
      confirmedAtMs: 301,
      contextToken: "context-a",
      createdAtMs: 300,
      status: "confirmed",
      targetUserId: "wechat-user",
    });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("arbitration can only be disabled by its owning Bridge instance", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    assert.deepEqual(state.enableArbitration("bridge-instance-a"), {
      arbitrationEnabled: true,
      instanceId: "bridge-instance-a",
    });
    assert.equal(state.disableArbitration("bridge-instance-b"), false);
    assert.deepEqual(state.getBridgeRuntime(), {
      arbitrationEnabled: true,
      instanceId: "bridge-instance-a",
    });
    assert.deepEqual(state.enableArbitration("bridge-instance-b"), {
      arbitrationEnabled: true,
      instanceId: "bridge-instance-b",
    });
    assert.equal(state.disableArbitration("bridge-instance-a"), false);
    state.close();

    state = new SqliteState(path);
    assert.equal(state.disableArbitration("bridge-instance-b"), true);
    assert.deepEqual(state.getBridgeRuntime(), {
      arbitrationEnabled: false,
      instanceId: "bridge-instance-b",
    });
    assert.deepEqual(state.enableArbitration("bridge-instance-c"), {
      arbitrationEnabled: true,
      instanceId: "bridge-instance-c",
    });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("iLink session persists only the caller-protected token for the controller", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    state.bindController({
      accountId: "bot-id",
      boundAtMs: 400,
      userId: "wechat-user",
    });
    const protectedToken = "AQm+IA==";
    state.saveILinkSession({
      baseUrl: "https://ilink.example.test",
      botId: "bot-id",
      controllerUserId: "wechat-user",
      protectedToken,
    });
    assert.throws(
      () =>
        state.saveILinkSession({
          baseUrl: "https://ilink.example.test",
          botId: "bot-id",
          controllerUserId: "intruder",
          protectedToken,
        }),
      /controller mismatch/u,
    );
    state.close();

    state = new SqliteState(path);
    assert.deepEqual(state.getILinkSession(), {
      baseUrl: "https://ilink.example.test",
      botId: "bot-id",
      controllerUserId: "wechat-user",
      protectedToken,
    });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an invalid iLink session can be cleared without changing the controller", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const state = new SqliteState(join(directory, "state.db"));

  try {
    state.bindController({
      accountId: "bot-id",
      boundAtMs: 400,
      userId: "wechat-user",
    });
    state.saveILinkSession({
      baseUrl: "https://ilink.example.test",
      botId: "bot-id",
      controllerUserId: "wechat-user",
      protectedToken: "invalid-protected-token",
    });

    state.clearILinkSession();

    assert.equal(state.getILinkSession(), null);
    assert.deepEqual(state.getController(), {
      accountId: "bot-id",
      boundAtMs: 400,
      userId: "wechat-user",
    });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("main thread, project selection, and explicit navigation state persist", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    assert.deepEqual(state.getBridgeSettings(), {
      awayTimeoutMinutes: 5,
      mainThreadId: null,
      selectedProjectPath: null,
      sessionTimeoutMinutes: 30,
    });
    state.setMainThreadId("thread-main");
    state.setSelectedProjectPath("D:\\Project");
    state.setBinding({
      expiresAtMs: 500,
      projectPath: "D:\\Project",
      threadId: "thread-project",
      updatedAtMs: 100,
    });
    state.putNotificationRoute({
      deliveredAtMs: 100,
      eventId: "event-a",
      expiresAtMs: 400,
      threadId: "thread-project",
    });
    state.clearNavigationRoutes();
    state.close();

    state = new SqliteState(path);
    assert.deepEqual(state.getBridgeSettings(), {
      awayTimeoutMinutes: 5,
      mainThreadId: "thread-main",
      selectedProjectPath: "D:\\Project",
      sessionTimeoutMinutes: 30,
    });
    assert.equal(state.getBinding(101), null);
    assert.deepEqual(state.listLiveNotificationRoutes(101), []);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("project and session list snapshots keep their displayed numbering for ten minutes", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    state.replaceProjectSnapshot({
      createdAtMs: 1_000,
      expiresAtMs: 601_000,
      projects: ["D:\\First", "D:\\Second"],
    });
    state.replaceSessionSnapshot({
      archived: true,
      createdAtMs: 2_000,
      expiresAtMs: 602_000,
      hasNext: true,
      page: 2,
      projectPath: "D:\\First",
      threads: [
        {
          archived: true,
          projectPath: "D:\\First",
          threadId: "thread-old",
        },
      ],
    });
    state.close();

    state = new SqliteState(path);
    assert.deepEqual(state.getProjectSnapshot(600_999), {
      createdAtMs: 1_000,
      expiresAtMs: 601_000,
      projects: ["D:\\First", "D:\\Second"],
    });
    assert.deepEqual(state.getSessionSnapshot(601_999), {
      archived: true,
      createdAtMs: 2_000,
      expiresAtMs: 602_000,
      hasNext: true,
      page: 2,
      projectPath: "D:\\First",
      threads: [
        {
          archived: true,
          projectPath: "D:\\First",
          threadId: "thread-old",
        },
      ],
    });
    assert.equal(state.getProjectSnapshot(601_000), null);
    assert.equal(state.getSessionSnapshot(602_000), null);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

function applyMigrations(
  database: DatabaseSync,
  firstVersion: number,
  lastVersion: number,
): void {
  const migrationNames = [
    "initial",
    "list-snapshots",
    "turn-scheduler",
    "desktop-observations",
    "desktop-observation-tombstones",
    "durable-turn-input",
    "thread-permission-profiles",
    "pending-desktop-notifications",
    "outbound-attachment-intents",
    "user-timing-settings",
    "thread-permission-settings",
    "outbound-attachment-provenance",
    "transport-retention-indexes",
    "drop-thread-permission-profiles",
  ];
  const migrations = join(process.cwd(), "src", "bridge", "migrations");
  for (let version = firstVersion; version <= lastVersion; version += 1) {
    const name = migrationNames[version - 1];
    assert.ok(name, `missing test migration ${String(version)}`);
    const filename = `${String(version).padStart(3, "0")}-${name}.sql`;
    database.exec(readFileSync(join(migrations, filename), "utf8"));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail("timed out waiting for concurrent migration process");
}
