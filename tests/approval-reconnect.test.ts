import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { BridgeEngine } from "../src/bridge/bridge.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import {
  CodexOutcomeUnknownError,
  CodexRuntime,
} from "../src/codex/codex-runtime.ts";
import type {
  ILinkSession,
  WireWeixinMessage,
} from "../src/ilink/protocol.ts";

const fakeRuntime = resolve("tests/fixtures/fake-codex-runtime.mjs");
const session: ILinkSession = {
  baseUrl: "https://ilink.example",
  botId: "bot-a",
  botToken: "test-token",
  controllerUserId: "controller-a",
};

test("an approval remains approvable when only the turn start response times out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-stale-approval-"));
  const state = new SqliteState(join(directory, "state.sqlite"));
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-stale-approval",
    command: [
      process.execPath,
      fakeRuntime,
      "--request-then-hang-turn-start",
    ],
    requestTimeoutMs: 1_000,
  });
  const sent: string[] = [];
  let nextClientId = 1;
  state.bindController({
    accountId: session.botId,
    boundAtMs: 1,
    userId: session.controllerUserId,
  });
  const bridge = new BridgeEngine({
    codex: runtime,
    ilink: {
      async sendText(input) {
        sent.push(input.text);
        return { accepted: true, clientId: input.clientId };
      },
    },
    newId: () => `client-${nextClientId++}`,
    now: () => 5_000,
    session,
    state,
  });
  const eventTasks: Array<Promise<boolean>> = [];
  const unsubscribe = runtime.onEvent((event) => {
    if (event.method === "item/tool/requestUserInput") {
      assert.notEqual(event.id, undefined);
    }
    eventTasks.push(
      bridge.ingestCodexEvent(
        event.method === "item/tool/requestUserInput"
          ? {
              id: event.id!,
              method: "item/commandExecution/requestApproval",
              params: {
                command: "pnpm test",
                itemId: "item-old-owner",
                threadId: "thread-old-owner",
                turnId: "turn-old-owner",
              },
            }
          : event,
      ),
    );
  });

  try {
    await bridge.ingestBatch({
      cursor: "cursor-context",
      messages: [textMessage(1, "help")],
    });
    sent.length = 0;

    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:stale-approval",
        text: "触发旧连接审批",
        threadId: "thread-old-owner",
      }),
      CodexOutcomeUnknownError,
    );
    await Promise.all(eventTasks);
    assert.match(sent[0] ?? "", /需要批准[\s\S]*pnpm test[\s\S]*回复：ok 或 no/u);

    sent.length = 0;
    await runtime.listThreads();
    await Promise.all(eventTasks);
    await bridge.ingestBatch({
      cursor: "cursor-after-reconnect",
      messages: [textMessage(2, "st"), textMessage(3, "ok")],
    });

    const status = sent.find((text) => text.includes("待审批：")) ?? "";
    assert.deepEqual(
      {
        approvalReply: sent.find((text) => text === "已批准。"),
        pendingCount: /待审批：(\d+)/u.exec(status)?.[1],
      },
      {
        approvalReply: undefined,
        pendingCount: "1",
      },
    );
  } finally {
    unsubscribe();
    bridge.close();
    runtime.close();
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

function textMessage(messageId: number, text: string): WireWeixinMessage {
  return {
    context_token: `ctx-${messageId}`,
    from_user_id: session.controllerUserId,
    item_list: [{ text_item: { text }, type: 1 }],
    message_id: messageId,
  };
}
