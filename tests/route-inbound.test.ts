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

test("normal text follows the only live notification window and creates a binding", () => {
  const nowMs = Date.UTC(2026, 6, 15, 15, 30, 0);

  assert.deepEqual(
    routeInboundText({
      binding: null,
      mainThreadId: "thread-main",
      notificationWindows: [
        {
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
        { expiresAtMs: nowMs + 1, threadId: "thread-a" },
        { expiresAtMs: nowMs + 2, threadId: "thread-b" },
        { expiresAtMs: nowMs - 1, threadId: "thread-expired" },
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
