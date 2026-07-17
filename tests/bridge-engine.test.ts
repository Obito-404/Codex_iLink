import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BridgeEngine } from "../src/bridge/bridge.ts";
import { COMMAND_HELP } from "../src/bridge/commands.ts";
import { OutboxWorker } from "../src/bridge/outbox-worker.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import {
  parseDurableTurnInput,
  serializeDurableTurnInput,
} from "../src/bridge/turn-input.ts";
import {
  CodexOutcomeUnknownError,
  CodexRuntime,
} from "../src/codex/codex-runtime.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";
import {
  InboundMediaError,
  InboundMediaStore,
} from "../src/media/inbound-media.ts";
import type {
  ILinkSession,
  SendTextResult,
  WireWeixinMessage,
} from "../src/ilink/protocol.ts";

const session: ILinkSession = {
  baseUrl: "https://ilink.example",
  botId: "bot-a",
  botToken: "test-token",
  controllerUserId: "controller-a",
};

const fakeCodexRuntime = fileURLToPath(
  new URL("./fixtures/fake-codex-runtime.mjs", import.meta.url),
);

test("/help is deduplicated, persisted before send, and confirmed after send", async () => {
  await withBridge(async ({ bridge, sent, state }) => {
    const message = textMessage(1, "/help");
    assert.deepEqual(
      await bridge.ingestBatch({ cursor: "cursor-1", messages: [message] }),
      { accepted: 1, sent: 1 },
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, COMMAND_HELP);
    assert.equal(state.listPendingOutbox().length, 0);

    assert.deepEqual(
      await bridge.ingestBatch({ cursor: "cursor-2", messages: [message] }),
      { accepted: 0, sent: 0 },
    );
    assert.equal(sent.length, 1);
    assert.equal(state.getILinkState("bot-a")?.cursor, "cursor-2");
  });
});

test("other users are silent while controller media gets one explicit reply", async () => {
  await withBridge(async ({ bridge, sent }) => {
    const intruder = textMessage(2, "/p", "intruder");
    const media: WireWeixinMessage = {
      context_token: "ctx-media",
      from_user_id: "controller-a",
      item_list: [{ type: 2 }],
      message_id: 3,
    };
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-3",
        messages: [intruder, media],
      }),
      { accepted: 1, sent: 1 },
    );
    assert.deepEqual(sent.map(({ text }) => text), [
      "❌ 此消息包含当前不支持或不完整的媒体，未发送给 Codex。",
    ]);
  });
});

test("ordinary text acquires a lease and commits one Codex dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-bridge-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const calls: Array<Record<string, unknown>> = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        calls.push(input);
        return { turn: { id: "turn-10" } };
      },
    },
    ilink: { async sendText() { assert.fail("ordinary dispatch has no immediate reply"); } },
    leases,
    mainThreadId: "thread-main",
    newId: () => "dispatch-10",
    now: () => 2_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-10",
        messages: [textMessage(10, "继续这个任务")],
      }),
      { accepted: 1, sent: 0 },
    );
    assert.deepEqual(calls, [
      {
        clientUserMessageId: "bot-a/controller-a/10",
        text: "继续这个任务",
        threadId: "thread-main",
      },
    ]);
    assert.deepEqual(state.getDispatchIntent("dispatch-10"), {
      body: null,
      completedAtMs: null,
      contextToken: "ctx-10",
      createdAtMs: 2_000,
      dedupeKey: "bot-a/controller-a/10",
      operationId: "dispatch-10",
      status: "accepted",
      threadId: "thread-main",
      turnId: "turn-10",
      updatedAtMs: 2_000,
    });
    assert.equal(state.listInboundMessages()[0]?.body, null);
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an inbound image reaches Codex as local media and is cleaned after completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-media-bridge-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: Array<Record<string, unknown>> = [];
  const cleaned: string[] = [];
  const sent: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            status: { type: "idle" },
            turns: [
              {
                id: "turn-media",
                items: [
                  {
                    phase: "final_answer",
                    text: "图片已收到",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        started.push(input);
        return { turn: { id: "turn-media" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    media: {
      async cleanup(dedupeKey) {
        cleaned.push(dedupeKey);
      },
      async resolve({ candidate, dedupeKey }) {
        assert.equal(candidate.kind, "image");
        assert.equal(dedupeKey, "bot-a/controller-a/70");
        return {
          byteLength: 12,
          displayName: "image.jpg",
          kind: "image" as const,
          path: "C:\\Codex_iLink\\media\\image.jpg",
          status: "stored" as const,
        };
      },
    },
    newId: () => "dispatch-media",
    now: () => 7_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-media",
        messages: [imageMessage(70, "请分析图片")],
      }),
      { accepted: 1, sent: 0 },
    );
    assert.deepEqual(started, [
      {
        attachments: [
          {
            kind: "image",
            name: "image.jpg",
            path: "C:\\Codex_iLink\\media\\image.jpg",
          },
        ],
        clientUserMessageId: "bot-a/controller-a/70",
        text: "请分析图片",
        threadId: "thread-main",
      },
    ]);
    assert.deepEqual(cleaned, []);

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "thread-main",
          turn: { id: "turn-media", status: "completed" },
        },
      }),
      true,
    );
    assert.deepEqual(cleaned, ["bot-a/controller-a/70"]);
    assert.deepEqual(sent, ["图片已收到"]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("media survives FIFO queuing without a second CDN download", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-media-queue-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let resumeFails = true;
  let downloads = 0;
  const started: Array<Record<string, unknown>> = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        if (resumeFails) throw new Error("temporary resume failure");
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        started.push(input);
        return { turn: { id: "turn-queued-media" } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    media: {
      async cleanup() {},
      async resolve() {
        downloads += 1;
        return {
          byteLength: 10,
          displayName: "report.pdf",
          kind: "file" as const,
          path: "C:\\Codex_iLink\\media\\report.pdf",
          status: "stored" as const,
        };
      },
    },
    newId: (() => {
      let next = 0;
      return () => `media-operation-${String(++next)}`;
    })(),
    now: () => 8_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-media-queue",
        messages: [fileMessage(71, "阅读这个文件")],
      }),
      { accepted: 1, sent: 1 },
    );
    const queued = state.peekQueuedTurn("thread-main");
    assert.ok(queued);
    assert.doesNotMatch(queued.body, /fixture-key|fixture-param/u);
    assert.deepEqual(parseDurableTurnInput(queued.body).attachments, [
      {
        kind: "file",
        name: "report.pdf",
        path: "C:\\Codex_iLink\\media\\report.pdf",
      },
    ]);
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-media-queue-duplicate",
        messages: [fileMessage(71, "阅读这个文件")],
      }),
      { accepted: 0, sent: 0 },
    );
    assert.equal(downloads, 1);

    resumeFails = false;
    await bridge.scheduleQueuedTurns();
    assert.equal(downloads, 1);
    assert.deepEqual(started[0], {
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          path: "C:\\Codex_iLink\\media\\report.pdf",
        },
      ],
      clientUserMessageId: "bot-a/controller-a/71",
      text: "阅读这个文件",
      threadId: "thread-main",
    });
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("queued media survives a Bridge restart and reaches App Server before cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-media-restart-"));
  const databasePath = join(directory, "state.sqlite");
  const mediaRoot = join(directory, "media", "inbound");
  const encryptionKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("durable attachment across restart");
  const cipher = createCipheriv("aes-128-ecb", encryptionKey, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const dedupeKey = "bot-a/controller-a/75";
  let downloads = 0;
  let storedPath = "";

  try {
    const firstState = new SqliteState(databasePath);
    const firstLeases = new SqliteTurnLeaseStore(databasePath);
    const firstMedia = new InboundMediaStore({
      async fetch() {
        downloads += 1;
        return new Response(ciphertext);
      },
      rootDirectory: mediaRoot,
    });
    firstState.bindController({
      accountId: "bot-a",
      boundAtMs: 1,
      userId: "controller-a",
    });
    const firstBridge = new BridgeEngine({
      bridgeInstanceId: "bridge-before-restart",
      codex: {
        async resumeThread() {
          throw new Error("queue until restart");
        },
        async startTurn() {
          assert.fail("the first Bridge must leave the media queued");
        },
      },
      ilink: {
        async sendText(input) {
          return { accepted: true, clientId: input.clientId };
        },
      },
      leases: firstLeases,
      mainThreadId: "thread-main",
      media: firstMedia,
      newId: () => "operation-before-restart",
      now: () => 10_000,
      session,
      state: firstState,
    });

    try {
      assert.deepEqual(
        await firstBridge.ingestBatch({
          cursor: "cursor-media-restart",
          messages: [
            {
              context_token: "ctx-media-restart",
              create_time_ms: 75,
              from_user_id: "controller-a",
              item_list: [
                { text_item: { text: "读取重启后的附件" }, type: 1 },
                {
                  file_item: {
                    file_name: "restart-report.pdf",
                    media: {
                      aes_key: encryptionKey.toString("base64"),
                      full_url:
                        "https://novac2c.cdn.weixin.qq.com/c2c/restart-file",
                    },
                  },
                  type: 4,
                },
              ],
              message_id: 75,
            },
          ],
        }),
        { accepted: 1, sent: 1 },
      );
      const queued = firstState.peekQueuedTurn("thread-main");
      assert.ok(queued);
      const queuedInput = parseDurableTurnInput(queued.body);
      assert.equal(queuedInput.attachments.length, 1);
      storedPath = queuedInput.attachments[0]?.path ?? "";
      assert.ok(storedPath);
      assert.deepEqual(readFileSync(storedPath), plaintext);
      assert.equal(downloads, 1);
    } finally {
      firstBridge.close();
      firstLeases.close();
      firstState.close();
    }

    const recoveredState = new SqliteState(databasePath);
    const recoveredLeases = new SqliteTurnLeaseStore(databasePath);
    const recoveredMedia = new InboundMediaStore({
      async fetch() {
        downloads += 1;
        assert.fail("recovery must reuse the durable local file");
      },
      rootDirectory: mediaRoot,
    });
    const runtime = await CodexRuntime.create({
      bridgeInstanceId: "bridge-after-restart",
      command: [process.execPath, fakeCodexRuntime],
    });
    const sent: string[] = [];
    let appServerParams: unknown;
    const recoveredBridge = new BridgeEngine({
      bridgeInstanceId: "bridge-after-restart",
      codex: {
        async readThread() {
          return {
            thread: {
              status: { type: "idle" },
              turns: [
                {
                  id: "turn-new",
                  items: [
                    {
                      phase: "final_answer",
                      text: "附件恢复完成",
                      type: "agentMessage",
                    },
                  ],
                  status: "completed",
                },
              ],
            },
          };
        },
        async resumeThread(threadId) {
          return runtime.resumeThread(threadId);
        },
        async startTurn(input) {
          const result = await runtime.startTurn(input);
          appServerParams = (
            result as typeof result & { fixtureParams?: unknown }
          ).fixtureParams;
          return result;
        },
      },
      ilink: {
        async sendText(input) {
          sent.push(input.text);
          return { accepted: true, clientId: input.clientId };
        },
      },
      leases: recoveredLeases,
      mainThreadId: "thread-main",
      media: recoveredMedia,
      newId: () => "operation-after-restart",
      now: () => 20_000,
      session,
      state: recoveredState,
    });

    try {
      await recoveredMedia.prune(
        new Set(recoveredState.listActiveTurnDedupeKeys()),
      );
      assert.equal(existsSync(storedPath), true);

      await recoveredBridge.recoverPendingWork();

      assert.equal(downloads, 1);
      assert.equal(existsSync(storedPath), true);
      assert.deepEqual(appServerParams, {
        clientUserMessageId: dedupeKey,
        input: [
          {
            text: "读取重启后的附件",
            text_elements: [],
            type: "text",
          },
          {
            name: "restart-report.pdf",
            path: storedPath,
            type: "mention",
          },
        ],
        threadId: "thread-main",
      });

      assert.equal(
        await recoveredBridge.ingestCodexEvent({
          method: "turn/completed",
          params: {
            threadId: "thread-main",
            turn: { id: "turn-new", status: "completed" },
          },
        }),
        true,
      );
      assert.equal(existsSync(storedPath), false);
      assert.deepEqual(sent, ["附件恢复完成"]);
    } finally {
      recoveredBridge.close();
      runtime.close();
      recoveredLeases.close();
      recoveredState.close();
    }
  } finally {
    rmSync(directory, {
      force: true,
      maxRetries: 20,
      recursive: true,
      retryDelay: 25,
    });
  }
});

test("media download failures and raw voice return explicit errors without starting Codex", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-media-error-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: string[] = [];
  let downloads = 0;
  let starts = 0;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        starts += 1;
        return { turn: { id: "must-not-start" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    media: {
      async cleanup() {},
      async resolve() {
        downloads += 1;
        throw downloads === 1
          ? new InboundMediaError("TIMEOUT", "sanitized timeout", {
              retryable: true,
            })
          : new InboundMediaError(
              "REDIRECT_ERROR",
              "sanitized redirect failure",
            );
      },
    },
    newId: () => "unused",
    now: () => 9_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-errors",
        messages: [
          imageMessage(72, ""),
          imageMessage(74, ""),
          rawVoiceMessage(73),
        ],
      }),
      { accepted: 3, sent: 3 },
    );
    assert.equal(downloads, 2);
    assert.equal(starts, 0);
    assert.deepEqual(sent, [
      "❌ 微信附件下载失败（网络或 CDN 异常），请稍后重发。",
      "❌ 微信附件下载失败（网络或 CDN 异常），请稍后重发。",
      "❌ 这条语音没有微信转写文本；当前 Codex 任务不能直接接收音频，请开启语音转文字后重发。",
    ]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a definite immediate Codex media rejection is reported and does not block the next FIFO turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-media-rejected-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const cleaned: string[] = [];
  const sent: string[] = [];
  const started: string[] = [];
  let nextId = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        started.push(input.text);
        if (input.attachments?.length) {
          throw new Error("localImage input was rejected (code=-32602)");
        }
        return { turn: { id: "turn-after-rejection" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    media: {
      async cleanup(dedupeKey) {
        cleaned.push(dedupeKey);
      },
      async resolve() {
        return {
          byteLength: 10,
          displayName: "report.pdf",
          kind: "file" as const,
          path: "C:\\Codex_iLink\\media\\report.pdf",
          status: "stored" as const,
        };
      },
    },
    newId: () => `rejected-${String(nextId++)}`,
    now: () => 9_500,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-rejected-media",
        messages: [
          fileMessage(75, "读取被拒绝的附件"),
          textMessage(76, "后续消息仍应执行"),
        ],
      }),
      { accepted: 2, sent: 1 },
    );
    assert.deepEqual(started, ["读取被拒绝的附件", "后续消息仍应执行"]);
    assert.deepEqual(cleaned, ["bot-a/controller-a/75"]);
    assert.deepEqual(sent, [
      "❌ Codex 提交失败：本次输入已被明确拒绝，未创建任务。请检查附件或输入后重试；详情请在 Codex Desktop 查看。",
    ]);
    assert.equal(state.countQueuedTurns(), 0);
    assert.equal(state.countActiveDispatches(), 1);
    assert.equal(leases.getLease("thread-main")?.turnId, "turn-after-rejection");
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a definite rejection keeps its lease until the durable rejection commits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-rejection-order-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.rejectPendingDispatchWithOutbox = () => {
    throw new Error("simulated durable rejection failure");
  };
  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        throw new Error("turn/start was definitely rejected");
      },
    },
    ilink: {
      async sendText() {
        assert.fail("no reply can be sent before its outbox commit");
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "rejection-order-operation",
    now: () => 9_550,
    session,
    state,
  });

  try {
    await assert.rejects(
      bridge.ingestBatch({
        cursor: "cursor-rejection-order",
        messages: [textMessage(79, "触发确定性拒绝")],
      }),
      /simulated durable rejection failure/u,
    );
    assert.equal(state.countActiveDispatches(), 1);
    assert.equal(
      leases.getLease("thread-main")?.operationId,
      "rejection-order-operation",
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a definite queued Codex media rejection is reported and advances the FIFO", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-queued-media-rejected-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const cleaned: string[] = [];
  const sent: string[] = [];
  const started: string[] = [];
  let nextId = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.enqueueQueuedTurn({
    body: serializeDurableTurnInput({
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          path: "C:\\Codex_iLink\\media\\queued-report.pdf",
        },
      ],
      text: "读取队首附件",
      version: 1,
    }),
    contextToken: "ctx-queued-rejected",
    createdAtMs: 1,
    dedupeKey: "bot-a/controller-a/77",
    threadId: "thread-main",
  });
  state.enqueueQueuedTurn({
    body: turnBody("队列下一条继续执行"),
    contextToken: "ctx-queued-next",
    createdAtMs: 2,
    dedupeKey: "bot-a/controller-a/78",
    threadId: "thread-main",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        started.push(input.text);
        if (input.attachments?.length) {
          throw new Error("mention input was rejected (code=-32602)");
        }
        return { turn: { id: "turn-after-queued-rejection" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    media: {
      async cleanup(dedupeKey) {
        cleaned.push(dedupeKey);
      },
      async resolve() {
        assert.fail("durable queued media must not be downloaded again");
      },
    },
    newId: () => `queued-rejected-${String(nextId++)}`,
    now: () => 9_600,
    session,
    state,
  });

  try {
    await bridge.scheduleQueuedTurns();
    assert.deepEqual(started, ["读取队首附件", "队列下一条继续执行"]);
    assert.deepEqual(cleaned, ["bot-a/controller-a/77"]);
    assert.deepEqual(sent, [
      "❌ Codex 提交失败：本次输入已被明确拒绝，未创建任务。请检查附件或输入后重试；详情请在 Codex Desktop 查看。",
    ]);
    assert.equal(state.countQueuedTurns(), 0);
    assert.equal(state.countActiveDispatches(), 1);
    assert.equal(
      leases.getLease("thread-main")?.turnId,
      "turn-after-queued-rejection",
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("slash commands ignore attached media instead of downloading it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-media-command-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  let downloads = 0;
  const sent: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  const bridge = new BridgeEngine({
    ilink: {
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true, clientId: input.clientId };
      },
    },
    media: {
      async cleanup() {},
      async resolve() {
        downloads += 1;
        assert.fail("command media must not be downloaded");
      },
    },
    newId: () => "command-reply",
    now: () => 10_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-command-media",
        messages: [imageMessage(74, "/help")],
      }),
      { accepted: 1, sent: 1 },
    );
    assert.equal(downloads, 0);
    assert.deepEqual(sent, [COMMAND_HELP]);
  } finally {
    bridge.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a Desktop observation queues a later /s n dispatch until exact Stop and terminal proof", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-observed-dispatch-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  const started: string[] = [];
  let desktopTerminal = false;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.observeDesktopTurn({
    createdAtMs: 1,
    threadId: "thread-shared",
    turnId: "desktop-turn",
  });
  state.setBindingForNavigation({
    expiresAtMs: 60_000,
    projectPath: "D:\\Project",
    threadId: "thread-shared",
    updatedAtMs: 2,
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async ensureThread() {},
      async readThread() {
        return {
          thread: {
            status: desktopTerminal ? { type: "idle" } : { type: "active" },
            turns: [
              {
                id: "desktop-turn",
                status: desktopTerminal ? "completed" : "inProgress",
              },
            ],
          },
        };
      },
      async startTurn(input) {
        started.push(input.text);
        return { turn: { id: "bridge-turn" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "bridge-operation",
    now: () => 10_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-observed",
        messages: [textMessage(12, "wait for Desktop")],
      }),
      { accepted: 1, sent: 1 },
    );
    assert.deepEqual(started, []);
    assert.match(sent[0]?.text ?? "", /^Queued #/u);

    assert.equal(
      state.markDesktopTurnObservationStopped({
        stoppedAtMs: 11_000,
        threadId: "thread-shared",
        turnId: "desktop-turn",
      }),
      true,
    );
    desktopTerminal = true;
    await bridge.reconcilePendingWork();

    assert.deepEqual(started, ["wait for Desktop"]);
    assert.equal(state.getDesktopTurnObservation("thread-shared"), null);
    assert.equal(state.countQueuedTurns(), 0);
    assert.equal(state.getDispatchIntent("bridge-operation")?.status, "accepted");
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a returned turn id is retained when the Bridge cannot claim its exact lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-guard-unknown-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new RefusingClaimTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        return { turn: { id: "turn-guard-unknown" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "guard-unknown-operation",
    now: () => 2_100,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-guard-unknown",
      messages: [textMessage(11, "guard outcome")],
    });
    assert.deepEqual(
      {
        status: state.getDispatchIntent("guard-unknown-operation")?.status,
        turnId: state.getDispatchIntent("guard-unknown-operation")?.turnId,
      },
      { status: "unknown", turnId: "turn-guard-unknown" },
    );
    await bridge.recoverPendingWork();
    assert.deepEqual(sent.map(({ clientId }) => clientId), [
      "codex-ilink:guard-unknown-operation:unknown",
    ]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("startup turns a pending dispatch unknown and persists one stable diagnostic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-pending-unknown-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: "crashed while submitting",
        contextToken: "ctx-pending-unknown",
        messageId: "pending-unknown-message",
        receivedAtMs: 10,
      },
    ],
    nextCursor: "cursor-pending-unknown",
    updatedAtMs: 11,
  });
  state.createDispatchIntent({
    body: "crashed while submitting",
    contextToken: "ctx-pending-unknown",
    createdAtMs: 12,
    dedupeKey: "bot-a/controller-a/pending-unknown-message",
    operationId: "pending-unknown-operation",
    threadId: "thread-pending-unknown",
  });
  leases.tryAcquire({
    createdAtMs: 12,
    instanceId: "old-instance",
    operationId: "pending-unknown-operation",
    owner: "bridge",
    threadId: "thread-pending-unknown",
    turnId: null,
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            id: "thread-pending-unknown",
            status: { type: "active" },
            turns: [],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("unknown startup work must never be retried");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "must-not-be-used-for-unknown",
    now: () => 100,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    await bridge.recoverPendingWork();
    assert.equal(state.getDispatchIntent("pending-unknown-operation")?.status, "unknown");
    assert.equal(state.listInboundMessages()[0]?.body, null);
    assert.deepEqual(
      sent.map(({ clientId, contextToken }) => ({ clientId, contextToken })),
      [
        {
          clientId: "codex-ilink:pending-unknown-operation:unknown",
          contextToken: "ctx-pending-unknown",
        },
      ],
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("startup preserves unknown inbound text until a diagnostic context exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-unknown-no-context-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: turnBody("keep until diagnosis is durable"),
        contextToken: "",
        messageId: "unknown-no-context",
        receivedAtMs: 10,
      },
    ],
    nextCursor: "cursor-no-context",
    updatedAtMs: 11,
  });
  state.createDispatchIntent({
    body: turnBody("keep until diagnosis is durable"),
    contextToken: "",
    createdAtMs: 12,
    dedupeKey: "bot-a/controller-a/unknown-no-context",
    operationId: "unknown-no-context-operation",
    threadId: "thread-unknown-no-context",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return { thread: { status: { type: "idle" }, turns: [] } };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("unknown work must not be retried");
      },
    },
    ilink: { async sendText() { assert.fail("there is no diagnostic context"); } },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused",
    now: () => 100,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    await bridge.recoverPendingWork();
    assert.equal(
      state.listInboundMessages()[0]?.body,
      turnBody("keep until diagnosis is durable"),
    );
    assert.equal(
      state.getOutbox("codex-ilink:unknown-no-context-operation:unknown"),
      null,
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an immediate Codex start uncertainty uses the operation diagnostic id once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-start-unknown-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return { thread: { status: { type: "active" }, turns: [] } };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        throw new CodexOutcomeUnknownError("turn/start", "timeout");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "start-unknown-operation",
    now: () => 2_200,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-start-unknown",
      messages: [textMessage(12, "uncertain start")],
    });
    await bridge.recoverPendingWork();
    assert.equal(state.getDispatchIntent("start-unknown-operation")?.status, "unknown");
    assert.equal(state.listInboundMessages()[0]?.body, null);
    assert.deepEqual(sent.map(({ clientId }) => clientId), [
      "codex-ilink:start-unknown-operation:unknown",
    ]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a completed WeChat turn replies once without relying on Hook lease claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-bridge-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  const resumed: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        resumed.push(threadId);
        return { thread: { id: threadId } };
      },
      async readThread() {
        return {
          thread: {
            id: "thread-main",
            turns: [
              {
                id: "turn-20",
                items: [
                  {
                    content: [{ text: "原问题", type: "input_text" }],
                    id: "u1",
                    type: "userMessage",
                  },
                  {
                    id: "a1",
                    phase: "final_answer",
                    text: "最终完成结果",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async startTurn() {
        return { turn: { id: "turn-20" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "dispatch-20",
    now: () => 3_000,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-20",
      messages: [textMessage(20, "处理并给我结果")],
    });
    state.acceptInboundBatch({
      accountId: "bot-a",
      controllerUserId: "controller-a",
      messages: [
        {
          body: "later message",
          contextToken: "ctx-later",
          messageId: "later",
          receivedAtMs: 20,
        },
      ],
      nextCursor: "cursor-later",
      updatedAtMs: 3_001,
    });
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: "turn-20" } },
      }),
      true,
    );
    assert.deepEqual(resumed, ["thread-main"]);
    assert.deepEqual(
      sent.map(({ clientId, contextToken, text }) => ({
        clientId,
        contextToken,
        text,
      })),
      [
        {
          clientId: "codex-ilink:turn-20:final",
          contextToken: "ctx-20",
          text: "最终完成结果",
        },
      ],
    );
    assert.equal(
      leases.tryAcquire({
        createdAtMs: 3_001,
        instanceId: "desktop",
        operationId: "desktop-next",
        owner: "desktop",
        threadId: "thread-main",
        turnId: "desktop-next",
      }).acquired,
      true,
    );

    await bridge.ingestCodexEvent({
      method: "turn/completed",
      params: { threadId: "thread-main", turn: { id: "turn-20" } },
    });
    assert.equal(sent.length, 1);
  } finally {
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an upstream HTTP failure is reported instead of looking like a normal completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-network-error-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        throw new Error("thread/read is temporarily unavailable");
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        return { turn: { id: "turn-http-403" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "dispatch-http-403",
    now: () => 3_500,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-http-403",
      messages: [textMessage(21, "测试网络错误")],
    });
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "error",
        params: {
          error: {
            codexErrorInfo: {
              responseTooManyFailedAttempts: { httpStatusCode: 503 },
            },
            message: "temporary retryable failure",
          },
          threadId: "thread-main",
          turnId: "turn-http-403",
          willRetry: true,
        },
      }),
      false,
    );
    const finalError = bridge.ingestCodexEvent({
      method: "error",
      params: {
        error: {
          additionalDetails: "secret-cloudflare-body",
          codexErrorInfo: {
            responseTooManyFailedAttempts: { httpStatusCode: 403 },
          },
          message: "unexpected status 403 Forbidden secret-upstream-detail",
        },
        threadId: "thread-main",
        turnId: "turn-http-403",
        willRetry: false,
      },
    });
    const completion = bridge.ingestCodexEvent({
      method: "turn/completed",
      params: {
        threadId: "thread-main",
        turn: { error: null, id: "turn-http-403", status: "failed" },
      },
    });
    assert.deepEqual(await Promise.all([finalError, completion]), [true, true]);
    assert.deepEqual(
      sent.map(({ clientId, text }) => ({ clientId, text })),
      [
        {
          clientId: "codex-ilink:turn-http-403:final",
          text: "❌ Codex 网络请求失败：上游服务拒绝访问（HTTP 403）。请稍后重试。",
        },
      ],
    );
    assert.doesNotMatch(sent[0]?.text ?? "", /任务已结束/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /secret/u);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("startup reconciliation preserves a sanitized network failure over a partial reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-recovered-network-error-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "recover failed request",
    contextToken: "ctx-recovered-error",
    createdAtMs: 100,
    dedupeKey: "recovered-error-message",
    operationId: "recovered-error-operation",
    threadId: "thread-recovered-error",
  });
  state.markDispatchAccepted(
    "recovered-error-operation",
    "turn-recovered-error",
    101,
  );
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "old-instance",
    operationId: "recovered-error-operation",
    owner: "bridge",
    threadId: "thread-recovered-error",
    turnId: "turn-recovered-error",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            id: "thread-recovered-error",
            status: { type: "idle" },
            turns: [
              {
                error: {
                  additionalDetails: "secret-provider-html",
                  codexErrorInfo: {
                    responseStreamConnectionFailed: { httpStatusCode: 502 },
                  },
                  message: "secret provider response",
                },
                id: "turn-recovered-error",
                items: [
                  {
                    id: "partial-recovered-answer",
                    phase: "commentary",
                    text: "partial answer must not hide a terminal failure",
                    type: "agentMessage",
                  },
                ],
                status: "failed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("terminal reconciliation must not start another copy");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 200,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    assert.equal(leases.getLease("thread-recovered-error"), null);
    assert.deepEqual(sent.map(({ text }) => text), [
      "❌ Codex 网络请求失败（HTTP 502）。请稍后重试。",
    ]);
    assert.doesNotMatch(sent[0]?.text ?? "", /secret|partial answer/u);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("startup reconciliation reports an interrupted turn without forwarding commentary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-interrupted-turn-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "continue",
    contextToken: "ctx-interrupted",
    createdAtMs: 100,
    dedupeKey: "interrupted-message",
    operationId: "interrupted-operation",
    threadId: "thread-interrupted",
  });
  state.markDispatchAccepted("interrupted-operation", "turn-interrupted", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "old-instance",
    operationId: "interrupted-operation",
    owner: "bridge",
    threadId: "thread-interrupted",
    turnId: "turn-interrupted",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            id: "thread-interrupted",
            status: { type: "idle" },
            turns: [
              {
                error: null,
                id: "turn-interrupted",
                items: [
                  {
                    phase: "commentary",
                    text: "继续查看桌面，只读取文件名，不打开或修改。",
                    type: "agentMessage",
                  },
                ],
                status: "interrupted",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("terminal reconciliation must not start another copy");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 200,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    assert.equal(leases.getLease("thread-interrupted"), null);
    assert.deepEqual(sent.map(({ text }) => text), [
      "❌ Codex 任务已中断，未生成最终结果。请重试；详情请在 Codex Desktop 查看。",
    ]);
    assert.doesNotMatch(sent[0]?.text ?? "", /继续查看桌面/u);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a long-running turn sends one durable progress notice without releasing its lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-slow-turn-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "long task",
    contextToken: "ctx-slow",
    createdAtMs: 100,
    dedupeKey: "slow-message",
    operationId: "slow-operation",
    threadId: "thread-slow",
  });
  state.markDispatchAccepted("slow-operation", "turn-slow", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "bridge-instance",
    operationId: "slow-operation",
    owner: "bridge",
    threadId: "thread-slow",
    turnId: "turn-slow",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            id: "thread-slow",
            status: { type: "active" },
            turns: [{ id: "turn-slow", status: "inProgress" }],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("an active turn must not be restarted");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 250,
    session,
    slowTurnNoticeAfterMs: 100,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    await bridge.reconcilePendingWork();

    assert.deepEqual(sent.map(({ clientId, text }) => ({ clientId, text })), [
      {
        clientId: "codex-ilink:turn-slow:slow",
        text: "⏳ Codex 任务仍在执行，已长时间没有结束；可能正在等待工具、审批或网络。任务未被取消，可用 /st 查看。",
      },
    ]);
    assert.equal(leases.getLease("thread-slow")?.turnId, "turn-slow");
    assert.equal(state.getDispatchIntent("slow-operation")?.completedAtMs, null);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a terminal WeChat turn without an agent reply reports an explicit error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-empty-reply-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            id: "thread-main",
            status: { type: "idle" },
            turns: [
              {
                id: "turn-empty-reply",
                items: [
                  {
                    content: [{ text: "不要静默结束", type: "input_text" }],
                    id: "user-empty-reply",
                    type: "userMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        return { turn: { id: "turn-empty-reply" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "dispatch-empty-reply",
    now: () => 3_600,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-empty-reply",
      messages: [textMessage(22, "不要静默结束")],
    });
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: "turn-empty-reply" } },
      }),
      true,
    );
    assert.deepEqual(sent.map(({ text }) => text), [
      "❌ Codex 未生成回复，可能发生网络或系统错误。请稍后重试；详情请在 Codex Desktop 查看。",
    ]);
    assert.doesNotMatch(sent[0]?.text ?? "", /任务已结束/u);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("startup reconciliation releases an old-instance accepted terminal turn and sends its final reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-old-instance-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "finish across restart",
    contextToken: "ctx-old-instance",
    createdAtMs: 100,
    dedupeKey: "old-instance-message",
    operationId: "old-instance-operation",
    threadId: "thread-old-instance",
  });
  state.markDispatchAccepted("old-instance-operation", "turn-old-instance", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "old-instance",
    operationId: "old-instance-operation",
    owner: "bridge",
    threadId: "thread-old-instance",
    turnId: "turn-old-instance",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            id: "thread-old-instance",
            status: { type: "idle" },
            turns: [
              {
                id: "turn-old-instance",
                items: [
                  {
                    id: "answer",
                    phase: "final_answer",
                    text: "recovered final",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("terminal reconciliation must not start another copy");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 200,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    assert.equal(leases.getLease("thread-old-instance"), null);
    assert.equal(
      state.getDispatchIntent("old-instance-operation")?.completedAtMs,
      200,
    );
    assert.deepEqual(sent.map(({ contextToken, text }) => ({ contextToken, text })), [
      { contextToken: "ctx-old-instance", text: "recovered final" },
    ]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a failed exact lease release cannot mark completion, reply, or continue the queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-release-failure-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new RefusingReleaseTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  const started: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "must remain incomplete",
    contextToken: "ctx-release-failure",
    createdAtMs: 100,
    dedupeKey: "release-failure",
    operationId: "release-failure-operation",
    threadId: "thread-release-failure",
  });
  state.markDispatchAccepted("release-failure-operation", "turn-release-failure", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "bridge-instance",
    operationId: "release-failure-operation",
    owner: "bridge",
    threadId: "thread-release-failure",
    turnId: "turn-release-failure",
  });
  state.enqueueQueuedTurn({
    body: turnBody("must stay queued"),
    contextToken: "ctx-queued",
    createdAtMs: 102,
    dedupeKey: "release-failure-queued",
    threadId: "thread-release-failure",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            turns: [
              {
                id: "turn-release-failure",
                items: [
                  {
                    id: "answer",
                    phase: "final_answer",
                    text: "must not send",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        started.push(input.text);
        return { turn: { id: "must-not-start" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 200,
    session,
    state,
  });

  try {
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "thread-release-failure",
          turn: { id: "turn-release-failure" },
        },
      }),
      false,
    );
    assert.equal(
      state.getDispatchIntent("release-failure-operation")?.completedAtMs,
      null,
    );
    assert.deepEqual(sent, []);
    assert.deepEqual(started, []);
    assert.equal(
      state.peekQueuedTurn("thread-release-failure")?.body,
      turnBody("must stay queued"),
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a terminal turn without a reply context stays incomplete and keeps its queue blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-final-no-context-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "finish without context",
    contextToken: "",
    createdAtMs: 100,
    dedupeKey: "final-no-context",
    operationId: "final-no-context-operation",
    threadId: "thread-final-no-context",
  });
  state.markDispatchAccepted(
    "final-no-context-operation",
    "turn-final-no-context",
    101,
  );
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "bridge-instance",
    operationId: "final-no-context-operation",
    owner: "bridge",
    threadId: "thread-final-no-context",
    turnId: "turn-final-no-context",
  });
  state.enqueueQueuedTurn({
    body: turnBody("wait for durable final"),
    contextToken: "ctx-queued",
    createdAtMs: 102,
    dedupeKey: "final-no-context-queued",
    threadId: "thread-final-no-context",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            status: { type: "idle" },
            turns: [
              {
                id: "turn-final-no-context",
                items: [
                  {
                    phase: "final_answer",
                    text: "final result",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) { return { thread: { id: threadId } }; },
      async startTurn() { assert.fail("the queue must remain blocked"); },
    },
    ilink: { async sendText() { assert.fail("there is no context token"); } },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused",
    now: () => 200,
    session,
    state,
  });

  try {
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "thread-final-no-context",
          turn: { id: "turn-final-no-context" },
        },
      }),
      false,
    );
    assert.equal(leases.getLease("thread-final-no-context"), null);
    assert.equal(
      state.getDispatchIntent("final-no-context-operation")?.completedAtMs,
      null,
    );
    assert.equal(state.listPendingOutbox().length, 0);
    assert.equal(
      state.peekQueuedTurn("thread-final-no-context")?.body,
      turnBody("wait for durable final"),
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a final outbox collision rolls back completion and does not continue the queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-final-atomic-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  const started: string[] = [];
  const finalText = "汉".repeat(1_000);
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "produce final",
    contextToken: "ctx-final-atomic",
    createdAtMs: 100,
    dedupeKey: "final-atomic",
    operationId: "final-atomic-operation",
    threadId: "thread-final-atomic",
  });
  state.markDispatchAccepted("final-atomic-operation", "turn-final-atomic", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "bridge-instance",
    operationId: "final-atomic-operation",
    owner: "bridge",
    threadId: "thread-final-atomic",
    turnId: "turn-final-atomic",
  });
  state.enqueueOutbox({
    body: "collision",
    clientId: "codex-ilink:turn-final-atomic:final:part:2",
    contextToken: "ctx-final-atomic",
    createdAtMs: 102,
    targetUserId: "controller-a",
  });
  state.enqueueQueuedTurn({
    body: turnBody("must stay queued"),
    contextToken: "ctx-next",
    createdAtMs: 103,
    dedupeKey: "final-atomic-next",
    threadId: "thread-final-atomic",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            status: { type: "idle" },
            turns: [
              {
                id: "turn-final-atomic",
                items: [
                  {
                    phase: "final_answer",
                    text: finalText,
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        started.push(input.text);
        return { turn: { id: "must-not-start" } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 200,
    session,
    state,
  });

  try {
    await assert.rejects(
      bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "thread-final-atomic",
          turn: { id: "turn-final-atomic" },
        },
      }),
      /client id collision/u,
    );
    assert.equal(state.getDispatchIntent("final-atomic-operation")?.completedAtMs, null);
    assert.equal(state.getOutbox("codex-ilink:turn-final-atomic:final:part:1"), null);
    assert.deepEqual(sent, []);
    assert.deepEqual(started, []);
    assert.equal(
      state.peekQueuedTurn("thread-final-atomic")?.body,
      turnBody("must stay queued"),
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a crash after completion persistence replays the final reply from outbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-final-replay-"));
  const databasePath = join(directory, "state.sqlite");
  let state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let leasesClosed = false;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "persist before send",
    contextToken: "ctx-final-replay",
    createdAtMs: 100,
    dedupeKey: "final-replay",
    operationId: "final-replay-operation",
    threadId: "thread-final-replay",
  });
  state.markDispatchAccepted("final-replay-operation", "turn-final-replay", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "bridge-instance",
    operationId: "final-replay-operation",
    owner: "bridge",
    threadId: "thread-final-replay",
    turnId: "turn-final-replay",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            turns: [
              {
                id: "turn-final-replay",
                items: [
                  {
                    phase: "final_answer",
                    text: "durable final",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        assert.fail("completion recovery must not start a turn");
      },
    },
    ilink: {
      async sendText() {
        throw new Error("process crashed before delivery");
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "unused-operation",
    now: () => 200,
    session,
    state,
  });

  try {
    await assert.rejects(
      bridge.ingestCodexEvent({
        method: "turn/completed",
        params: {
          threadId: "thread-final-replay",
          turn: { id: "turn-final-replay" },
        },
      }),
      /process crashed/u,
    );
    assert.equal(
      state.getDispatchIntent("final-replay-operation")?.completedAtMs,
      200,
    );
    assert.equal(state.listPendingOutbox().length, 1);

    bridge.close();
    leases.close();
    leasesClosed = true;
    state.close();
    state = new SqliteState(databasePath);
    const replayed: SendInput[] = [];
    const worker = new OutboxWorker({
      ilink: {
        async sendText(input) {
          replayed.push(input);
          return { accepted: true, clientId: input.clientId };
        },
      },
      now: () => 300,
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 1,
      deferred: 0,
      failed: 0,
    });
    assert.deepEqual(
      replayed.map(({ clientId, contextToken, text }) => ({
        clientId,
        contextToken,
        text,
      })),
      [
        {
          clientId: "codex-ilink:turn-final-replay:final",
          contextToken: "ctx-final-replay",
          text: "durable final",
        },
      ],
    );
  } finally {
    bridge.close();
    if (!leasesClosed) leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("unknown terminal and explicitly idle leases resolve without retrying and unblock their FIFO queues", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-unknown-recovery-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: Array<{ text: string; threadId: string }> = [];
  let nextOperation = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  state.createDispatchIntent({
    body: "possibly accepted terminal",
    contextToken: "ctx-unknown-terminal",
    createdAtMs: 100,
    dedupeKey: "unknown-terminal",
    operationId: "unknown-terminal-operation",
    threadId: "thread-unknown-terminal",
  });
  state.markDispatchUnknown("unknown-terminal-operation", 101);
  leases.tryAcquire({
    createdAtMs: 100,
    instanceId: "old-instance",
    operationId: "unknown-terminal-operation",
    owner: "bridge",
    threadId: "thread-unknown-terminal",
    turnId: "turn-unknown-terminal",
  });
  state.enqueueQueuedTurn({
    body: turnBody("after terminal"),
    contextToken: "ctx-after-terminal",
    createdAtMs: 102,
    dedupeKey: "after-terminal",
    threadId: "thread-unknown-terminal",
  });

  state.createDispatchIntent({
    body: "possibly accepted without turn id",
    contextToken: "ctx-unknown-idle",
    createdAtMs: 103,
    dedupeKey: "unknown-idle",
    operationId: "unknown-idle-operation",
    threadId: "thread-unknown-idle",
  });
  state.markDispatchUnknown("unknown-idle-operation", 104);
  leases.tryAcquire({
    createdAtMs: 103,
    instanceId: "old-instance",
    operationId: "unknown-idle-operation",
    owner: "bridge",
    threadId: "thread-unknown-idle",
    turnId: null,
  });
  state.enqueueQueuedTurn({
    body: turnBody("after idle"),
    contextToken: "ctx-after-idle",
    createdAtMs: 105,
    dedupeKey: "after-idle",
    threadId: "thread-unknown-idle",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread({ threadId }) {
        return threadId === "thread-unknown-terminal"
          ? {
              thread: {
                id: threadId,
                status: { type: "idle" },
                turns: [{ id: "turn-unknown-terminal", status: "completed" }],
              },
            }
          : { thread: { id: threadId, status: { type: "idle" }, turns: [] } };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        const turnId = `recovered-turn-${String(started.length + 1)}`;
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "new-instance",
            threadId: input.threadId,
            turnId,
          }),
          true,
        );
        started.push({ text: input.text, threadId: input.threadId });
        return { turn: { id: turnId } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => `recovered-operation-${String(nextOperation++)}`,
    now: () => 500,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    assert.deepEqual(started, [
      { text: "after terminal", threadId: "thread-unknown-terminal" },
      { text: "after idle", threadId: "thread-unknown-idle" },
    ]);
    assert.equal(
      state.getDispatchIntent("unknown-terminal-operation")?.completedAtMs,
      500,
    );
    assert.equal(
      state.getDispatchIntent("unknown-idle-operation")?.completedAtMs,
      500,
    );
    assert.equal(leases.getLease("thread-unknown-terminal")?.instanceId, "new-instance");
    assert.equal(leases.getLease("thread-unknown-idle")?.instanceId, "new-instance");
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an orphaned unknown intent resolves only when the public thread status is explicitly idle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-orphan-unknown-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.createDispatchIntent({
    body: "unknown before exact release",
    contextToken: "ctx-orphan-unknown",
    createdAtMs: 100,
    dedupeKey: "orphan-unknown",
    operationId: "orphan-unknown-operation",
    threadId: "thread-orphan-unknown",
  });
  state.markDispatchUnknown("orphan-unknown-operation", 101);
  state.enqueueQueuedTurn({
    body: turnBody("continue after orphan"),
    contextToken: "ctx-after-orphan",
    createdAtMs: 102,
    dedupeKey: "after-orphan",
    threadId: "thread-orphan-unknown",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread({ threadId }) {
        return { thread: { id: threadId, status: { type: "idle" }, turns: [] } };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "new-instance",
            threadId: input.threadId,
            turnId: "turn-after-orphan",
          }),
          true,
        );
        started.push(input.text);
        return { turn: { id: "turn-after-orphan" } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "operation-after-orphan",
    now: () => 500,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    assert.equal(
      state.getDispatchIntent("orphan-unknown-operation")?.completedAtMs,
      500,
    );
    assert.deepEqual(started, ["continue after orphan"]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an idle orphaned pre-dispatch lease releases before its durable inbound message is recovered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-orphan-lease-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.acceptInboundBatch({
    accountId: "bot-a",
    controllerUserId: "controller-a",
    messages: [
      {
        body: turnBody("recover before intent"),
        contextToken: "ctx-orphan-lease",
        messageId: "orphan-lease-message",
        receivedAtMs: 1,
      },
    ],
    nextCursor: "cursor-orphan-lease",
    updatedAtMs: 2,
  });
  leases.tryAcquire({
    createdAtMs: 2,
    instanceId: "old-instance",
    operationId: "orphan-lease-operation",
    owner: "bridge",
    threadId: "thread-main",
    turnId: null,
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread({ threadId }) {
        return { thread: { id: threadId, status: { type: "idle" }, turns: [] } };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "new-instance",
            threadId: input.threadId,
            turnId: "turn-recovered-inbound",
          }),
          true,
        );
        started.push(input.text);
        return { turn: { id: "turn-recovered-inbound" } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "recovered-inbound-operation",
    now: () => 10,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    assert.deepEqual(started, ["recover before intent"]);
    assert.equal(state.listInboundMessages()[0]?.body, null);
    assert.equal(leases.getLease("thread-main")?.instanceId, "new-instance");
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("active unknown turns retain their exact leases and consume the global three-turn limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-unknown-cap-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let nextId = 1;
  let startCalls = 0;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  for (let index = 1; index <= 3; index += 1) {
    const threadId = `thread-unknown-${String(index)}`;
    const operationId = `unknown-operation-${String(index)}`;
    const turnId = `unknown-turn-${String(index)}`;
    state.createDispatchIntent({
      body: `unknown ${String(index)}`,
      contextToken: `ctx-unknown-${String(index)}`,
      createdAtMs: 100 + index,
      dedupeKey: `unknown-${String(index)}`,
      operationId,
      threadId,
    });
    state.markDispatchUnknown(operationId, 110 + index, turnId);
    leases.tryAcquire({
      createdAtMs: 100 + index,
      instanceId: "old-instance",
      operationId,
      owner: "bridge",
      threadId,
      turnId,
    });
  }
  state.setBinding({
    expiresAtMs: 10_000,
    projectPath: null,
    threadId: "thread-four",
    updatedAtMs: 100,
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "new-instance",
    codex: {
      async readThread({ threadId }) {
        const turnId = `unknown-turn-${threadId.slice("thread-unknown-".length)}`;
        return {
          thread: {
            id: threadId,
            status: { type: "active" },
            turns: [{ id: turnId, status: "inProgress" }],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn() {
        startCalls += 1;
        return { turn: { id: "must-not-start" } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => `unknown-cap-${String(nextId++)}`,
    now: () => 200,
    session,
    state,
  });

  try {
    await bridge.recoverPendingWork();
    await bridge.ingestBatch({
      cursor: "cursor-unknown-cap",
      messages: [textMessage(64, "fourth request")],
    });
    assert.equal(startCalls, 0);
    assert.equal(state.countActiveDispatches(), 3);
    assert.equal(
      state.peekQueuedTurn("thread-four")?.body,
      turnBody("fourth request"),
    );
    assert.equal(leases.listLeases().length, 3);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an oversized final reply is durably capped at three safe WeChat messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-final-output-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  const pendingCounts: number[] = [];
  const finalText = "汉".repeat(3_000);
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            turns: [
              {
                id: "turn-long",
                items: [
                  {
                    phase: "final_answer",
                    text: finalText,
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        leases.claimBridgeTurn({
          instanceId: "bridge-instance",
          threadId: input.threadId,
          turnId: "turn-long",
        });
        return { turn: { id: "turn-long" } };
      },
    },
    ilink: {
      async sendText(input) {
        pendingCounts.push(state.listPendingOutbox().length);
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "dispatch-long",
    now: () => 3_000,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-long",
      messages: [textMessage(21, "给我一份很长的最终结果")],
    });
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: "turn-long" } },
      }),
      true,
    );

    assert.deepEqual(
      sent.map(({ clientId }) => clientId),
      [
        "codex-ilink:turn-long:final:part:1",
        "codex-ilink:turn-long:final:part:2",
        "codex-ilink:turn-long:final:part:3",
      ],
    );
    assert.deepEqual(pendingCounts, [3, 2, 1]);
    assert.ok(sent.every(({ text }) => Buffer.byteLength(text, "utf8") <= 2_000));
    assert.match(sent[2]?.text ?? "", /内容已截断.*Codex Desktop/u);
    assert.ok(sent.every(({ text }) => !text.includes("\uFFFD")));
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a standalone local file link is delivered as WeChat media instead of fake text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-final-media-"));
  const databasePath = join(directory, "state.sqlite");
  const filePath = join(directory, "到账凭证.png");
  writeFileSync(filePath, "fake-image");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const order: string[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            turns: [
              {
                id: "turn-media",
                items: [
                  {
                    phase: "final_answer",
                    text: `已发给你。\n[到账凭证.png](<${filePath}>)`,
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        leases.claimBridgeTurn({
          instanceId: "bridge-instance",
          threadId: input.threadId,
          turnId: "turn-media",
        });
        return { turn: { id: "turn-media" } };
      },
    },
    ilink: {
      async prepareMedia(input) {
        assert.equal(input.media.path, filePath);
        assert.equal(input.media.kind, "image");
        return {
          aesKeyBase64: "YWVzLWtleQ==",
          ciphertextSize: 16,
          encryptedQueryParam: "download-param",
          kind: input.media.kind,
          name: input.media.name,
          plaintextSize: 10,
          type: "prepared-media",
          v: 1,
        };
      },
      async sendMedia(input) {
        order.push(`media:${input.media.name}`);
        return { accepted: true, clientId: input.clientId };
      },
      async sendText(input) {
        order.push(`text:${input.text}`);
        assert.doesNotMatch(input.text, /[A-Za-z]:\\/u);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "dispatch-media",
    now: () => 3_000,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-media",
      messages: [textMessage(221, "把图片发给我")],
    });
    assert.equal(
      state.getDispatchIntentByTurnId("turn-media")?.status,
      "accepted",
    );
    assert.equal(leases.getLease("thread-main")?.turnId, "turn-media");
    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: "turn-media" } },
      }),
      true,
    );
    assert.deepEqual(order, ["media:到账凭证.png", "text:已发给你。"]);
    assert.equal(state.listPendingOutbox().length, 0);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Bridge self-claims immediate and promoted turns and sends FIFO replies without Hook events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-fifo-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: Array<Record<string, unknown>> = [];
  const sent: SendInput[] = [];
  let nextOperation = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async readThread() {
        return {
          thread: {
            turns: [
              {
                id: "turn-1",
                items: [
                  {
                    id: "answer-1",
                    phase: "final_answer",
                    text: "first done",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
              {
                id: "turn-2",
                items: [
                  {
                    id: "answer-2",
                    phase: "final_answer",
                    text: "second done",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
            ],
          },
        };
      },
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        const turnId = `turn-${String(started.length + 1)}`;
        started.push(input);
        return { turn: { id: turnId } };
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => `operation-${String(nextOperation++)}`,
    now: () => 4_000,
    session,
    state,
  });

  try {
    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-fifo-1",
        messages: [textMessage(41, "first")],
      }),
      { accepted: 1, sent: 0 },
    );
    assert.equal(leases.getLease("thread-main")?.owner, "bridge");
    assert.equal(leases.getLease("thread-main")?.instanceId, "bridge-instance");
    assert.equal(leases.getLease("thread-main")?.turnId, "turn-1");
    assert.equal(state.getDispatchIntentByTurnId("turn-1")?.status, "accepted");

    assert.deepEqual(
      await bridge.ingestBatch({
        cursor: "cursor-fifo-2",
        messages: [textMessage(42, "second")],
      }),
      { accepted: 1, sent: 1 },
    );
    assert.deepEqual(started.map(({ text }) => text), ["first"]);
    assert.equal(state.countQueuedTurns(), 1);
    assert.equal(sent[0]?.contextToken, "ctx-42");
    assert.match(sent[0]?.text ?? "", /^Queued #\d+$/u);

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: "turn-1" } },
      }),
      true,
    );

    assert.deepEqual(started.map(({ text }) => text), ["first", "second"]);
    assert.equal(state.countQueuedTurns(), 0);
    assert.equal(leases.getLease("thread-main")?.owner, "bridge");
    assert.equal(leases.getLease("thread-main")?.turnId, "turn-2");
    assert.equal(
      state.getDispatchIntentByTurnId("turn-2")?.contextToken,
      "ctx-42",
    );
    assert.equal(state.getDispatchIntentByTurnId("turn-2")?.status, "accepted");
    const firstFinal = sent.find(
      ({ clientId }) => clientId === "codex-ilink:turn-1:final",
    );
    assert.deepEqual(
      firstFinal && {
        clientId: firstFinal.clientId,
        contextToken: firstFinal.contextToken,
        text: firstFinal.text,
      },
      {
        clientId: "codex-ilink:turn-1:final",
        contextToken: "ctx-41",
        text: "first done",
      },
    );

    assert.equal(
      await bridge.ingestCodexEvent({
        method: "turn/completed",
        params: { threadId: "thread-main", turn: { id: "turn-2" } },
      }),
      true,
    );
    assert.equal(leases.getLease("thread-main"), null);
    assert.equal(state.countActiveDispatches(), 0);
    assert.deepEqual(
      sent
        .filter(({ clientId }) => clientId.endsWith(":final"))
        .map(({ clientId, contextToken, text }) => ({
          clientId,
          contextToken,
          text,
        })),
      [
        {
          clientId: "codex-ilink:turn-1:final",
          contextToken: "ctx-41",
          text: "first done",
        },
        {
          clientId: "codex-ilink:turn-2:final",
          contextToken: "ctx-42",
          text: "second done",
        },
      ],
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Bridge starts at most three turns across different shared threads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-cap-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const startedThreads: string[] = [];
  let nextOperation = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        return { thread: { id: threadId } };
      },
      async startTurn(input) {
        const turnId = `turn-${input.threadId}`;
        assert.equal(
          leases.claimBridgeTurn({
            instanceId: "bridge-instance",
            threadId: input.threadId,
            turnId,
          }),
          true,
        );
        startedThreads.push(input.threadId);
        return { turn: { id: turnId } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => `cap-operation-${String(nextOperation++)}`,
    now: () => 5_000,
    session,
    state,
  });

  try {
    for (let index = 1; index <= 4; index += 1) {
      state.setBinding({
        expiresAtMs: 60_000,
        projectPath: null,
        threadId: `thread-${String(index)}`,
        updatedAtMs: 5_000,
      });
      await bridge.ingestBatch({
        cursor: `cursor-cap-${String(index)}`,
        messages: [textMessage(50 + index, `request-${String(index)}`)],
      });
    }

    assert.deepEqual(startedThreads, ["thread-1", "thread-2", "thread-3"]);
    assert.equal(state.countActiveDispatches(), 3);
    assert.equal(state.peekQueuedTurn("thread-4")?.body, turnBody("request-4"));
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a resume failure keeps the inbound turn safely queued without calling startTurn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-resume-failure-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  let startCalls = 0;
  let nextId = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread() {
        throw new Error("App Server temporarily unavailable");
      },
      async startTurn() {
        startCalls += 1;
        return { turn: { id: "must-not-start" } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => `resume-failure-${String(nextId++)}`,
    now: () => 6_000,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-resume-failure",
      messages: [textMessage(61, "retry only when safe")],
    });
    assert.equal(startCalls, 0);
    assert.equal(state.countActiveDispatches(), 0);
    assert.equal(
      state.peekQueuedTurn("thread-main")?.body,
      turnBody("retry only when safe"),
    );
    assert.equal(
      leases.tryAcquire({
        createdAtMs: 6_001,
        instanceId: "desktop",
        operationId: "desktop-after-resume-failure",
        owner: "desktop",
        threadId: "thread-main",
        turnId: "desktop-after-resume-failure",
      }).acquired,
      true,
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a permanently missing thread is rejected instead of being queued forever", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-missing-thread-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.setBinding({
    expiresAtMs: 60_000,
    projectPath: "D:\\Project",
    threadId: "missing-thread",
    updatedAtMs: 1,
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread() {
        throw new Error("no rollout found for thread id missing-thread (code=-32600)");
      },
      async startTurn() {
        assert.fail("a missing thread must not start a turn");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "missing-thread-operation",
    now: () => 2_000,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-missing-thread",
      messages: [textMessage(65, "must not wait forever")],
    });
    assert.equal(state.countQueuedTurns(), 0);
    assert.equal(state.getBinding(2_001), null);
    assert.deepEqual(sent.map(({ text }) => text), [
      "原会话尚未写入 Codex 历史，已失效；请使用 /new 重新创建并发送。",
    ]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("startup removes an already queued turn whose thread never materialized", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-missing-queued-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const sent: SendInput[] = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  state.enqueueQueuedTurn({
    body: turnBody("queued forever"),
    contextToken: "ctx-missing-queued",
    createdAtMs: 1,
    dedupeKey: "missing-queued",
    threadId: "missing-queued-thread",
  });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread() {
        throw new Error("no rollout found for thread id missing-queued-thread (code=-32600)");
      },
      async startTurn() {
        assert.fail("a missing queued thread must not start a turn");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => "missing-queued-operation",
    now: () => 2_000,
    session,
    state,
  });

  try {
    await bridge.scheduleQueuedTurns();
    assert.equal(state.countQueuedTurns(), 0);
    assert.deepEqual(sent.map(({ text }) => text), [
      "原会话尚未写入 Codex 历史，已失效；请使用 /new 重新创建并发送。",
    ]);
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a newer message cannot bypass an older turn queued after resume fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-resume-fifo-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new SqliteState(databasePath);
  const leases = new SqliteTurnLeaseStore(databasePath);
  const started: string[] = [];
  let resumeCalls = 0;
  let nextId = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });

  const bridge = new BridgeEngine({
    bridgeInstanceId: "bridge-instance",
    codex: {
      async resumeThread(threadId) {
        resumeCalls += 1;
        if (resumeCalls === 1) throw new Error("App Server temporarily unavailable");
        return { thread: { id: threadId } };
      },
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
        started.push(input.text);
        return { turn: { id: turnId } };
      },
    },
    ilink: {
      async sendText(input) {
        return { accepted: true, clientId: input.clientId };
      },
    },
    leases,
    mainThreadId: "thread-main",
    newId: () => `resume-fifo-${String(nextId++)}`,
    now: () => 6_100,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-resume-fifo-1",
      messages: [textMessage(62, "older")],
    });
    await bridge.ingestBatch({
      cursor: "cursor-resume-fifo-2",
      messages: [textMessage(63, "newer")],
    });

    assert.deepEqual(started, []);
    assert.deepEqual(
      state.listQueuedTurns().map(({ body }) => body),
      [turnBody("older"), turnBody("newer")],
    );

    await bridge.scheduleQueuedTurns();
    assert.deepEqual(started, ["older"]);
    assert.deepEqual(
      state.listQueuedTurns().map(({ body }) => body),
      [turnBody("newer")],
    );
  } finally {
    bridge.close();
    leases.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a live Bridge approval can be decided once from WeChat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-approval-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  const sent: SendInput[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  let nextId = 1;
  const bridge = new BridgeEngine({
    codex: {
      respondToServerRequest(id, result) {
        responses.push({ id, result });
      },
      async startTurn() {
        assert.fail("approval commands must not start a turn");
      },
    },
    ilink: {
      async sendText(input) {
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    newId: () => `approval-client-${nextId++}`,
    now: () => 5_000,
    session,
    state,
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-approval",
      messages: [textMessage(30, "/help")],
    });
    sent.length = 0;
    assert.equal(
      await bridge.ingestCodexEvent({
        id: 77,
        method: "item/commandExecution/requestApproval",
        params: {
          command: "pnpm test",
          itemId: "item-approval",
          threadId: "thread-approval",
          turnId: "turn-approval",
        },
      }),
      true,
    );
    assert.match(sent[0]?.text ?? "", /Approval #1[\s\S]*pnpm test/u);

    await bridge.ingestBatch({
      cursor: "cursor-approved",
      messages: [textMessage(31, "/ok 1")],
    });
    assert.deepEqual(responses, [{ id: 77, result: { decision: "accept" } }]);
    assert.equal(sent.at(-1)?.text, "Approved #1");

    await bridge.ingestBatch({
      cursor: "cursor-duplicate-approval",
      messages: [textMessage(32, "/ok 1")],
    });
    assert.equal(responses.length, 1);
    assert.match(sent.at(-1)?.text ?? "", /已失效或不存在/u);
  } finally {
    bridge.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

async function withBridge(
  run: (input: {
    bridge: BridgeEngine;
    sent: SendInput[];
    state: SqliteState;
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-bridge-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  const sent: SendInput[] = [];
  let nextId = 1;
  state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
  const bridge = new BridgeEngine({
    ilink: {
      async sendText(input: SendInput): Promise<SendTextResult> {
        assert.equal(state.getOutbox(input.clientId)?.status, "pending");
        sent.push(input);
        return { accepted: true, clientId: input.clientId };
      },
    },
    newId: () => `client-${nextId++}`,
    now: () => 1_000,
    session,
    state,
  });

  try {
    await run({ bridge, sent, state });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

type SendInput = {
  clientId: string;
  contextToken: string;
  session: ILinkSession;
  signal?: AbortSignal;
  text: string;
  timeoutMs?: number;
};

class RefusingReleaseTurnLeaseStore extends SqliteTurnLeaseStore {
  override release(
    _expected: Parameters<SqliteTurnLeaseStore["release"]>[0],
  ): boolean {
    return false;
  }
}

class RefusingClaimTurnLeaseStore extends SqliteTurnLeaseStore {
  override claimBridgeTurn(): boolean {
    return false;
  }
}

function textMessage(
  id: number,
  text: string,
  fromUserId = "controller-a",
): WireWeixinMessage {
  return {
    context_token: `ctx-${id}`,
    create_time_ms: id,
    from_user_id: fromUserId,
    item_list: [{ text_item: { text }, type: 1 }],
    message_id: id,
  };
}

function imageMessage(
  id: number,
  text: string,
): WireWeixinMessage {
  return {
    context_token: `ctx-${id}`,
    create_time_ms: id,
    from_user_id: "controller-a",
    item_list: [
      ...(text ? [{ text_item: { text }, type: 1 }] : []),
      {
        image_item: {
          media: {
            full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image",
          },
        },
        type: 2,
      },
    ],
    message_id: id,
  };
}

function fileMessage(id: number, text: string): WireWeixinMessage {
  return {
    context_token: `ctx-${id}`,
    create_time_ms: id,
    from_user_id: "controller-a",
    item_list: [
      { text_item: { text }, type: 1 },
      {
        file_item: {
          file_name: "report.pdf",
          media: {
            aes_key: "fixture-key",
            encrypt_query_param: "fixture-param",
          },
        },
        type: 4,
      },
    ],
    message_id: id,
  };
}

function rawVoiceMessage(id: number): WireWeixinMessage {
  return {
    context_token: `ctx-${id}`,
    create_time_ms: id,
    from_user_id: "controller-a",
    item_list: [
      {
        type: 3,
        voice_item: {
          media: {
            aes_key: "fixture-key",
            full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice",
          },
        },
      },
    ],
    message_id: id,
  };
}

function turnBody(text: string): string {
  return serializeDurableTurnInput({ attachments: [], text, version: 1 });
}
