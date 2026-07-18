import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OutboxWorker } from "../src/bridge/outbox-worker.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import type { ILinkSession } from "../src/ilink/protocol.ts";
import {
  parseOutboundPayload,
  serializeOutboundPayload,
  stageOutboundMedia,
} from "../src/media/outbound-media.ts";

const session: ILinkSession = {
  baseUrl: "https://ilink.example",
  botId: "bot-a",
  botToken: "token",
  controllerUserId: "controller-a",
};

test("an outbox item without context is deferred without a failed attempt", async () => {
  await withState(async (state) => {
    state.enqueueOutbox({
      body: "离线时产生的通知",
      clientId: "no-context-client",
      contextToken: "",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    let calls = 0;
    const worker = new OutboxWorker({
      ilink: {
        async sendText() {
          calls += 1;
          throw new Error("must wait for controller context");
        },
      },
      now: () => 2,
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 1,
      failed: 0,
    });
    assert.equal(calls, 0);
    assert.equal(worker.resetDeferred(), 0);
    assert.equal(state.getOutbox("no-context-client")?.status, "pending");
  });
});

test("an empty-context item uses the latest controller context without changing its identity", async () => {
  await withState(async (state) => {
    state.bindController({ accountId: "bot-a", boundAtMs: 1, userId: "controller-a" });
    state.acceptInboundBatch({
      accountId: "bot-a",
      controllerUserId: "controller-a",
      messages: [
        {
          body: "/help",
          contextToken: "ctx-latest",
          messageId: "context-seed",
          receivedAtMs: 2,
        },
      ],
      nextCursor: "cursor-latest",
      updatedAtMs: 2,
    });
    state.enqueueOutbox({
      body: "等待上下文的通知",
      clientId: "borrow-context-client",
      contextToken: "",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    const sent: Array<{ clientId: string; contextToken: string; text: string }> = [];
    const worker = new OutboxWorker({
      ilink: {
        async sendText(input) {
          sent.push(input);
          return { accepted: true, clientId: input.clientId };
        },
      },
      now: () => 3,
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 1,
      deferred: 0,
      failed: 0,
    });
    assert.deepEqual(sent, [
      {
        clientId: "borrow-context-client",
        contextToken: "ctx-latest",
        session,
        text: "等待上下文的通知",
      },
    ]);
    assert.equal(state.getOutbox("borrow-context-client")?.contextToken, "");
  });
});

test("pending outbox is replayed once with its original client and context ids", async () => {
  await withState(async (state) => {
    state.enqueueOutbox({
      body: "完成结果",
      clientId: "stable-client",
      contextToken: "original-context",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    const calls: Array<Record<string, unknown>> = [];
    const confirmations: Array<{ clientId: string; confirmedAtMs: number }> = [];
    const worker = new OutboxWorker({
      ilink: {
        async sendText(input) {
          calls.push(input);
          return { accepted: true, clientId: input.clientId };
        },
      },
      now: () => 2,
      onConfirmed(item, confirmedAtMs) {
        confirmations.push({ clientId: item.clientId, confirmedAtMs });
      },
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 1,
      deferred: 0,
      failed: 0,
    });
    assert.equal(calls[0]?.clientId, "stable-client");
    assert.equal(calls[0]?.contextToken, "original-context");
    assert.equal(state.getOutbox("stable-client")?.status, "confirmed");
    assert.deepEqual(confirmations, [
      { clientId: "stable-client", confirmedAtMs: 2 },
    ]);
    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 0,
      failed: 0,
    });
  });
});

test("delivery uncertainty retries the same client id and then defers for this run", async () => {
  await withState(async (state) => {
    state.enqueueOutbox({
      body: "通知",
      clientId: "retry-client",
      contextToken: "ctx",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    const clientIds: string[] = [];
    const delays: number[] = [];
    const worker = new OutboxWorker({
      ilink: {
        async sendText(input) {
          clientIds.push(input.clientId);
          throw new Error("delivery unknown");
        },
      },
      maxAttempts: 3,
      now: () => 2,
      session,
      async sleep(milliseconds) {
        delays.push(milliseconds);
      },
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 0,
      failed: 1,
    });
    assert.deepEqual(clientIds, ["retry-client", "retry-client", "retry-client"]);
    assert.deepEqual(delays, [250, 500]);
    assert.equal(state.getOutbox("retry-client")?.status, "pending");
    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 1,
      failed: 0,
    });
  });
});

test("a real inbound can allow one deferred delivery retry", async () => {
  await withState(async (state) => {
    state.enqueueOutbox({
      body: "original undelivered reply",
      clientId: "deferred-client",
      contextToken: "ctx-original",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    let available = false;
    let calls = 0;
    const worker = new OutboxWorker({
      ilink: {
        async sendText(input) {
          calls += 1;
          if (!available) throw new Error("temporarily unavailable");
          return { accepted: true, clientId: input.clientId };
        },
      },
      maxAttempts: 1,
      now: () => 2,
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 0,
      failed: 1,
    });
    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 1,
      failed: 0,
    });
    assert.equal(calls, 1);

    available = true;
    assert.equal(worker.resetDeferred(), 1);
    assert.deepEqual(await worker.drain(), {
      confirmed: 1,
      deferred: 0,
      failed: 0,
    });
    assert.equal(calls, 2);
  });
});

test("concurrent drains share one in-flight delivery", async () => {
  await withState(async (state) => {
    state.enqueueOutbox({
      body: "single flight",
      clientId: "single-client",
      contextToken: "ctx",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new OutboxWorker({
      ilink: {
        async sendText(input) {
          calls += 1;
          await gate;
          return { accepted: true, clientId: input.clientId };
        },
      },
      now: () => 2,
      session,
      state,
    });

    const first = worker.drain();
    const second = worker.drain();
    release();
    assert.deepEqual(await first, await second);
    assert.equal(calls, 1);
  });
});

test("media is uploaded once, persisted before send, and blocks a false text claim", async () => {
  await withState(async (state, directory) => {
    const outboundDirectory = join(directory, "Outbound");
    const workspaceRoot = join(directory, "workspace");
    const sourcePath = join(workspaceRoot, "image.png");
    mkdirSync(workspaceRoot);
    writeFileSync(sourcePath, "staged image");
    const snapshot = stageOutboundMedia({
      exportRoot: outboundDirectory,
      label: "凭证.png",
      path: sourcePath,
      workspaceRoot,
    });
    const snapshotPath = snapshot.path;
    state.enqueueOutbox({
      body: serializeOutboundPayload(snapshot),
      clientId: "codex-ilink:turn-media:final:part:1",
      contextToken: "ctx",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    state.enqueueOutbox({
      body: "已发给你。",
      clientId: "codex-ilink:turn-media:final:part:2",
      contextToken: "ctx",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    let available = false;
    let prepareCalls = 0;
    let mediaCalls = 0;
    let textCalls = 0;
    const worker = new OutboxWorker({
      ilink: {
        async prepareMedia(input) {
          prepareCalls += 1;
          writeFileSync(snapshotPath, "changed after verified read");
          assert.equal(
            Buffer.from(input.plaintext ?? []).toString("utf8"),
            "staged image",
          );
          return {
            aesKeyBase64: "YWVzLWtleQ==",
            ciphertextSize: 32,
            encryptedQueryParam: "download-param",
            kind: input.media.kind,
            name: input.media.name,
            plaintextSize: 20,
            type: "prepared-media",
            v: 1,
          };
        },
        async sendMedia(input) {
          mediaCalls += 1;
          if (!available) throw new Error("network unavailable");
          return { accepted: true, clientId: input.clientId };
        },
        async sendText(input) {
          textCalls += 1;
          return { accepted: true, clientId: input.clientId };
        },
      },
      maxAttempts: 1,
      now: () => 2,
      outboundDirectory,
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 0,
      deferred: 1,
      failed: 1,
    });
    assert.equal(prepareCalls, 1);
    assert.equal(mediaCalls, 1);
    assert.equal(textCalls, 0);
    const persisted = state.getOutbox("codex-ilink:turn-media:final:part:1");
    assert.ok(persisted?.body);
    assert.equal(parseOutboundPayload(persisted.body).type, "prepared-media");
    assert.equal(existsSync(snapshotPath), false);

    available = true;
    assert.equal(worker.resetDeferred(), 1);
    assert.deepEqual(await worker.drain(), {
      confirmed: 2,
      deferred: 0,
      failed: 0,
    });
    assert.equal(prepareCalls, 1, "a retry must reuse the durable CDN payload");
    assert.equal(mediaCalls, 2);
    assert.equal(textCalls, 1);
  });
});

test("legacy local-media is replaced by a warning without reading the path", async () => {
  await withState(async (state) => {
    state.enqueueOutbox({
      body: serializeOutboundPayload({
        kind: "file",
        name: "旧附件.txt",
        path: "C:\\Users\\controller\\secret.txt",
        type: "local-media",
        v: 1,
      }),
      clientId: "legacy-local-media",
      contextToken: "ctx",
      createdAtMs: 1,
      targetUserId: "controller-a",
    });
    const sent: string[] = [];
    const worker = new OutboxWorker({
      ilink: {
        async prepareMedia() {
          assert.fail("legacy paths must never be read or uploaded");
        },
        async sendMedia() {
          assert.fail("legacy paths must never be sent");
        },
        async sendText(input) {
          sent.push(input.text);
          return { accepted: true, clientId: input.clientId };
        },
      },
      now: () => 2,
      session,
      state,
    });

    assert.deepEqual(await worker.drain(), {
      confirmed: 1,
      deferred: 0,
      failed: 0,
    });
    assert.match(sent[0] ?? "", /附件记录.*未发送/u);
    assert.equal(state.getOutbox("legacy-local-media")?.status, "confirmed");
    assert.equal(state.getOutbox("legacy-local-media")?.body, null);
  });
});

async function withState(
  run: (state: SqliteState, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbox-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  try {
    await run(state, directory);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}
