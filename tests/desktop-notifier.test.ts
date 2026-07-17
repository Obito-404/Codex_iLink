import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { DesktopNotifier } from "../src/daemon/desktop-notifier.ts";
import type { HookEvent } from "../src/hooks/hook-receiver.ts";
import type { ILinkSession } from "../src/ilink/protocol.ts";

const session: ILinkSession = {
  baseUrl: "https://ilink.example",
  botId: "bot-a",
  botToken: "token",
  controllerUserId: "controller-a",
};

const stopEvent: HookEvent = {
  capturedAtMs: 1,
  cwd: "D:\\Project",
  eventName: "Stop",
  model: null,
  permissionMode: null,
  schemaVersion: 1,
  sessionId: "thread-desktop",
  source: null,
  toolName: null,
  turnId: "turn-desktop",
};

const permissionEvent: HookEvent = {
  capturedAtMs: 2,
  cwd: "D:\\Secret Project",
  eventName: "PermissionRequest",
  model: "gpt-secret",
  permissionMode: "full-access",
  schemaVersion: 1,
  sessionId: "thread-desktop",
  source: null,
  toolName: "shell_command",
  turnId: "turn-desktop",
};

test("an away Desktop turn queues only its first permission request and a later turn can notify again", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 9_000,
      presence: async () => "away",
      readThread: async () => ({
        thread: { cwd: "D:\\Secret Project", name: "发布修复" },
      }),
      session,
      state,
    });

    assert.equal(await notifier.notifyPermission(permissionEvent), "queued");
    const pending = state.listPendingOutbox();
    assert.equal(pending.length, 1);
    assert.match(
      pending[0]?.body ?? "",
      /Codex Desktop 正等待本机批准[\s\S]*Secret Project[\s\S]*发布修复[\s\S]*shell_command[\s\S]*微信不能批准[\s\S]*回到电脑/u,
    );
    assert.doesNotMatch(pending[0]?.body ?? "", /gpt-secret|full-access/u);
    assert.deepEqual(state.listLiveNotificationRoutes(9_001), []);
    assert.equal(await notifier.notifyPermission(permissionEvent), "already-sent");
    assert.equal(
      await notifier.notifyPermission({
        ...permissionEvent,
        capturedAtMs: 3,
        toolName: "apply_patch",
      }),
      "already-sent",
    );
    assert.equal(state.listPendingOutbox().length, 1);

    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "queued");
    assert.equal(
      await notifier.notifyPermission({
        ...permissionEvent,
        capturedAtMs: 4,
        toolName: "apply_patch",
        turnId: "turn-desktop-next",
      }),
      "queued",
    );
    assert.equal(state.listPendingOutbox().length, 3);
  });
});

test("concurrent permission requests for one Desktop turn share one notification", async () => {
  await withState(async (state) => {
    seedContext(state);
    let releasePresence!: () => void;
    const presenceGate = new Promise<void>((resolve) => {
      releasePresence = resolve;
    });
    const notifier = new DesktopNotifier({
      now: () => 9_100,
      presence: async () => {
        await presenceGate;
        return "away";
      },
      readThread: async () => ({
        thread: { cwd: "D:\\Secret Project", name: "并发审批" },
      }),
      session,
      state,
    });

    const first = notifier.notifyPermission(permissionEvent);
    const duplicate = notifier.notifyPermission({
      ...permissionEvent,
      capturedAtMs: 3,
      toolName: "apply_patch",
    });
    releasePresence();

    assert.deepEqual(await Promise.all([first, duplicate]), ["queued", "queued"]);
    assert.equal(state.listPendingOutbox().length, 1);
  });
});

test("concurrent permission requests from different Desktop turns are both retained", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 9_200,
      presence: async () => "away",
      readThread: async () => ({
        thread: { cwd: "D:\\Secret Project", name: "并行回合" },
      }),
      session,
      state,
    });

    assert.deepEqual(
      await Promise.all([
        notifier.notifyPermission(permissionEvent),
        notifier.notifyPermission({
          ...permissionEvent,
          capturedAtMs: 3,
          turnId: "turn-desktop-next",
        }),
      ]),
      ["queued", "queued"],
    );
    assert.equal(state.listPendingOutbox().length, 2);
  });
});

test("an away Desktop completion is retained before any iLink context exists", async () => {
  await withState(async (state) => {
    state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
    const notifier = new DesktopNotifier({
      now: () => 9_500,
      presence: async () => "away",
      readThread: async () => ({ thread: { name: "离线完成" } }),
      session,
      state,
    });

    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "queued");
    assert.equal(state.listPendingOutbox()[0]?.contextToken, "");
    assert.deepEqual(state.listLiveNotificationRoutes(9_501), []);
  });
});

test("an away Desktop completion is durably queued once without opening a route", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 10_000,
      presence: async () => "away",
      readThread: async () => ({
        thread: { cwd: "D:\\Project", name: "后台任务" },
      }),
      session,
      state,
    });

    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "queued");
    assert.match(
      state.listPendingOutbox()[0]?.body ?? "",
      /Codex Desktop 任务已完成[\s\S]*后台任务/u,
    );
    assert.deepEqual(state.listLiveNotificationRoutes(10_001), []);
    assert.equal(
      await notifier.notifyTerminal(stopEvent, "completed"),
      "already-sent",
    );
    assert.equal(state.listPendingOutbox().length, 1);
  });
});

test("a present user is not sent a duplicate Desktop notification", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 20_000,
      presence: async () => "present",
      readThread: async () => {
        assert.fail("present tasks need no preview");
      },
      session,
      state,
    });
    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "present");
    assert.deepEqual(state.listPendingOutbox(), []);
  });
});

test("a thread preview failure still retains a metadata-only completion", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 30_000,
      presence: async () => "away",
      readThread: async () => {
        throw new Error("Desktop unavailable");
      },
      session,
      state,
    });
    assert.equal(await notifier.notifyTerminal(stopEvent, "failed"), "queued");
    assert.match(
      state.listPendingOutbox()[0]?.body ?? "",
      /任务失败[\s\S]*项目：Project[\s\S]*thread-desktop/u,
    );
    assert.doesNotMatch(state.listPendingOutbox()[0]?.body ?? "", /D:\\\\/u);
    assert.equal(state.listPendingOutbox().length, 1);
    assert.deepEqual(state.listLiveNotificationRoutes(30_001), []);
  });
});

test("a present Desktop permission request stays silent", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 40_000,
      presence: async () => "present",
      readThread: async () => {
        assert.fail("present permission requests need no preview");
      },
      session,
      state,
    });

    assert.equal(await notifier.notifyPermission(permissionEvent), "present");
    assert.deepEqual(state.listPendingOutbox(), []);
  });
});

test("a Desktop permission request without a turn id stays silent", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 41_000,
      presence: async () => {
        assert.fail("unscoped permission requests must not probe presence");
      },
      readThread: async () => {
        assert.fail("unscoped permission requests must not read a thread");
      },
      session,
      state,
    });

    assert.equal(
      await notifier.notifyPermission({ ...permissionEvent, turnId: null }),
      "already-sent",
    );
    assert.deepEqual(state.listPendingOutbox(), []);
  });
});

function seedContext(state: SqliteState): void {
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "/help",
        contextToken: "ctx-latest",
        messageId: "seed",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor",
    updatedAtMs: 1,
  });
}

async function withState(run: (state: SqliteState) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-notifier-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  try {
    await run(state);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}
