import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalCoordinator } from "../src/bridge/approval-coordinator.ts";

test("one live approval uses bare ok or no and is answered once", async () => {
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
  const code = approvals.list()[0]?.code;
  assert.match(code ?? "", /^[A-F][A-F\d]{5}$/u);
  assert.match(sent[0]?.text ?? "", /需要批准[\s\S]*pnpm test[\s\S]*回复：ok 或 no/u);
  assert.doesNotMatch(sent[0]?.text ?? "", new RegExp(code ?? "missing", "u"));
  assert.deepEqual(approvals.decide(null, true), { code, kind: "decided" });
  assert.deepEqual(responses, [{ id: 41, result: { decision: "accept" } }]);
  assert.deepEqual(approvals.decide(code ?? "", true), {
    code,
    kind: "not-found",
  });
});

test("multiple approvals require their immutable short codes", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_500,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  for (const [id, itemId, command] of [
    [51, "item-a", "pnpm test"],
    [52, "item-b", "pnpm typecheck"],
  ] as const) {
    await approvals.ingest({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        command,
        itemId,
        threadId: `thread-${itemId}`,
        turnId: `turn-${itemId}`,
      },
    });
  }

  const [first, second] = approvals.list();
  assert.match(first?.code ?? "", /^[A-F][A-F\d]{5}$/u);
  assert.match(second?.code ?? "", /^[A-F][A-F\d]{5}$/u);
  assert.notEqual(first?.code, second?.code);
  assert.match(sent[0] ?? "", /回复：ok 或 no/u);
  assert.match(sent[1] ?? "", /当前有多个待审批/u);
  assert.match(
    sent[1] ?? "",
    new RegExp(`${first?.code}：Command: pnpm test`, "u"),
  );
  assert.match(
    sent[1] ?? "",
    new RegExp(`${second?.code}：Command: pnpm typecheck`, "u"),
  );
  assert.match(sent[1] ?? "", /回复：ok<code> 或 no<code>/u);
  assert.deepEqual(approvals.decide(null, true), {
    approvals: [first, second],
    kind: "ambiguous",
  });
  assert.deepEqual(responses, []);

  assert.deepEqual(approvals.decide(second?.code ?? "", false), {
    code: second?.code,
    kind: "decided",
  });
  assert.deepEqual(responses, [{ id: 52, result: { decision: "decline" } }]);
});

test("a completed approval code cannot decide a later request", async () => {
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_750,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  await approvals.ingest({
    id: 61,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-old",
      threadId: "thread-old",
      turnId: "turn-old",
    },
  });
  const staleCode = approvals.list()[0]?.code ?? "";
  approvals.decide(null, true);
  await approvals.ingest({
    id: 62,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-new",
      threadId: "thread-new",
      turnId: "turn-new",
    },
  });

  assert.deepEqual(approvals.decide(staleCode, true), {
    code: staleCode,
    kind: "not-found",
  });
  assert.equal(approvals.list().length, 1);
  assert.deepEqual(responses, [{ id: 61, result: { decision: "accept" } }]);
});

test("permissions are scoped to one turn and expiry denies stale callbacks", async () => {
  let now = 2_000;
  const expired: Array<{ code: string; reason: string }> = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => now,
    onExpired(approval, reason) {
      expired.push({ code: approval.code, reason });
    },
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
  const code = approvals.list()[0]?.code ?? "";
  now = 2_101;
  assert.equal(approvals.expire(), 1);
  assert.deepEqual(responses, [
    {
      id: "permission-1",
      result: { permissions: {}, scope: "turn" },
    },
  ]);
  assert.deepEqual(expired, [{ code, reason: "timeout" }]);
  assert.deepEqual(approvals.list(), []);
});

test("notification failure keeps the live approval and retries with one client id", async () => {
  const attempts: Array<{ clientId: string; text: string }> = [];
  const retryDelays: number[] = [];
  const retryResolvers: Array<() => void> = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text, clientId) {
      attempts.push({ clientId, text });
      if (attempts.length === 1) throw new Error("offline");
    },
    now: () => 3_000,
    respond(id, result) {
      responses.push({ id, result });
    },
    sleep(milliseconds) {
      retryDelays.push(milliseconds);
      return new Promise((resolve) => retryResolvers.push(resolve));
    },
  });

  await approvals.ingest({
    id: 43,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-3",
      reason: "write outside workspace",
      threadId: "thread-3",
      turnId: "turn-3",
    },
  });
  assert.deepEqual(responses, []);
  assert.equal(approvals.list()[0]?.deliveryStatus, "retrying");
  assert.deepEqual(retryDelays, [1_000]);

  retryResolvers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.clientId, attempts[1]?.clientId);
  assert.equal(approvals.list()[0]?.deliveryStatus, "delivered");
  assert.deepEqual(responses, []);
});

test("a lost Codex callback cancels notification retries with an explicit reason", async () => {
  let live = true;
  const expired: string[] = [];
  const retryResolvers: Array<() => void> = [];
  const approvals = new ApprovalCoordinator({
    isLive: () => live,
    async notify() {
      throw new Error("offline");
    },
    now: () => 3_500,
    onExpired(_approval, reason) {
      expired.push(reason);
    },
    respond() {
      assert.fail("a lost callback cannot be answered");
    },
    sleep() {
      return new Promise((resolve) => retryResolvers.push(resolve));
    },
  });

  await approvals.ingest({
    id: 45,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-lost",
      threadId: "thread-lost",
      turnId: "turn-lost",
    },
  });
  live = false;
  retryResolvers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(expired, ["request-lost"]);
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
