import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWechatFinalReply,
  WECHAT_TEXT_MAX_UTF8_BYTES,
} from "../src/bridge/wechat-output.ts";

test("an untruncated reply splits only between complete Unicode graphemes", () => {
  const grapheme = "👩🏽‍💻";
  const original = grapheme.repeat(200);
  const messages = formatWechatFinalReply(original);

  assert.equal(messages.length, 2);
  assert.equal(messages.join(""), original);
  assert.ok(
    messages.every(
      (message) =>
        Buffer.byteLength(message, "utf8") <= WECHAT_TEXT_MAX_UTF8_BYTES &&
        message.split(grapheme).join("") === "",
    ),
  );
});
