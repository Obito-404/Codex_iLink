import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalCoordinator } from "../src/bridge/approval-coordinator.ts";

test("a live command approval is numbered, notified, and answered once", async () => {
  const sent: Array<{ clientId: string; text: string }> = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text, clientId) {
      sent.push({ clientId, text });
    },
    now: () => 1_000,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  assert.equal(
    await approvals.ingest({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm test",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }),
    true,
  );
  assert.match(sent[0]?.text ?? "", /Approval #1[\s\S]*pnpm test[\s\S]*\/ok 1/u);
  assert.deepEqual(approvals.decide(1, true), { index: 1, kind: "decided" });
  assert.deepEqual(responses, [{ id: 41, result: { decision: "accept" } }]);
  assert.deepEqual(approvals.decide(1, true), { index: 1, kind: "not-found" });
});

test("permissions are scoped to one turn and expiry denies stale callbacks", async () => {
  let now = 2_000;
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => now,
    respond(id, result) {
      responses.push({ id, result });
    },
    timeoutMs: 100,
  });

  await approvals.ingest({
    id: "permission-1",
    method: "item/permissions/requestApproval",
    params: {
      itemId: "item-2",
      permissions: { network: { enabled: true } },
      threadId: "thread-2",
      turnId: "turn-2",
    },
  });
  now = 2_101;
  assert.equal(approvals.expire(), 1);
  assert.deepEqual(responses, [
    {
      id: "permission-1",
      result: { permissions: {}, scope: "turn" },
    },
  ]);
  assert.deepEqual(approvals.list(), []);
});

test("notification failure denies instead of leaving Codex waiting", async () => {
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {
      throw new Error("offline");
    },
    now: () => 3_000,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  await assert.rejects(
    approvals.ingest({
      id: 43,
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "item-3",
        reason: "write outside workspace",
        threadId: "thread-3",
        turnId: "turn-3",
      },
    }),
    /offline/u,
  );
  assert.deepEqual(responses, [{ id: 43, result: { decision: "decline" } }]);
  assert.deepEqual(approvals.list(), []);
});

test("closing the bridge declines every still-live request", async () => {
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 4_000,
    respond(id, result) {
      responses.push({ id, result });
    },
  });
  await approvals.ingest({
    id: 44,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-4",
      threadId: "thread-4",
      turnId: "turn-4",
    },
  });

  approvals.close();
  assert.deepEqual(responses, [{ id: 44, result: { decision: "decline" } }]);
  assert.deepEqual(approvals.list(), []);
});
