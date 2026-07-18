import assert from "node:assert/strict";
import test from "node:test";

import { routeInboundText } from "../src/domain/route-inbound.ts";

test("normal text follows an active session binding and refreshes its expiry", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: {
        expiresAtMs: nowMs + 1,
        threadId: "thread-project",
        updatedAtMs: nowMs - 1,
      },
      mainThreadId: "thread-main",
      notificationWindows: [],
      nowMs,
      text: "继续处理这个需求",
    }),
    {
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-project",
      },
      kind: "turn",
      route: "binding",
      text: "继续处理这个需求",
      threadId: "thread-project",
    },
  );
});

test("normal text refreshes a binding with the configured idle timeout", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  const decision = routeInboundText({
    binding: {
      expiresAtMs: nowMs + 1,
      threadId: "thread-project",
      updatedAtMs: nowMs - 1,
    },
    bindingIdleTimeoutMs: 60 * 60 * 1_000,
    mainThreadId: "thread-main",
    notificationWindows: [],
    nowMs,
    text: "继续处理这个需求",
  });

  assert.equal(decision.kind, "turn");
  if (decision.kind !== "turn") return;
  assert.equal(decision.binding?.expiresAtMs, nowMs + 60 * 60 * 1_000);
});

test("a newer session binding keeps priority over an older notification window", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-explicit",
        updatedAtMs: nowMs - 1_000,
      },
      mainThreadId: "thread-main",
      notificationWindows: [
        {
          deliveredAtMs: nowMs - 2_000,
          expiresAtMs: nowMs + 5 * 60 * 1_000,
          threadId: "thread-old-notification",
        },
      ],
      nowMs,
      text: "继续当前会话",
    }),
    {
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-explicit",
      },
      kind: "turn",
      route: "binding",
      text: "继续当前会话",
      threadId: "thread-explicit",
    },
  );
});

test("a newer session binding keeps priority over multiple older notification windows", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-explicit",
        updatedAtMs: nowMs - 1_000,
      },
      mainThreadId: "thread-main",
      notificationWindows: [
        {
          deliveredAtMs: nowMs - 3_000,
          expiresAtMs: nowMs + 5 * 60 * 1_000,
          threadId: "thread-old-a",
        },
        {
          deliveredAtMs: nowMs - 2_000,
          expiresAtMs: nowMs + 5 * 60 * 1_000,
          threadId: "thread-old-b",
        },
      ],
      nowMs,
      text: "继续当前会话",
    }),
    {
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-explicit",
      },
      kind: "turn",
      route: "binding",
      text: "继续当前会话",
      threadId: "thread-explicit",
    },
  );
});

test("one newer notification window supersedes an older session binding", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-old-binding",
        updatedAtMs: nowMs - 2_000,
      },
      mainThreadId: "thread-main",
      notificationWindows: [
        {
          deliveredAtMs: nowMs - 1_000,
          expiresAtMs: nowMs + 5 * 60 * 1_000,
          threadId: "thread-notification",
        },
      ],
      nowMs,
      text: "继续通知里的任务",
    }),
    {
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-notification",
      },
      kind: "turn",
      route: "notification",
      text: "继续通知里的任务",
      threadId: "thread-notification",
    },
  );
});

test("normal text follows the only live notification window and creates a binding", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: null,
      mainThreadId: "thread-main",
      notificationWindows: [
        {
          deliveredAtMs: nowMs - 1,
          expiresAtMs: nowMs + 5 * 60 * 1_000,
          threadId: "thread-notification",
        },
      ],
      nowMs,
      text: "继续",
    }),
    {
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-notification",
      },
      kind: "turn",
      route: "notification",
      text: "继续",
      threadId: "thread-notification",
    },
  );
});

test("normal text is not guessed when multiple notification windows are live", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: null,
      mainThreadId: "thread-main",
      notificationWindows: [
        {
          deliveredAtMs: nowMs - 3,
          expiresAtMs: nowMs + 1,
          threadId: "thread-a",
        },
        {
          deliveredAtMs: nowMs - 2,
          expiresAtMs: nowMs + 2,
          threadId: "thread-b",
        },
        {
          deliveredAtMs: nowMs - 1,
          expiresAtMs: nowMs - 1,
          threadId: "thread-expired",
        },
      ],
      nowMs,
      text: "继续",
    }),
    {
      kind: "ambiguousNotificationRoute",
      threadIds: ["thread-a", "thread-b"],
    },
  );
});

test("an older binding does not hide one of multiple live notification windows", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: {
        expiresAtMs: nowMs + 30 * 60 * 1_000,
        threadId: "thread-binding",
        updatedAtMs: nowMs - 2_000,
      },
      mainThreadId: "thread-main",
      notificationWindows: [
        {
          deliveredAtMs: nowMs - 3_000,
          expiresAtMs: nowMs + 1_000,
          threadId: "thread-a",
        },
        {
          deliveredAtMs: nowMs - 1_000,
          expiresAtMs: nowMs + 2_000,
          threadId: "thread-b",
        },
      ],
      nowMs,
      text: "继续",
    }),
    {
      kind: "ambiguousNotificationRoute",
      threadIds: ["thread-a", "thread-b"],
    },
  );
});
