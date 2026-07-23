import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWechatFinalReply,
  WECHAT_TEXT_MAX_UTF8_BYTES,
} from "../src/bridge/wechat-output.ts";
import { normalizeWindowsMarkdownPath } from "../src/media/outbound-media.ts";

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

test("a local Windows image path is never emitted as a fake WeChat link", () => {
  const messages = formatWechatFinalReply(
    "已发给你。\n[到账凭证.png](<C:\\Users\\obito_li\\Desktop\\报销\\到账凭证.png>)",
  );

  assert.doesNotMatch(messages.join("\n"), /\]\(<[A-Za-z]:\\/u);
});

test("Codex escaped Windows separators normalize back to one local path", () => {
  assert.equal(
    normalizeWindowsMarkdownPath(
      "C:\\\\Users\\\\obito_li\\\\Desktop\\\\报销\\\\到账凭证.png",
    ),
    "C:\\Users\\obito_li\\Desktop\\报销\\到账凭证.png",
  );
});

test("Desktop inbox item directives are omitted from WeChat text", () => {
  const messages = formatWechatFinalReply(
    `今日晨间简报暂无法生成：尚未连接邮箱与日历。

请选择 Google 或 Microsoft 邮箱与日历。📅

::inbox-item{title="晨间简报等待数据连接" summary="请选择 Google 或 Microsoft 邮箱与日历"}`,
  );

  assert.equal(
    messages.join(""),
    `今日晨间简报暂无法生成：尚未连接邮箱与日历。

请选择 Google 或 Microsoft 邮箱与日历。📅`,
  );
  assert.doesNotMatch(messages.join(""), /inbox-item/u);
});

test("inbox item examples inside Markdown code remain visible", () => {
  const directive =
    '::inbox-item{title="示例标题" summary="这是代码示例"}';
  const fenced = `\`\`\`text
${directive}
\`\`\``;
  const indented = `示例：

    ${directive}`;

  assert.equal(formatWechatFinalReply(fenced).join(""), fenced);
  assert.equal(formatWechatFinalReply(indented).join(""), indented);
});
