import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgeEngine,
  type CodexTurnStarter,
} from "../src/bridge/bridge.ts";
import { COMMAND_HELP } from "../src/bridge/commands.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";
import { CodexOutcomeUnknownError } from "../src/codex/protocol.ts";
import type {
  ILinkSession,
  SendTextResult,
  WireWeixinMessage,
} from "../src/ilink/protocol.ts";

const session: ILinkSession = {
  baseUrl: "https://ilink.example",
  botId: "bot-navigation",
  botToken: "token",
  controllerUserId: "controller-navigation",
};

test("p creates a fixed ten-minute snapshot and p<n> selects from it", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    codex.activeThreads = [
      { cwd: "D:\\Newest", id: "newest", updatedAt: 30 },
      { cwd: "D:\\Older", id: "older", updatedAt: 10 },
    ];
    codex.archivedThreads = [
      { cwd: "D:\\Older", id: "older-archived", updatedAt: 20 },
    ];

    state.setBinding({
      expiresAtMs: 99_000,
      projectPath: "D:\\Previous",
      threadId: "previous-thread",
      updatedAtMs: 1,
    });
    state.putNotificationRoute({
      deliveredAtMs: 1,
      eventId: "old-notification",
      expiresAtMs: 99_000,
      threadId: "previous-thread",
    });

    assert.deepEqual(await ingest(bridge, 1, "p"), { accepted: 1, sent: 1 });
    assert.match(sent[0]?.text ?? "", /1\. Newest/u);
    assert.match(sent[0]?.text ?? "", /2\. Older/u);

    codex.activeThreads = [
      { cwd: "D:\\Inserted-Later", id: "inserted", updatedAt: 100 },
    ];
    assert.deepEqual(await ingest(bridge, 2, "p2"), {
      accepted: 1,
      sent: 1,
    });
    assert.equal(state.getBridgeSettings().selectedProjectPath, "D:\\Older");
    assert.equal(state.getBinding(2_000), null);
    assert.deepEqual(state.listLiveNotificationRoutes(2_000), []);
    assert.match(sent[1]?.text ?? "", /已选择项目：Older/u);
    assert.deepEqual(
      state.listInboundMessages().map(({ body }) => body),
      [null, null],
    );
  }, {
    projects: [
      { cwd: "D:\\Newest", name: "Newest" },
      { cwd: "D:\\Older", name: "Older" },
    ],
  });
});

test("p<n> selects from the current Desktop projects without a prior list", async () => {
  await withNavigationBridge(async ({ bridge, sent, state }) => {
    assert.deepEqual(await ingest(bridge, 3, "p2"), {
      accepted: 1,
      sent: 1,
    });

    assert.equal(state.getBridgeSettings().selectedProjectPath, "D:\\Second");
    assert.match(sent[0]?.text ?? "", /已选择项目：Second/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /项目列表已过期/u);
  }, {
    projects: [
      { cwd: "D:\\First", name: "First" },
      { cwd: "D:\\Second", name: "Second" },
    ],
  });
});

test("p mirrors Desktop saved projects by name while routing with hidden paths", async () => {
  const projects = [
    { cwd: "D:\\Codex_iLink", name: "Codex_iLink" },
    {
      cwd: "D:\\project\\Tech_Pack_AI_Translation_Assistant",
      name: "Tech_Pack_AI_Translation_Assistant",
    },
    { cwd: "D:\\ContextOS", name: "ContextOS" },
    { cwd: "D:\\obito\\StudyBuddy", name: "StudyBuddy" },
    { cwd: "D:\\project\\Elan_AutoPrint", name: "Elan_AutoPrint" },
    { cwd: "D:\\project\\ExcelMapper", name: "ExcelMapper" },
    { cwd: "d:\\CODEX-ILINK\\inbox\\", name: "Inbox" },
  ];

  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    codex.activeThreads = [
      { cwd: "C:\\Windows\\System32", id: "not-a-desktop-project", updatedAt: 99 },
      { cwd: "D:\\Codex_iLink", id: "allowed-thread", updatedAt: 1 },
    ];

    await ingest(bridge, 3, "p");

    assert.equal(
      sent[0]?.text,
      [
        "项目",
        "1. Codex_iLink",
        "2. Tech_Pack_AI_Translation_Assistant",
        "3. ContextOS",
        "4. StudyBuddy",
        "5. Elan_AutoPrint",
        "6. ExcelMapper",
        "使用 p<n> 选择项目；编号自本列表生成起 10 分钟内有效。",
      ].join("\n"),
    );
    assert.doesNotMatch(sent[0]?.text ?? "", /D:\\\\/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /System32/u);

    await ingest(bridge, 4, "p6");
    assert.equal(
      state.getBridgeSettings().selectedProjectPath,
      "D:\\project\\ExcelMapper",
    );
    assert.match(sent[1]?.text ?? "", /已选择项目：ExcelMapper/u);
    assert.doesNotMatch(sent[1]?.text ?? "", /D:\\\\/u);
  }, { projects });
});

test("p fails closed when the Desktop project catalog is unavailable", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.activeThreads = [
      { cwd: "C:\\Windows\\System32", id: "historical-thread", updatedAt: 99 },
    ];

    await ingest(bridge, 5, "p");

    assert.equal(sent[0]?.text, "项目命令执行失败，请稍后重试。");
    assert.doesNotMatch(sent[0]?.text ?? "", /System32|C:\\\\/u);
  });
});

test("s<n> enters the current first-page session without a prior list", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    codex.activeThreads = [
      {
        cwd: "D:\\Selected",
        id: "thread-newest",
        name: "Newest",
        status: { type: "idle" },
        updatedAt: 3,
      },
      {
        cwd: "D:\\Selected",
        id: "thread-second",
        name: "Second",
        status: { type: "idle" },
        updatedAt: 2,
      },
    ];

    await ingest(bridge, 9, "s2");

    assert.deepEqual(codex.calls, [
      "resume:thread-second",
      "read:thread-second",
    ]);
    assert.equal(state.getBinding(1_001)?.threadId, "thread-second");
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /已进入会话：thread-second/u);
  });
});

test("s pages the selected project's sessions and s<n> binds the displayed session", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    state.setSessionTimeoutMinutes(60);
    codex.activeThreads = Array.from({ length: 12 }, (_, index) => ({
      cwd: "D:\\Selected",
      id: `thread-${String(index + 1).padStart(2, "0")}`,
      name: `Task ${index + 1}`,
      status: { type: "idle" },
      updatedAt: index + 1,
    }));

    await ingest(bridge, 10, "s");
    assert.match(sent[0]?.text ?? "", /1\. Task 12 \[idle\]/u);
    assert.match(sent[0]?.text ?? "", /10\. Task 3 \[idle\]/u);
    assert.match(sent[0]?.text ?? "", /下一页：s\+/u);

    await ingest(bridge, 11, "s+");
    assert.match(sent[1]?.text ?? "", /1\. Task 2 \[idle\]/u);
    assert.match(sent[1]?.text ?? "", /2\. Task 1 \[idle\]/u);

    codex.reads.set("thread-01", {
      thread: {
        id: "thread-01",
        name: "Task 1",
        status: { type: "idle" },
        turns: [
          {
            items: [
              {
                content: [{ text: "上次问题", type: "text" }],
                type: "userMessage",
              },
              {
                phase: "final_answer",
                text: "上次答案",
                type: "agentMessage",
              },
            ],
          },
        ],
      },
    });
    codex.resumes.set("thread-01", {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      model: "gpt-project",
      sandbox: { type: "workspaceWrite" },
      thread: { id: "thread-01" },
    });
    state.putNotificationRoute({
      deliveredAtMs: 1,
      eventId: "notification-before-session-entry",
      expiresAtMs: 99_999,
      threadId: "another-thread",
    });
    clock.value = 50_000;

    await ingest(bridge, 12, "s2");
    assert.deepEqual(codex.calls.slice(-2), [
      "resume:thread-01",
      "read:thread-01",
    ]);
    assert.deepEqual(state.getBinding(50_001), {
      expiresAtMs: 50_000 + 60 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-01",
      updatedAtMs: 50_000,
    });
    assert.deepEqual(state.listLiveNotificationRoutes(50_001), []);
    assert.match(sent[2]?.text ?? "", /已进入会话：Task 1/u);
    assert.match(sent[2]?.text ?? "", /模型：gpt-project/u);
    assert.match(sent[2]?.text ?? "", /权限：工作区（推荐） \(:workspace\)/u);
    assert.match(sent[2]?.text ?? "", /审批：on-request/u);
    assert.match(sent[2]?.text ?? "", /Sandbox：workspaceWrite/u);
    assert.match(sent[2]?.text ?? "", /最近提问：上次问题/u);
    assert.match(sent[2]?.text ?? "", /最近回复：上次答案/u);
    assert.match(sent[2]?.text ?? "", /60 分钟无活动后自动退出/u);
  });
});

test("sarc keeps archived identity and s<n> unarchives before resuming", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    codex.archivedThreads = [
      {
        cwd: "D:\\Selected",
        id: "thread-archived",
        name: "Archived task",
        status: { type: "idle" },
        updatedAt: 9,
      },
    ];
    codex.reads.set("thread-archived", {
      thread: { id: "thread-archived", name: "Archived task", turns: [] },
    });
    codex.resumes.set("thread-archived", {
      thread: { id: "thread-archived" },
    });

    await ingest(bridge, 20, "sarc");
    await ingest(bridge, 21, "s1");

    assert.deepEqual(codex.calls.slice(-3), [
      "unarchive:thread-archived",
      "resume:thread-archived",
      "read:thread-archived",
    ]);
    assert.match(sent[1]?.text ?? "", /^Unarchived\n/u);
    assert.equal(state.getBinding(1_000)?.threadId, "thread-archived");
  });
});

test("s<n> keeps the successful binding when preview reading is temporarily unavailable", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    codex.activeThreads = [
      {
        cwd: "D:\\Codex-iLink\\Inbox",
        id: "thread-preview-unavailable",
        updatedAt: 1,
      },
    ];
    codex.readFailures.add("thread-preview-unavailable");

    await ingest(bridge, 25, "s");
    await ingest(bridge, 26, "s1");

    assert.equal(state.getBinding(1_001)?.threadId, "thread-preview-unavailable");
    assert.match(
      sent[1]?.text ?? "",
      /已进入会话：thread-preview-unavailable/u,
    );
    assert.doesNotMatch(sent[1]?.text ?? "", /执行失败/u);
  });
});

test("new creates in the selected project, binds immediately, and exit returns to main", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    state.putNotificationRoute({
      deliveredAtMs: 1,
      eventId: "notification-before-new",
      expiresAtMs: 100_000,
      threadId: "old-thread",
    });
    codex.nextStartedThreadId = "thread-new-project";
    clock.value = 10_000;

    await ingest(bridge, 30, "new");
    assert.deepEqual(codex.startedCwds, ["D:\\Selected"]);
    assert.deepEqual(state.getBinding(10_001), {
      expiresAtMs: 10_000 + 30 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-new-project",
      updatedAtMs: 10_000,
    });
    assert.deepEqual(state.listLiveNotificationRoutes(10_001), []);
    assert.match(sent[0]?.text ?? "", /已新建并进入会话：thread-new-project/u);
    assert.match(sent[0]?.text ?? "", /权限：工作区（推荐） \(:workspace\)/u);
    assert.match(sent[0]?.text ?? "", /审批：on-request/u);
    assert.match(sent[0]?.text ?? "", /Sandbox：workspaceWrite/u);
    assert.match(sent[0]?.text ?? "", /30 分钟无活动后自动退出/u);

    await ingest(bridge, 32, "new task question");
    assert.deepEqual(codex.startedTurns, [
      { text: "new task question", threadId: "thread-new-project" },
    ]);
    assert.doesNotMatch(sent.map(({ text }) => text).join("\n"), /Queued/u);
    assert.doesNotMatch(codex.calls.join("\n"), /resume:thread-new-project/u);

    state.putNotificationRoute({
      deliveredAtMs: 10_001,
      eventId: "notification-before-exit",
      expiresAtMs: 100_000,
      threadId: "thread-new-project",
    });
    await ingest(bridge, 31, "exit");
    assert.equal(state.getBinding(10_001), null);
    assert.deepEqual(state.listLiveNotificationRoutes(10_001), []);
    assert.equal(state.getBridgeSettings().selectedProjectPath, null);
    assert.match(sent[1]?.text ?? "", /已返回微信主会话/u);
    assert.match(sent[1]?.text ?? "", /已退出当前项目/u);
    assert.match(sent[1]?.text ?? "", /原会话和运行中的任务仍保留/u);

    await ingest(bridge, 33, "main task question");
    assert.deepEqual(codex.startedTurns, [
      { text: "new task question", threadId: "thread-new-project" },
      { text: "main task question", threadId: "wechat-main" },
    ]);
    assert.equal(state.countQueuedTurns(), 0);
    assert.doesNotMatch(sent.map(({ text }) => text).join("\n"), /Queued/u);
  });
});

test("new without a project uses the reserved Inbox and stays product-level unprojected", async () => {
  await withNavigationBridge(async ({ bridge, codex, state }) => {
    codex.nextStartedThreadId = "thread-new-inbox";

    await ingest(bridge, 40, "new");

    assert.deepEqual(codex.startedCwds, ["D:\\Codex-iLink\\Inbox"]);
    assert.equal(state.getBinding(1_001)?.projectPath, null);
    assert.equal(state.getBinding(1_001)?.threadId, "thread-new-inbox");
  });
});

test("new applies the current global permission defaults", async () => {
  await withNavigationBridge(async ({ bridge, codex, state }) => {
    state.setDefaultPermissionProfile(":read-only");
    state.setDefaultApprovalPolicy("never");
    state.setDefaultApprovalsReviewer("user");

    await ingest(bridge, 401, "new");

    assert.deepEqual(codex.startedPermissions, [
      {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: ":read-only",
      },
    ]);
  });
});

test("an expired session binding sends one reminder and preserves the session", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    codex.activeThreads = [
      {
        cwd: "D:\\Selected",
        id: "thread-reminder",
        name: "发布准备",
        status: { type: "idle" },
        updatedAt: 1,
      },
    ];
    codex.reads.set("thread-reminder", {
      thread: { id: "thread-reminder", name: "发布准备" },
    });

    await ingest(bridge, 41, "s1");
    const expiresAtMs = state.getBinding(clock.value)?.expiresAtMs;
    assert.ok(expiresAtMs);
    sent.length = 0;
    clock.value = expiresAtMs;

    await bridge.reconcilePendingWork();
    assert.equal(sent.length, 1);
    assert.match(
      sent[0]?.text ?? "",
      /会话“发布准备”的微信绑定已因 30 分钟无交互结束/u,
    );
    assert.match(sent[0]?.text ?? "", /原会话和运行中的任务仍保留/u);
    assert.equal(state.getBinding(clock.value), null);

    await bridge.reconcilePendingWork();
    assert.equal(sent.length, 1);
  });
});

test("stop interrupts the active WeChat turn in the current session", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent, state }) => {
    state.setBinding({
      expiresAtMs: 60_000,
      projectPath: "D:\\Selected",
      threadId: "thread-running",
      updatedAtMs: 900,
    });
    const lease = leases.tryAcquire({
      createdAtMs: 900,
      instanceId: "bridge-navigation",
      operationId: "operation-running",
      owner: "bridge",
      threadId: "thread-running",
      turnId: "turn-running",
    });
    assert.equal(lease.acquired, true);
    state.createDispatchIntent({
      body: "running input",
      createdAtMs: 900,
      dedupeKey: "running-dedupe",
      operationId: "operation-running",
      threadId: "thread-running",
    });
    state.markDispatchAccepted("operation-running", "turn-running", 901);
    codex.onInterrupt = async ({ threadId, turnId }) => {
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "interrupted" },
        },
      });
    };

    await ingest(bridge, 41, "stop");

    assert.deepEqual(codex.interruptedTurns, [
      { threadId: "thread-running", turnId: "turn-running" },
    ]);
    assert.deepEqual(sent.map(({ text }) => text), ["已请求停止当前任务。"]);
    assert.equal(
      state.getDispatchIntent("operation-running")?.completedAtMs,
      1_000,
    );
  });
});

test("stop does not attempt to interrupt a Desktop-owned turn", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent }) => {
    const lease = leases.tryAcquire({
      createdAtMs: 900,
      instanceId: "desktop",
      operationId: "desktop-running",
      owner: "desktop",
      threadId: "wechat-main",
      turnId: "desktop-turn",
    });
    assert.equal(lease.acquired, true);

    await ingest(bridge, 45, "stop");

    assert.deepEqual(codex.interruptedTurns, []);
    assert.equal(sent[0]?.text, "当前任务由 Desktop 发起，请在电脑端停止。");
  });
});

test("stop uses a known Turn ID even when the original submission outcome is unknown", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.createDispatchIntent({
      body: "unknown input",
      createdAtMs: 900,
      dedupeKey: "unknown-dedupe",
      operationId: "operation-unknown",
      threadId: "wechat-main",
    });
    state.markDispatchUnknown("operation-unknown", 901, "turn-unknown");

    await ingest(bridge, 47, "stop");

    assert.deepEqual(codex.interruptedTurns, [
      { threadId: "wechat-main", turnId: "turn-unknown" },
    ]);
    assert.equal(sent[0]?.text, "已请求停止当前任务。");
  });
});

test("stop returns a stable short code when interruption deterministically fails", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.createDispatchIntent({
      body: "failing stop input",
      createdAtMs: 900,
      dedupeKey: "failing-stop-dedupe",
      operationId: "operation-failing-stop",
      threadId: "wechat-main",
    });
    state.markDispatchAccepted(
      "operation-failing-stop",
      "turn-failing-stop",
      901,
    );
    codex.interruptError = new Error("fixture interruption failure");

    await ingest(bridge, 48, "stop");

    assert.equal(sent[0]?.text, "E_TURN_STOP：停止任务失败，请稍后重试。");
  });
});

test("clear replaces a project session and archives the old history", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    state.setBinding({
      expiresAtMs: 60_000,
      projectPath: "D:\\Selected",
      threadId: "thread-old-context",
      updatedAtMs: 900,
    });
    codex.nextStartedThreadId = "thread-cleared-context";
    codex.reads.set("thread-old-context", {
      thread: {
        id: "thread-old-context",
        status: { type: "idle" },
      },
    });
    let desktopAcquiredDuringClear = true;
    codex.beforeStartThread = async () => {
      await bridge.reconcilePendingWork();
      desktopAcquiredDuringClear = leases.tryAcquire({
        createdAtMs: 950,
        instanceId: "desktop",
        operationId: "desktop-race-clear",
        owner: "desktop",
        threadId: "thread-old-context",
        turnId: "desktop-race-turn",
      }).acquired;
    };

    await ingest(bridge, 42, "clear");

    assert.equal(desktopAcquiredDuringClear, false);
    assert.deepEqual(codex.startedCwds, ["D:\\Selected"]);
    assert.equal(state.getBinding(1_001)?.threadId, "thread-cleared-context");
    assert.equal(leases.getLease("thread-old-context"), null);
    assert.match(sent[0]?.text ?? "", /已清除当前上下文/u);
    assert.deepEqual(codex.archivedThreadIds, ["thread-old-context"]);
    assert.match(sent[0]?.text ?? "", /原会话已归档，可用 sarc 查看/u);
  });
});

test("clear replaces the WeChat main session without entering a normal session", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    codex.nextStartedThreadId = "thread-cleared-main";

    await ingest(bridge, 49, "clear");

    assert.deepEqual(codex.startedCwds, ["D:\\Codex-iLink\\Inbox"]);
    assert.equal(state.getBinding(1_001), null);
    assert.deepEqual(state.getBridgeSettings(), {
      awayTimeoutMinutes: 5,
      mainThreadId: "thread-cleared-main",
      selectedProjectPath: null,
      sessionTimeoutMinutes: 30,
    });
    assert.deepEqual(codex.threadNames, [
      { name: "微信主会话", threadId: "thread-cleared-main" },
    ]);
    assert.deepEqual(codex.archivedThreadIds, ["wechat-main"]);
    assert.equal(
      sent[0]?.text,
      "已清除微信主会话上下文，当前仍在微信主会话。\n当前未选择项目。",
    );
  });
});

test("clear preserves the project environment of a notification-bound session", async () => {
  await withNavigationBridge(async ({ bridge, codex, state }) => {
    state.setBinding({
      expiresAtMs: 60_000,
      projectPath: null,
      threadId: "thread-from-desktop-notification",
      updatedAtMs: 900,
    });
    codex.reads.set("thread-from-desktop-notification", {
      thread: {
        cwd: "D:\\NotificationProject",
        id: "thread-from-desktop-notification",
        status: { type: "idle" },
      },
    });
    codex.nextStartedThreadId = "thread-cleared-notification-project";

    await ingest(bridge, 51, "clear");

    assert.deepEqual(codex.startedCwds, ["D:\\NotificationProject"]);
    assert.deepEqual(state.getBinding(1_001), {
      expiresAtMs: 1_000 + 30 * 60 * 1_000,
      projectPath: "D:\\NotificationProject",
      threadId: "thread-cleared-notification-project",
      updatedAtMs: 1_000,
    });
    assert.equal(
      state.getBridgeSettings().selectedProjectPath,
      "D:\\NotificationProject",
    );
    assert.deepEqual(codex.archivedThreadIds, [
      "thread-from-desktop-notification",
    ]);
  });
});

test("clear refuses to leave an active or queued current session behind", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.enqueueQueuedTurn({
      body: "queued old context",
      createdAtMs: 900,
      dedupeKey: "queued-before-clear",
      threadId: "wechat-main",
    });

    await ingest(bridge, 46, "clear");

    assert.deepEqual(codex.startedCwds, []);
    assert.equal(
      sent[0]?.text,
      "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。",
    );
  });
});

test("compact holds the session lease until compaction completes and then drains queued input", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent, state }) => {
    await ingest(bridge, 43, "compact");

    assert.deepEqual(codex.compactedThreads, ["wechat-main"]);
    assert.match(sent[0]?.text ?? "", /已开始压缩当前会话上下文/u);
    assert.equal(leases.getLease("wechat-main")?.owner, "bridge");
    codex.reads.set("wechat-main", {
      thread: { id: "wechat-main", status: { type: "idle" } },
    });
    await bridge.reconcilePendingWork();
    assert.equal(leases.getLease("wechat-main")?.owner, "bridge");

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/started",
        params: {
          threadId: "wechat-main",
          turn: { id: "stale-normal-turn" },
        },
      }),
      false,
    );
    assert.equal(leases.getLease("wechat-main")?.turnId, null);

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "wechat-main",
          turn: { id: "stale-old-turn", status: "completed" },
        },
      }),
      false,
    );
    assert.equal(leases.getLease("wechat-main")?.turnId, null);

    await ingest(bridge, 44, "压缩完成后继续");
    assert.equal(state.countQueuedTurns(), 1);
    assert.deepEqual(codex.startedTurns, []);
    assert.match(sent[1]?.text ?? "", /Queued/u);

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "item/started",
        params: {
          item: { id: "compact-item", type: "contextCompaction" },
          threadId: "wechat-main",
          turnId: "turn-compact",
        },
      }),
      true,
    );
    assert.equal(leases.getLease("wechat-main")?.turnId, "turn-compact");

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "wechat-main",
          turn: { id: "turn-compact", status: "completed" },
        },
      }),
      true,
    );
    assert.deepEqual(codex.startedTurns, [
      { text: "压缩完成后继续", threadId: "wechat-main" },
    ]);
  });
});

test("a failed compact turn reports a stable error after releasing its lease", async () => {
  await withNavigationBridge(async ({ bridge, sent }) => {
    await ingest(bridge, 50, "compact");
    await bridge.ingestCodexEvent({
      method: "item/started",
      params: {
        item: { id: "failed-compact-item", type: "contextCompaction" },
        threadId: "wechat-main",
        turnId: "turn-compact-failed",
      },
    });

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "wechat-main",
          turn: { id: "turn-compact-failed", status: "failed" },
        },
      }),
      true,
    );
    assert.equal(
      sent[1]?.text,
      "E_CONTEXT_COMPACT_FAILED：上下文压缩失败，请在 Desktop 查看。",
    );
  });
});

test("an unknown compact request releases after public idle reconciliation", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent, state }) => {
    codex.compactError = new CodexOutcomeUnknownError(
      "thread/compact/start",
      "eof",
    );
    codex.reads.set("wechat-main", {
      thread: { id: "wechat-main", status: { type: "idle" } },
    });

    await ingest(bridge, 52, "compact");

    assert.match(sent[0]?.text ?? "", /压缩请求结果未知/u);
    assert.equal(leases.getLease("wechat-main")?.owner, "bridge");
    await ingest(bridge, 53, "结果未知后继续");
    assert.equal(state.countQueuedTurns(), 1);

    await bridge.reconcilePendingWork();

    assert.equal(leases.getLease("wechat-main")?.owner, "bridge");
    assert.equal(state.countQueuedTurns(), 0);
    assert.deepEqual(codex.startedTurns, [
      { text: "结果未知后继续", threadId: "wechat-main" },
    ]);
  });
});

test("a timed out compact request keeps its lease despite an immediate idle read", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent }) => {
    codex.compactError = new CodexOutcomeUnknownError(
      "thread/compact/start",
      "timeout",
    );
    codex.reads.set("wechat-main", {
      thread: { id: "wechat-main", status: { type: "idle" } },
    });

    await ingest(bridge, 54, "compact");
    const operationId = leases.getLease("wechat-main")?.operationId;
    await bridge.reconcilePendingWork();

    assert.match(sent[0]?.text ?? "", /压缩请求结果未知/u);
    assert.equal(leases.getLease("wechat-main")?.operationId, operationId);
  });
});

test("unknown compact reconciliation reports a failed claimed turn", async () => {
  await withNavigationBridge(async ({ bridge, codex, leases, sent }) => {
    codex.compactError = new CodexOutcomeUnknownError(
      "thread/compact/start",
      "eof",
    );
    await ingest(bridge, 55, "compact");
    await bridge.ingestCodexEvent({
      method: "item/started",
      params: {
        item: { id: "unknown-compact-item", type: "contextCompaction" },
        threadId: "wechat-main",
        turnId: "turn-compact-unknown-failed",
      },
    });
    codex.reads.set("wechat-main", {
      thread: {
        id: "wechat-main",
        turns: [
          { id: "turn-compact-unknown-failed", status: "failed" },
        ],
      },
    });

    await bridge.reconcilePendingWork();

    assert.equal(leases.getLease("wechat-main"), null);
    assert.equal(
      sent[1]?.text,
      "E_CONTEXT_COMPACT_FAILED：上下文压缩失败，请在 Desktop 查看。",
    );
  });
});

test("perm reads the current Codex task permissions without a write path", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.resumes.set("wechat-main", {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: "D:/Codex-iLink/Inbox",
      sandbox: { type: "workspaceWrite" },
      thread: { id: "wechat-main" },
    });

    await ingest(bridge, 45, "perm");

    assert.equal(
      sent[0]?.text,
      [
        "Codex 当前权限：工作区（推荐） (:workspace)",
        "审批：on-request；审批人：user",
        "Sandbox：workspaceWrite",
        "当前任务权限只能在 Codex Desktop 中修改；新任务默认值可用 ilink config 设置。",
      ].join(String.fromCharCode(10)),
    );
    assert.doesNotMatch(sent[0]?.text ?? "", /perm<n>|只读/u);

    codex.resumes.set("wechat-main", {
      activePermissionProfile: { id: ":danger-full-access" },
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      cwd: "D:/Codex-iLink/Inbox",
      sandbox: { type: "dangerFullAccess" },
      thread: { id: "wechat-main" },
    });

    await ingest(bridge, 46, "perm3");

    assert.equal(
      sent[1]?.text,
      [
        "Codex 当前权限：完全访问 (:danger-full-access)",
        "审批：never；审批人：auto_review",
        "Sandbox：dangerFullAccess",
        "当前任务权限只能在 Codex Desktop 中修改；新任务默认值可用 ilink config 设置。",
      ].join(String.fromCharCode(10)),
    );
    assert.deepEqual(
      codex.calls.filter((call) => call === "resume:wechat-main"),
      ["resume:wechat-main", "resume:wechat-main"],
    );
  });
});

test("perm reports future Codex permission metadata without inference", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.resumes.set("wechat-main", {
      activePermissionProfile: { id: "custom-team-profile" },
      approvalPolicy: "future-policy",
      approvalsReviewer: "future_reviewer",
      cwd: "D:/Codex-iLink/Inbox",
      sandbox: { type: "futureSandbox" },
      thread: { id: "wechat-main" },
    });

    await ingest(bridge, 47, "perm");

    assert.equal(
      sent[0]?.text,
      [
        "Codex 当前权限：自定义 (custom-team-profile)",
        "审批：future-policy；审批人：future_reviewer",
        "Sandbox：futureSandbox",
        "当前任务权限只能在 Codex Desktop 中修改；新任务默认值可用 ilink config 设置。",
      ].join(String.fromCharCode(10)),
    );
  });
});

test("permission query failures do not block subsequent ordinary messages", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.resumeError = new Error("permission metadata unavailable");

    await ingest(bridge, 48, "perm");
    assert.equal(sent[0]?.text, "权限查询失败，请稍后重试。");

    codex.resumeError = undefined;
    await ingest(bridge, 49, "continue after permission query failure");
    assert.deepEqual(codex.startedTurns, [
      {
        text: "continue after permission query failure",
        threadId: "wechat-main",
      },
    ]);
  });
});

test("model and effort commands update only the current shared Codex session", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.setBinding({
      expiresAtMs: 31 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-current",
      updatedAtMs: 1_000,
    });
    codex.resumes.set("thread-current", {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: "D:\\Codex-iLink\\Inbox",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      sandbox: { type: "workspaceWrite" },
      thread: { id: "thread-current" },
    });

    await ingest(bridge, 50, "model");
    assert.equal(
      sent[0]?.text,
      [
        "当前模型：1. GPT-5.6 Sol (gpt-5.6-sol)",
        "推理强度：medium",
        "",
        "1. GPT-5.6 Sol (gpt-5.6-sol) · medium/high/xhigh",
        "2. GPT-5.6 Terra (gpt-5.6-terra) · low/medium/high",
        "使用 model<n> 或 model:<id> 切换当前任务模型。",
      ].join("\n"),
    );

    await ingest(bridge, 51, "model2");
    assert.equal(
      sent[1]?.text,
      [
        "已切换当前任务模型：GPT-5.6 Terra (gpt-5.6-terra)",
        "推理强度：medium",
        "此设置属于当前共享会话，Desktop 同一任务也会生效。",
      ].join("\n"),
    );

    await ingest(bridge, 52, "model:gpt-5.6-sol");
    await ingest(bridge, 521, "把当前任务模型换成 Sol");
    await ingest(bridge, 53, "effort");
    assert.equal(
      sent[4]?.text,
      [
        "当前模型：GPT-5.6 Sol (gpt-5.6-sol)",
        "当前推理强度：medium",
        "",
        "1. medium — Balanced",
        "2. high — Deep",
        "3. xhigh — Extra deep",
        "使用 effort<n> 或 effort:<level> 切换当前任务推理强度。",
      ].join("\n"),
    );

    await ingest(bridge, 54, "effort:high");
    await ingest(bridge, 55, "effort:xhigh");
    assert.equal(
      sent[6]?.text,
      [
        "已切换当前任务推理强度：xhigh",
        "模型：GPT-5.6 Sol (gpt-5.6-sol)",
        "此设置属于当前共享会话，Desktop 同一任务也会生效。",
      ].join("\n"),
    );
    assert.deepEqual(codex.modelSettingSelections, [
      {
        effort: "medium",
        model: "gpt-5.6-terra",
        threadId: "thread-current",
      },
      {
        effort: "medium",
        model: "gpt-5.6-sol",
        threadId: "thread-current",
      },
      {
        effort: "medium",
        model: "gpt-5.6-sol",
        threadId: "thread-current",
      },
      { effort: "high", threadId: "thread-current" },
      { effort: "xhigh", threadId: "thread-current" },
    ]);
    assert.equal(codex.resumes.has("wechat-main"), false);
  });
});

test("ambiguous control-like text uses the isolated classifier fallback", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.controlClassification = { kind: "help" };

    await ingest(bridge, 56, "帮我查看一下控制命令怎么用");

    assert.deepEqual(codex.classifiedTexts, ["帮我查看一下控制命令怎么用"]);
    assert.equal(sent[0]?.text, COMMAND_HELP);
  });
});

test("compound controls execute in order and produce one consolidated reply", async () => {
  await withNavigationBridge(async ({ bridge, clock, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    state.setBinding({
      expiresAtMs: clock.value + 15 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-current",
      updatedAtMs: clock.value,
    });

    await ingest(bridge, 57, "返回主会话主任务，然后把状态显示一下");

    assert.equal(state.getBinding(clock.value), null);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /^已返回微信主会话。/u);
    assert.match(sent[0]?.text ?? "", /会话：微信主会话/u);
    assert.match(sent[0]?.text ?? "", /项目：无项目/u);
  });
});

test("AI fallback can return a validated compound control", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, sent, state }) => {
    state.setBinding({
      expiresAtMs: clock.value + 15 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-current",
      updatedAtMs: clock.value,
    });
    codex.controlClassification = {
      intents: [{ kind: "exitSession" }, { kind: "status" }],
      kind: "controlSequence",
    };

    await ingest(bridge, 58, "回到先前的会话，再查看当前状态");

    assert.deepEqual(codex.classifiedTexts, ["回到先前的会话，再查看当前状态"]);
    assert.equal(state.getBinding(clock.value), null);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /^已返回微信主会话。/u);
    assert.match(sent[0]?.text ?? "", /会话：微信主会话/u);
  });
});

test("compound controls stop before dependent actions when an earlier command fails", async () => {
  await withNavigationBridge(
    async ({ bridge, codex, sent, state }) => {
      state.setSelectedProjectPath("D:\\Original");

      await ingest(bridge, 59, "切换到第99个项目，然后新建任务");

      assert.deepEqual(codex.startedCwds, []);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.text, "项目编号无效，请按 p 当前列表选择。");
    },
    {
      projects: [{ cwd: "D:\\Only", name: "Only" }],
    },
  );
});

test("a failed session page command cannot enter from a different snapshot", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.activeThreads = [
      {
        cwd: "D:\\Selected",
        id: "thread-first-page",
        name: "First page",
        status: { type: "idle" },
        updatedAt: 1,
      },
    ];

    await ingest(bridge, 60, "下一页任务，然后打开第一个会话");

    assert.equal(codex.calls.includes("resume:thread-first-page"), false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, "会话列表已过期，请先用 s 或 sarc 刷新。");
  });
});

test("st reports current routing, every known active task, queues, and health", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, leases, sent, state }) => {
    clock.value = 100_000;
    state.setSelectedProjectPath("D:\\Selected");
    state.setBinding({
      expiresAtMs: 100_000 + 15 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-current",
      updatedAtMs: 99_000,
    });
    state.putNotificationRoute({
      deliveredAtMs: 99_000,
      eventId: "notification-live",
      expiresAtMs: 101_000,
      threadId: "thread-notification",
    });
    state.enqueueQueuedTurn({
      body: "secret queued body one",
      createdAtMs: 1,
      dedupeKey: "queue-1",
      threadId: "thread-current",
    });
    state.enqueueQueuedTurn({
      body: "secret queued body two",
      createdAtMs: 2,
      dedupeKey: "queue-2",
      threadId: "thread-other",
    });
    state.enableArbitration("bridge-navigation");
    state.observeDesktopTurn({
      createdAtMs: 99_700,
      threadId: "thread-observed-unrelated",
      turnId: "desktop-observed-unrelated",
    });
    codex.activeThreads = [
      {
        cwd: "D:\\Selected",
        id: "thread-current",
        name: "排查审批卡住问题",
        status: { type: "idle" },
        updatedAt: 40,
      },
      {
        cwd: "D:\\Selected",
        id: "thread-active-a",
        name: "Active A",
        status: { type: "active" },
        updatedAt: 20,
      },
      {
        cwd: "D:\\Other",
        id: "thread-idle",
        name: "Idle",
        status: { type: "idle" },
        updatedAt: 30,
      },
      {
        cwd: "D:\\Other",
        id: "thread-active-b",
        name: "Active B",
        status: "active",
        updatedAt: 10,
      },
    ];
    leases.tryAcquire({
      createdAtMs: 99_500,
      instanceId: "desktop",
      operationId: "desktop-active-a",
      owner: "desktop",
      threadId: "thread-active-a",
      turnId: "desktop-active-a",
    });
    leases.tryAcquire({
      createdAtMs: 99_600,
      instanceId: "bridge-navigation",
      operationId: "lease-only-operation",
      owner: "bridge",
      threadId: "thread-lease-only",
      turnId: "lease-only-turn",
    });

    await ingest(bridge, 50, "st");

    const reply = sent[0]?.text ?? "";
    assert.match(reply, /项目：Selected/u);
    assert.match(reply, /会话：排查审批卡住问题（剩余 30 分钟）/u);
    assert.match(reply, /权限：工作区（推荐） \(:workspace\)/u);
    assert.match(
      reply,
      /审批：on-request；审批人：user；Sandbox：workspaceWrite/u,
    );
    assert.equal(
      state.getBinding(100_001)?.expiresAtMs,
      100_000 + 30 * 60 * 1_000,
    );
    assert.match(reply, /活动任务：3/u);
    assert.match(reply, /Active A \(thread-active-a\)/u);
    assert.match(reply, /Active B \(thread-active-b\)/u);
    assert.match(
      reply,
      /微信任务（租约活动，状态保守） \(thread-lease-only\)/u,
    );
    assert.doesNotMatch(reply, /Idle/u);
    assert.doesNotMatch(reply, /thread-observed-unrelated/u);
    assert.match(reply, /队列：2/u);
    assert.match(reply, /通知回复窗口：1/u);
    assert.match(reply, /连接：正常/u);
    assert.doesNotMatch(reply, /secret queued body/u);
    assert.equal(state.listInboundMessages().at(-1)?.body, null);
  });
});

test("st hides zero-value diagnostics while keeping permission details", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, sent, state }) => {
    clock.value = 100_000;
    state.setSelectedProjectPath("D:\\Selected");
    state.setBinding({
      expiresAtMs: 100_000 + 30 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-current",
      updatedAtMs: 99_000,
    });
    state.enableArbitration("bridge-navigation");
    codex.activeThreads = [
      {
        cwd: "D:\\Selected",
        id: "thread-current",
        name: "简洁状态",
        status: { type: "idle" },
        updatedAt: 1,
      },
    ];

    await ingest(bridge, 61, "st");

    assert.equal(
      sent[0]?.text,
      [
        "项目：Selected",
        "会话：简洁状态（剩余 30 分钟）",
        "权限：工作区（推荐） (:workspace)",
        "审批：on-request；审批人：user；Sandbox：workspaceWrite",
        "状态：空闲",
        "连接：正常",
      ].join("\n"),
    );
  });
});

type SendInput = {
  clientId: string;
  contextToken: string;
  session: ILinkSession;
  text: string;
};

class FakeNavigationCodex implements CodexTurnStarter {
  activeThreads: unknown[] = [];
  archivedThreadIds: string[] = [];
  archivedThreads: unknown[] = [];
  beforeStartThread: (() => Promise<void> | void) | undefined;
  calls: string[] = [];
  reads = new Map<string, { thread: Record<string, unknown> }>();
  readFailures = new Set<string>();
  resumes = new Map<string, Record<string, unknown>>();
  resumeError: Error | undefined;
  nextStartedThreadId = "thread-new";
  controlClassification: unknown = null;
  classifiedTexts: string[] = [];
  models = [
    {
      defaultReasoningEffort: "medium",
      displayName: "GPT-5.6 Sol",
      hidden: false,
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [
        { description: "Balanced", reasoningEffort: "medium" },
        { description: "Deep", reasoningEffort: "high" },
        { description: "Extra deep", reasoningEffort: "xhigh" },
      ],
    },
    {
      defaultReasoningEffort: "medium",
      displayName: "GPT-5.6 Terra",
      hidden: false,
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      supportedReasoningEfforts: [
        { description: "Quick", reasoningEffort: "low" },
        { description: "Balanced", reasoningEffort: "medium" },
        { description: "Deep", reasoningEffort: "high" },
      ],
    },
  ];
  modelSettingSelections: Array<{
    effort?: string;
    model?: string;
    threadId: string;
  }> = [];
  ensuredPermissions: Array<{ threadId: string }> = [];
  compactedThreads: string[] = [];
  compactError: Error | undefined;
  interruptedTurns: Array<{ threadId: string; turnId: string }> = [];
  interruptError: Error | undefined;
  onInterrupt:
    | ((input: { threadId: string; turnId: string }) => Promise<void> | void)
    | undefined;
  startedCwds: string[] = [];
  startedPermissions: Array<Record<string, unknown> | undefined> = [];
  startedTurns: Array<{ text: string; threadId: string }> = [];
  threadNames: Array<{ name: string; threadId: string }> = [];
  readonly loadedThreadIds = new Set<string>();

  async listThreads(input: { archived: boolean; cursor?: string }) {
    assert.equal(input.cursor, undefined);
    return {
      data: input.archived ? this.archivedThreads : this.activeThreads,
      nextCursor: null,
    };
  }

  async ensureThread(threadId: string): Promise<void> {
    this.ensuredPermissions.push({ threadId });
    if (this.loadedThreadIds.has(threadId)) return;
    await this.resumeThread(threadId);
  }

  async startTurn(input: { text: string; threadId: string }): Promise<{ turn: { id: string } }> {
    this.startedTurns.push({ text: input.text, threadId: input.threadId });
    return { turn: { id: `turn-${String(this.startedTurns.length)}` } };
  }

  async compactThread(threadId: string): Promise<Record<string, unknown>> {
    if (this.compactError) throw this.compactError;
    this.compactedThreads.push(threadId);
    return {};
  }

  async interruptTurn(input: {
    threadId: string;
    turnId: string;
  }): Promise<Record<string, unknown>> {
    if (this.interruptError) throw this.interruptError;
    this.interruptedTurns.push(input);
    await this.onInterrupt?.(input);
    return {};
  }

  async readThread(input: { includeTurns: boolean; threadId: string }) {
    assert.equal(input.includeTurns, true);
    this.calls.push(`read:${input.threadId}`);
    if (this.readFailures.has(input.threadId)) {
      throw new Error("preview unavailable");
    }
    return this.reads.get(input.threadId) ?? { thread: { id: input.threadId } };
  }

  async listModels() {
    return { data: this.models, nextCursor: null };
  }

  async classifyControlIntent(input: { cwd: string; text: string }) {
    assert.equal(input.cwd, "D:\\Codex-iLink\\Inbox");
    this.classifiedTexts.push(input.text);
    return this.controlClassification;
  }

  async resumeThread(threadId: string) {
    this.calls.push(`resume:${threadId}`);
    if (this.resumeError) throw this.resumeError;
    this.loadedThreadIds.add(threadId);
    return this.resumes.get(threadId) ?? {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: "D:\\Codex-iLink\\Inbox",
      sandbox: { type: "workspaceWrite" },
      thread: { id: threadId },
    };
  }

  async updateThreadModelSettings(
    threadId: string,
    settings: { effort?: string; model?: string },
  ) {
    const current = await this.resumeThread(threadId);
    this.modelSettingSelections.push({ ...settings, threadId });
    const selected = {
      ...current,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
    };
    this.resumes.set(threadId, selected);
    return selected;
  }

  async archiveThread(threadId: string) {
    this.calls.push(`archive:${threadId}`);
    this.archivedThreadIds.push(threadId);
    return { thread: { id: threadId } };
  }

  async unarchiveThread(threadId: string) {
    this.calls.push(`unarchive:${threadId}`);
    return { thread: { id: threadId } };
  }

  async setThreadName(input: { name: string; threadId: string }) {
    this.calls.push(`name:${input.threadId}:${input.name}`);
    this.threadNames.push(input);
    return { name: input.name };
  }

  async startThread(cwd: string, permissions?: Record<string, unknown>) {
    await this.beforeStartThread?.();
    this.startedCwds.push(cwd);
    this.startedPermissions.push(permissions);
    this.loadedThreadIds.add(this.nextStartedThreadId);
    return {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      thread: { cwd, id: this.nextStartedThreadId },
    };
  }
}

async function withNavigationBridge(
  run: (input: {
    bridge: BridgeEngine;
    clock: { value: number };
    codex: FakeNavigationCodex;
    leases: SqliteTurnLeaseStore;
    sent: SendInput[];
    state: SqliteState;
  }) => Promise<void>,
  options: {
    projects?: readonly { cwd: string; name: string }[];
  } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-navigation-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  const codex = new FakeNavigationCodex();
  let id = 0;
  const clock = { value: 1_000 };
  state.bindController({
    accountId: session.botId,
    boundAtMs: 1,
    userId: session.controllerUserId,
  });
  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-navigation",
    codex,
    ilink: {
      async sendText(input: SendInput): Promise<SendTextResult> {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    inboxDirectory: "D:\\Codex-iLink\\Inbox",
    leases,
    mainThreadId: "wechat-main",
    newId: () => `navigation-${++id}`,
    now: () => clock.value,
    ...(options.projects
      ? { listProjects: () => options.projects ?? [] }
      : {}),
    session,
    state,
  });

  try {
    await run({ bridge, clock, codex, leases, sent, state });
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function ingest(bridge: BridgeEngine, id: number, text: string) {
  return bridge.ingestBatch({
    cursor: `cursor-${id}`,
    messages: [textMessage(id, text)],
  });
}

function textMessage(id: number, text: string): WireWeixinMessage {
  return {
    context_token: `context-${id}`,
    create_time_ms: id,
    from_user_id: session.controllerUserId,
    item_list: [{ text_item: { text }, type: 1 }],
    message_id: id,
  };
}
