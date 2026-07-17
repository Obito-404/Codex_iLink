import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BridgeEngine,
  type CodexTurnStarter,
} from "../src/bridge/bridge.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";
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

test("/p creates a fixed ten-minute snapshot and /p n selects from it", async () => {
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

    assert.deepEqual(await ingest(bridge, 1, "/p"), { accepted: 1, sent: 1 });
    assert.match(sent[0]?.text ?? "", /1\. Newest/u);
    assert.match(sent[0]?.text ?? "", /2\. Older/u);

    codex.activeThreads = [
      { cwd: "D:\\Inserted-Later", id: "inserted", updatedAt: 100 },
    ];
    assert.deepEqual(await ingest(bridge, 2, "/p 2"), {
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

test("/p n selects from the current Desktop projects without a prior list", async () => {
  await withNavigationBridge(async ({ bridge, sent, state }) => {
    assert.deepEqual(await ingest(bridge, 3, "/p 2"), {
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

test("/p mirrors Desktop saved projects by name while routing with hidden paths", async () => {
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

    await ingest(bridge, 3, "/p");

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
        "使用 /p <n> 选择项目；编号自本列表生成起 10 分钟内有效。",
      ].join("\n"),
    );
    assert.doesNotMatch(sent[0]?.text ?? "", /D:\\\\/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /System32/u);

    await ingest(bridge, 4, "/p 6");
    assert.equal(
      state.getBridgeSettings().selectedProjectPath,
      "D:\\project\\ExcelMapper",
    );
    assert.match(sent[1]?.text ?? "", /已选择项目：ExcelMapper/u);
    assert.doesNotMatch(sent[1]?.text ?? "", /D:\\\\/u);
  }, { projects });
});

test("/p fails closed when the Desktop project catalog is unavailable", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent }) => {
    codex.activeThreads = [
      { cwd: "C:\\Windows\\System32", id: "historical-thread", updatedAt: 99 },
    ];

    await ingest(bridge, 5, "/p");

    assert.equal(sent[0]?.text, "项目命令执行失败，请稍后重试。");
    assert.doesNotMatch(sent[0]?.text ?? "", /System32|C:\\\\/u);
  });
});

test("/s n enters the current first-page session without a prior list", async () => {
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

    await ingest(bridge, 9, "/s 2");

    assert.deepEqual(codex.calls, [
      "resume:thread-second",
      "read:thread-second",
    ]);
    assert.equal(state.getBinding(1_001)?.threadId, "thread-second");
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /已进入会话：thread-second/u);
  });
});

test("/s pages the selected project's sessions and /s n binds the displayed session", async () => {
  await withNavigationBridge(async ({ bridge, clock, codex, sent, state }) => {
    state.setSelectedProjectPath("D:\\Selected");
    codex.activeThreads = Array.from({ length: 12 }, (_, index) => ({
      cwd: "D:\\Selected",
      id: `thread-${String(index + 1).padStart(2, "0")}`,
      name: `Task ${index + 1}`,
      status: { type: "idle" },
      updatedAt: index + 1,
    }));

    await ingest(bridge, 10, "/s");
    assert.match(sent[0]?.text ?? "", /1\. Task 12 \[idle\]/u);
    assert.match(sent[0]?.text ?? "", /10\. Task 3 \[idle\]/u);
    assert.match(sent[0]?.text ?? "", /下一页：\/s \+/u);

    await ingest(bridge, 11, "/s +");
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

    await ingest(bridge, 12, "/s 2");
    assert.deepEqual(codex.calls.slice(-2), [
      "resume:thread-01",
      "read:thread-01",
    ]);
    assert.deepEqual(state.getBinding(50_001), {
      expiresAtMs: 50_000 + 30 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-01",
      updatedAtMs: 50_000,
    });
    assert.deepEqual(state.listLiveNotificationRoutes(50_001), []);
    assert.match(sent[2]?.text ?? "", /已进入会话：Task 1/u);
    assert.match(sent[2]?.text ?? "", /模型：gpt-project/u);
    assert.match(sent[2]?.text ?? "", /权限：项目读写 \(:workspace\)/u);
    assert.match(sent[2]?.text ?? "", /审批：on-request/u);
    assert.match(sent[2]?.text ?? "", /Sandbox：workspaceWrite/u);
    assert.match(sent[2]?.text ?? "", /最近提问：上次问题/u);
    assert.match(sent[2]?.text ?? "", /最近回复：上次答案/u);
  });
});

test("/s arc keeps archived identity and /s n unarchives before resuming", async () => {
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

    await ingest(bridge, 20, "/s arc");
    await ingest(bridge, 21, "/s 1");

    assert.deepEqual(codex.calls.slice(-3), [
      "unarchive:thread-archived",
      "resume:thread-archived",
      "read:thread-archived",
    ]);
    assert.match(sent[1]?.text ?? "", /^Unarchived\n/u);
    assert.equal(state.getBinding(1_000)?.threadId, "thread-archived");
  });
});

test("/s n keeps the successful binding when preview reading is temporarily unavailable", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    codex.activeThreads = [
      {
        cwd: "D:\\Codex-iLink\\Inbox",
        id: "thread-preview-unavailable",
        updatedAt: 1,
      },
    ];
    codex.readFailures.add("thread-preview-unavailable");

    await ingest(bridge, 25, "/s");
    await ingest(bridge, 26, "/s 1");

    assert.equal(state.getBinding(1_001)?.threadId, "thread-preview-unavailable");
    assert.match(
      sent[1]?.text ?? "",
      /已进入会话：thread-preview-unavailable/u,
    );
    assert.doesNotMatch(sent[1]?.text ?? "", /执行失败/u);
  });
});

test("/new creates in the selected project, binds immediately, and /exit returns to main", async () => {
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

    await ingest(bridge, 30, "/new");
    assert.deepEqual(codex.startedCwds, ["D:\\Selected"]);
    assert.deepEqual(state.getBinding(10_001), {
      expiresAtMs: 10_000 + 30 * 60 * 1_000,
      projectPath: "D:\\Selected",
      threadId: "thread-new-project",
      updatedAtMs: 10_000,
    });
    assert.deepEqual(state.listLiveNotificationRoutes(10_001), []);
    assert.match(sent[0]?.text ?? "", /已新建并进入会话：thread-new-project/u);
    assert.match(sent[0]?.text ?? "", /权限：项目读写 \(:workspace\)/u);
    assert.match(sent[0]?.text ?? "", /审批：on-request/u);
    assert.match(sent[0]?.text ?? "", /Sandbox：workspaceWrite/u);

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
    await ingest(bridge, 31, "/exit");
    assert.equal(state.getBinding(10_001), null);
    assert.deepEqual(state.listLiveNotificationRoutes(10_001), []);
    assert.equal(state.getBridgeSettings().selectedProjectPath, "D:\\Selected");
    assert.match(sent[1]?.text ?? "", /已返回微信主会话/u);

    await ingest(bridge, 33, "main task question");
    assert.deepEqual(codex.startedTurns, [
      { text: "new task question", threadId: "thread-new-project" },
      { text: "main task question", threadId: "wechat-main" },
    ]);
    assert.equal(state.countQueuedTurns(), 0);
    assert.doesNotMatch(sent.map(({ text }) => text).join("\n"), /Queued/u);
  });
});

test("/new without a project uses the reserved Inbox and stays product-level unprojected", async () => {
  await withNavigationBridge(async ({ bridge, codex, state }) => {
    codex.nextStartedThreadId = "thread-new-inbox";

    await ingest(bridge, 40, "/new");

    assert.deepEqual(codex.startedCwds, ["D:\\Codex-iLink\\Inbox"]);
    assert.equal(state.getBinding(1_001)?.projectPath, null);
    assert.equal(state.getBinding(1_001)?.threadId, "thread-new-inbox");
  });
});

test("/perm lists and directly selects Codex native permission profiles", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    codex.resumes.set("wechat-main", {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      cwd: "D:\\Codex-iLink\\Inbox",
      sandbox: { type: "workspaceWrite" },
      thread: { id: "wechat-main" },
    });

    await ingest(bridge, 45, "/perm");

    assert.equal(
      sent[0]?.text,
      [
        "当前权限：2. 项目读写 (:workspace)",
        "审批：on-request",
        "Sandbox：workspaceWrite",
        "",
        "1. 只读 (:read-only)",
        "2. 项目读写 (:workspace)",
        "3. 完全访问 (:danger-full-access)",
        "使用 /perm <n> 直接切换当前任务权限。",
      ].join("\n"),
    );

    await ingest(bridge, 46, "/perm 3");

    assert.match(sent[1]?.text ?? "", /已切换当前任务权限/u);
    assert.match(sent[1]?.text ?? "", /3\. 完全访问 \(:danger-full-access\)/u);
    assert.match(sent[1]?.text ?? "", /审批：never/u);
    assert.match(sent[1]?.text ?? "", /Sandbox：dangerFullAccess/u);
    assert.deepEqual(codex.permissionSelections, [
      { permissions: ":danger-full-access", threadId: "wechat-main" },
    ]);
    assert.deepEqual(state.getThreadPermissionProfile("wechat-main"), {
      profileId: ":danger-full-access",
      threadId: "wechat-main",
      updatedAtMs: 1_000,
    });

    await ingest(bridge, 47, "use the selected permissions");
    assert.deepEqual(codex.ensuredPermissions.at(-1), {
      permissions: ":danger-full-access",
      threadId: "wechat-main",
    });
  });
});

test("/perm can explicitly recover when a saved profile is no longer allowed", async () => {
  await withNavigationBridge(async ({ bridge, codex, sent, state }) => {
    state.setThreadPermissionProfile({
      profileId: ":danger-full-access",
      threadId: "wechat-main",
      updatedAtMs: 900,
    });
    codex.blockedPermissionProfiles.add(":danger-full-access");
    codex.permissionProfiles[2] = {
      allowed: false,
      description: null,
      id: ":danger-full-access",
    };

    await ingest(bridge, 48, "/perm");

    assert.match(sent[0]?.text ?? "", /Codex 未能确认当前权限/u);
    assert.match(
      sent[0]?.text ?? "",
      /3\. 完全访问 \(:danger-full-access\)（不可用）/u,
    );

    await ingest(bridge, 49, "/perm 2");

    assert.match(sent[1]?.text ?? "", /已切换当前任务权限/u);
    assert.deepEqual(state.getThreadPermissionProfile("wechat-main"), {
      profileId: ":workspace",
      threadId: "wechat-main",
      updatedAtMs: 1_000,
    });
  });
});

test("/st reports current routing, every known active task, queues, and health", async () => {
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

    await ingest(bridge, 50, "/st");

    const reply = sent[0]?.text ?? "";
    assert.match(reply, /项目：Selected/u);
    assert.match(reply, /会话：thread-current（剩余 30 分钟）/u);
    assert.match(reply, /权限：项目读写 \(:workspace\)/u);
    assert.match(reply, /审批：on-request；Sandbox：workspaceWrite/u);
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
    assert.match(reply, /连接：Codex 正常；仲裁正常/u);
    assert.doesNotMatch(reply, /secret queued body/u);
    assert.equal(state.listInboundMessages().at(-1)?.body, null);
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
  archivedThreads: unknown[] = [];
  blockedPermissionProfiles = new Set<string>();
  calls: string[] = [];
  reads = new Map<string, { thread: Record<string, unknown> }>();
  readFailures = new Set<string>();
  resumes = new Map<string, Record<string, unknown>>();
  nextStartedThreadId = "thread-new";
  permissionProfiles = [
    { allowed: true, description: null, id: ":read-only" },
    { allowed: true, description: null, id: ":workspace" },
    { allowed: true, description: null, id: ":danger-full-access" },
  ];
  permissionSelections: Array<{ permissions: string; threadId: string }> = [];
  ensuredPermissions: Array<{
    permissions: string | undefined;
    threadId: string;
  }> = [];
  startedCwds: string[] = [];
  startedTurns: Array<{ text: string; threadId: string }> = [];
  readonly loadedThreadIds = new Set<string>();

  async listThreads(input: { archived: boolean; cursor?: string }) {
    assert.equal(input.cursor, undefined);
    return {
      data: input.archived ? this.archivedThreads : this.activeThreads,
      nextCursor: null,
    };
  }

  async ensureThread(
    threadId: string,
    options: { permissions?: string } = {},
  ): Promise<void> {
    this.ensuredPermissions.push({
      permissions: options.permissions,
      threadId,
    });
    if (this.loadedThreadIds.has(threadId)) return;
    await this.resumeThread(threadId, options);
  }

  async startTurn(input: { text: string; threadId: string }): Promise<{ turn: { id: string } }> {
    this.startedTurns.push({ text: input.text, threadId: input.threadId });
    return { turn: { id: `turn-${String(this.startedTurns.length)}` } };
  }

  async readThread(input: { includeTurns: boolean; threadId: string }) {
    assert.equal(input.includeTurns, true);
    this.calls.push(`read:${input.threadId}`);
    if (this.readFailures.has(input.threadId)) {
      throw new Error("preview unavailable");
    }
    return this.reads.get(input.threadId) ?? { thread: { id: input.threadId } };
  }

  async listPermissionProfiles(input: { cwd?: string }) {
    this.calls.push(`permissionProfiles:${input.cwd ?? "default"}`);
    return { data: this.permissionProfiles, nextCursor: null };
  }

  async resumeThread(threadId: string, options: { permissions?: string } = {}) {
    this.calls.push(`resume:${threadId}`);
    this.loadedThreadIds.add(threadId);
    if (
      options.permissions &&
      this.blockedPermissionProfiles.has(options.permissions)
    ) {
      throw new Error("permission profile is no longer allowed");
    }
    const current = this.resumes.get(threadId) ?? {
      activePermissionProfile: { id: ":workspace" },
      approvalPolicy: "on-request",
      cwd: "D:\\Codex-iLink\\Inbox",
      sandbox: { type: "workspaceWrite" },
      thread: { id: threadId },
    };
    if (!options.permissions) return current;
    this.permissionSelections.push({
      permissions: options.permissions,
      threadId,
    });
    const selected = {
      ...current,
      activePermissionProfile: { id: options.permissions },
      approvalPolicy:
        options.permissions === ":danger-full-access" ? "never" : "on-request",
      sandbox: {
        type:
          options.permissions === ":danger-full-access"
            ? "dangerFullAccess"
            : options.permissions === ":read-only"
              ? "readOnly"
              : "workspaceWrite",
      },
    };
    this.resumes.set(threadId, selected);
    return selected;
  }

  async unarchiveThread(threadId: string) {
    this.calls.push(`unarchive:${threadId}`);
    return { thread: { id: threadId } };
  }

  async startThread(cwd: string) {
    this.startedCwds.push(cwd);
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
