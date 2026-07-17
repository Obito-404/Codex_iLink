import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SqliteState } from "../src/bridge/sqlite-state.ts";

test("controller identity and database configuration survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");

  try {
    const first = new SqliteState(path);
    assert.deepEqual(first.storageDiagnostics(), {
      journalMode: "wal",
      schemaVersion: 9,
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

test("selected Codex permission profile survives Bridge reopening per thread", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-permissions-"));
  const path = join(directory, "state.db");

  try {
    const first = new SqliteState(path);
    first.setThreadPermissionProfile({
      profileId: ":danger-full-access",
      threadId: "thread-permission-a",
      updatedAtMs: 100,
    });
    first.setThreadPermissionProfile({
      profileId: ":read-only",
      threadId: "thread-permission-b",
      updatedAtMs: 200,
    });
    first.close();

    const reopened = new SqliteState(path);
    assert.deepEqual(reopened.getThreadPermissionProfile("thread-permission-a"), {
      profileId: ":danger-full-access",
      threadId: "thread-permission-a",
      updatedAtMs: 100,
    });
    assert.deepEqual(reopened.getThreadPermissionProfile("thread-permission-b"), {
      profileId: ":read-only",
      threadId: "thread-permission-b",
      updatedAtMs: 200,
    });
    reopened.close();
  } finally {
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
  const state = new SqliteState(join(directory, "state.db"));

  try {
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

    assert.equal(
      state.tryCreateDispatchIntent({
        body: "newer direct request",
        contextToken: "ctx-newer",
        createdAtMs: 3,
        dedupeKey: "fifo-newer",
        maxActiveDispatches: 3,
        operationId: "fifo-newer-operation",
        threadId: "thread-fifo",
      }),
      null,
    );
    assert.equal(
      state.promoteQueuedTurn({
        createdAtMs: 4,
        maxActiveDispatches: 3,
        operationId: "fifo-second-operation",
        queuedTurnId: second.id,
      }),
      null,
    );
    assert.equal(
      state.promoteQueuedTurn({
        createdAtMs: 5,
        maxActiveDispatches: 3,
        operationId: "fifo-first-operation",
        queuedTurnId: first.id,
      })?.dedupeKey,
      "fifo-first",
    );
  } finally {
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
    state.setBinding({
      expiresAtMs: 500,
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
    assert.deepEqual(state.getBinding(1_800_999), {
      expiresAtMs: 1_801_000,
      projectPath: "D:\\Project",
      threadId: "thread-a",
      updatedAtMs: 1_000,
    });

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

    const state = new SqliteState(path);
    assert.equal(state.storageDiagnostics().schemaVersion, 9);
    assert.deepEqual(state.listQueuedTurns(), []);
    assert.equal(state.getDispatchIntent("legacy-operation"), null);
    assert.equal(state.countActiveDispatches(), 0);
    state.close();
  } finally {
    try {
      database.close();
    } catch {
      // The successful migration path already closed the setup connection.
    }
    rmSync(directory, { force: true, recursive: true });
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

test("main thread, project selection, and explicit navigation state persist", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-state-"));
  const path = join(directory, "state.db");
  let state = new SqliteState(path);

  try {
    assert.deepEqual(state.getBridgeSettings(), {
      mainThreadId: null,
      selectedProjectPath: null,
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
      mainThreadId: "thread-main",
      selectedProjectPath: "D:\\Project",
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
