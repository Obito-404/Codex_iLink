import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OutboxWorker } from "../src/bridge/outbox-worker.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import type { ILinkSession } from "../src/ilink/protocol.ts";

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

async function withState(run: (state: SqliteState) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbox-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  try {
    await run(state);
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}
