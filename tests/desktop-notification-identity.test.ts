import assert from "node:assert/strict";
import test from "node:test";

import {
  desktopNotificationCandidateClientIds,
  desktopNotificationClientId,
  desktopNotificationMessageClientIds,
  parseDesktopNotificationClientId,
} from "../src/bridge/desktop-notification-identity.ts";
import { WECHAT_FINAL_MAX_MESSAGES } from "../src/bridge/wechat-output.ts";

test("Desktop notification parts stay aligned with the WeChat message cap", () => {
  const baseClientId = desktopNotificationClientId("thread-a", "turn-a");
  const maxPartClientId =
    `${baseClientId}:part:${String(WECHAT_FINAL_MAX_MESSAGES)}`;
  const overflowClientId =
    `${baseClientId}:part:${String(WECHAT_FINAL_MAX_MESSAGES + 1)}`;

  assert.equal(
    desktopNotificationCandidateClientIds(baseClientId).length,
    WECHAT_FINAL_MAX_MESSAGES + 1,
  );
  assert.equal(
    desktopNotificationMessageClientIds(
      baseClientId,
      WECHAT_FINAL_MAX_MESSAGES,
    ).length,
    WECHAT_FINAL_MAX_MESSAGES,
  );
  assert.equal(
    parseDesktopNotificationClientId(maxPartClientId)?.part,
    WECHAT_FINAL_MAX_MESSAGES,
  );
  assert.equal(parseDesktopNotificationClientId(overflowClientId), null);
});

test("interrupted Desktop notifications are grouped but cannot open a reply route", () => {
  const clientId = desktopNotificationClientId(
    "thread-interrupted",
    "turn-interrupted",
    false,
  );

  assert.deepEqual(parseDesktopNotificationClientId(clientId), {
    baseClientId: clientId,
    part: null,
    replyable: false,
    threadId: "thread-interrupted",
    turnId: "turn-interrupted",
  });
});
