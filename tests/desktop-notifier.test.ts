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
        thread: {
          cwd: "D:\\Project",
          name: "后台任务",
          turns: [
            {
              id: "turn-desktop",
              items: [
                {
                  content: [
                    { text: "请检查登录问题并给出修复方案。", type: "text" },
                  ],
                  type: "userMessage",
                },
                {
                  phase: "final_answer",
                  text: "已经修复登录状态过期后无法重新认证的问题。",
                  type: "agentMessage",
                },
              ],
              status: "completed",
            },
          ],
        },
      }),
      session,
      state,
    });

    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "queued");
    assert.match(
      state.listPendingOutbox()[0]?.body ?? "",
      /Codex Desktop 任务已完成[\s\S]*后台任务[\s\S]*你问：请检查登录问题并给出修复方案。[\s\S]*Codex：已经修复登录状态过期后无法重新认证的问题。[\s\S]*只有一条新通知时，直接回复即可继续这个会话；多条通知请先选择。[\s\S]*重启 Codex App/u,
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

test("a long Desktop completion keeps a short question summary and splits the final answer", async () => {
  await withState(async (state) => {
    seedContext(state);
    const finalAnswer = `处理结果：${"修复完成。".repeat(240)}结束。`;
    const notifier = new DesktopNotifier({
      now: () => 25_000,
      presence: async () => "away",
      readThread: async () => ({
        thread: {
          cwd: "D:\\Project",
          name: "长任务",
          turns: [
            {
              id: "turn-desktop",
              items: [
                {
                  content: [
                    {
                      text: `${"请检查这个问题。".repeat(30)}不应出现在摘要中的结尾`,
                      type: "text",
                    },
                  ],
                  type: "userMessage",
                },
                {
                  phase: "final_answer",
                  text: finalAnswer,
                  type: "agentMessage",
                },
              ],
              status: "completed",
            },
          ],
        },
      }),
      session,
      state,
    });

    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "queued");
    const pending = state.listPendingOutbox();
    assert.equal(pending.length, 3);
    const deliveredText = pending.map(({ body }) => body ?? "").join("");
    assert.match(deliveredText, /你问：[^\n]+…/u);
    assert.doesNotMatch(deliveredText, /不应出现在摘要中的结尾/u);
    assert.match(deliveredText, /结束。/u);
    assert.equal(
      await notifier.notifyTerminal(stopEvent, "completed"),
      "already-sent",
    );
    assert.equal(state.listPendingOutbox().length, 3);
  });
});

test("a Desktop completion hides local file paths and points attachments back to Desktop", async () => {
  await withState(async (state) => {
    seedContext(state);
    const notifier = new DesktopNotifier({
      now: () => 26_000,
      presence: async () => "away",
      readThread: async () => ({
        thread: {
          turns: [
            {
              id: "turn-desktop",
              items: [
                {
                  phase: "final_answer",
                  text: "报告已生成：\n[报告](<D:\\Project\\report.md>)",
                  type: "agentMessage",
                },
              ],
            },
          ],
        },
      }),
      session,
      state,
    });

    assert.equal(await notifier.notifyTerminal(stopEvent, "completed"), "queued");
    const body = state.listPendingOutbox()[0]?.body ?? "";
    assert.doesNotMatch(body, /D:\\Project|report\.md/u);
    assert.match(body, /最终回答包含本机附件，请在 Codex Desktop 查看/u);
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
