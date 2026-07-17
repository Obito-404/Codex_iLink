import assert from "node:assert/strict";
import test from "node:test";

import { parseControllerMessage } from "../src/bridge/inbound-message.ts";

test("a direct controller text becomes a stable inbound message", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-1",
        create_time_ms: 123,
        from_user_id: "controller",
        item_list: [{ text_item: { text: "继续" }, type: 1 }],
        message_id: 42,
      },
      "controller",
    ),
    {
      contextToken: "ctx-1",
      kind: "text",
      messageId: "42",
      receivedAtMs: 123,
      text: "继续",
    },
  );
});

test("a lossless unsigned 64-bit message id remains stable", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-64",
        create_time_ms: 123,
        from_user_id: "controller",
        item_list: [{ text_item: { text: "/st" }, type: 1 }],
        message_id: "9223372036854775807",
      },
      "controller",
    ),
    {
      contextToken: "ctx-64",
      kind: "text",
      messageId: "9223372036854775807",
      receivedAtMs: 123,
      text: "/st",
    },
  );
});

test("other users and group messages are silently ignored", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx",
        from_user_id: "intruder",
        item_list: [{ text_item: { text: "/p" }, type: 1 }],
        message_id: 1,
      },
      "controller",
    ),
    { kind: "ignored" },
  );
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx",
        from_user_id: "controller",
        group_id: "group-a",
        item_list: [{ text_item: { text: "/p" }, type: 1 }],
        message_id: 2,
      },
      "controller",
    ),
    { kind: "ignored" },
  );
});

test("controller media is rejected without downloading it", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-media",
        from_user_id: "controller",
        item_list: [{ type: 2 }],
        message_id: 3,
      },
      "controller",
    ),
    {
      contextToken: "ctx-media",
      kind: "unsupportedMedia",
      messageId: "3",
    },
  );
});

test("a voice transcript becomes text without exposing the voice download", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-voice",
        create_time_ms: 456,
        from_user_id: "controller",
        item_list: [
          {
            type: 3,
            voice_item: {
              media: {
                aes_key: "must-not-be-returned",
                full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice",
              },
              text: "微信语音转写",
            },
          },
        ],
        message_id: 5,
      },
      "controller",
    ),
    {
      contextToken: "ctx-voice",
      kind: "text",
      messageId: "5",
      receivedAtMs: 456,
      text: "微信语音转写",
    },
  );
});

test("main media follows the official IMAGE over VIDEO over FILE over VOICE priority", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-mixed",
        create_time_ms: 789,
        from_user_id: "controller",
        item_list: [
          { text_item: { text: "请分析这些附件" }, type: 1 },
          {
            file_item: {
              file_name: "../报告?.pdf",
              media: {
                aes_key: "file-key",
                encrypt_query_param: "file-param",
              },
            },
            type: 4,
          },
          {
            type: 5,
            video_item: {
              media: {
                aes_key: "video-key",
                encrypt_query_param: "video-param",
              },
            },
          },
          { type: 3, voice_item: { text: "语音补充" } },
          {
            image_item: {
              aeskey: "00112233445566778899aabbccddeeff",
              media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image" },
            },
            type: 2,
          },
        ],
        message_id: "18446744073709551615",
      },
      "controller",
    ),
    {
      contextToken: "ctx-mixed",
      kind: "text",
      mediaCandidates: [
        {
          aesKeyHex: "00112233445566778899aabbccddeeff",
          displayName: "image.jpg",
          kind: "image",
          media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image" },
          status: "downloadable",
        },
      ],
      messageId: "18446744073709551615",
      receivedAtMs: 789,
      text: "请分析这些附件\n语音补充",
    },
  );
});

test("official media priority skips main items without a CDN download reference", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-downloadable-priority",
        from_user_id: "controller",
        item_list: [
          { image_item: { media: {} }, type: 2 },
          {
            file_item: {
              file_name: "usable.pdf",
              media: {
                aes_key: "file-key",
                encrypt_query_param: "file-param",
              },
            },
            type: 4,
          },
        ],
        message_id: 11,
      },
      "controller",
    ),
    {
      contextToken: "ctx-downloadable-priority",
      kind: "text",
      mediaCandidates: [
        {
          displayName: "usable.pdf",
          kind: "file",
          media: {
            aes_key: "file-key",
            encrypt_query_param: "file-param",
          },
          status: "downloadable",
        },
      ],
      messageId: "11",
      receivedAtMs: 0,
      text: "",
    },
  );
});

test("a media-only message is retained for later bounded download", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-image",
        from_user_id: "controller",
        item_list: [
          {
            image_item: {
              media: { encrypt_query_param: "opaque" },
            },
            type: 2,
          },
        ],
        message_id: 6,
      },
      "controller",
    ),
    {
      contextToken: "ctx-image",
      kind: "text",
      mediaCandidates: [
        {
          displayName: "image.jpg",
          kind: "image",
          media: { encrypt_query_param: "opaque" },
          status: "downloadable",
        },
      ],
      messageId: "6",
      receivedAtMs: 0,
      text: "",
    },
  );
});

test("voice without a transcript is explicitly unsupported and not downloadable", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-voice-raw",
        from_user_id: "controller",
        item_list: [
          {
            type: 3,
            voice_item: {
              media: {
                aes_key: "must-not-leave-parser",
                full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice",
              },
            },
          },
        ],
        message_id: 7,
      },
      "controller",
    ),
    {
      contextToken: "ctx-voice-raw",
      kind: "unsupportedMedia",
      mediaCandidates: [
        {
          kind: "voice",
          reason: "voice-transcript-missing",
          status: "unsupported",
        },
      ],
      messageId: "7",
    },
  );
});

test("quoted media is a fallback and a main media item takes precedence", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-reference",
        from_user_id: "controller",
        item_list: [
          {
            ref_msg: {
              message_item: {
                file_item: {
                  file_name: "quoted.pdf",
                  media: {
                    aes_key: "quoted-key",
                    encrypt_query_param: "quoted-param",
                  },
                },
                type: 4,
              },
            },
            text_item: { text: "分析引用附件" },
            type: 1,
          },
          {
            image_item: {
              media: { encrypt_query_param: "main-image" },
            },
            ref_msg: {
              message_item: {
                file_item: {
                  file_name: "must-not-be-duplicated.txt",
                  media: {
                    aes_key: "unused-key",
                    encrypt_query_param: "unused-param",
                  },
                },
                type: 4,
              },
            },
            type: 2,
          },
        ],
        message_id: 8,
      },
      "controller",
    ),
    {
      contextToken: "ctx-reference",
      kind: "text",
      mediaCandidates: [
        {
          displayName: "image.jpg",
          kind: "image",
          media: { encrypt_query_param: "main-image" },
          status: "downloadable",
        },
      ],
      messageId: "8",
      receivedAtMs: 0,
      text: "分析引用附件",
    },
  );
});

test("quoted media is selected only when the main message has no media", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-reference-fallback",
        from_user_id: "controller",
        item_list: [
          {
            ref_msg: {
              message_item: {
                file_item: {
                  file_name: "quoted.pdf",
                  media: {
                    aes_key: "quoted-key",
                    encrypt_query_param: "quoted-param",
                  },
                },
                type: 4,
              },
            },
            text_item: { text: "分析引用附件" },
            type: 1,
          },
        ],
        message_id: 9,
      },
      "controller",
    ),
    {
      contextToken: "ctx-reference-fallback",
      kind: "text",
      mediaCandidates: [
        {
          displayName: "quoted.pdf",
          kind: "file",
          media: {
            aes_key: "quoted-key",
            encrypt_query_param: "quoted-param",
          },
          status: "downloadable",
        },
      ],
      messageId: "9",
      receivedAtMs: 0,
      text: "分析引用附件",
    },
  );
});

test("a quoted voice transcript is preserved as text instead of becoming raw audio", () => {
  assert.deepEqual(
    parseControllerMessage(
      {
        context_token: "ctx-reference-voice",
        from_user_id: "controller",
        item_list: [
          {
            ref_msg: {
              message_item: {
                type: 3,
                voice_item: {
                  media: {
                    aes_key: "must-not-be-returned",
                    encrypt_query_param: "must-not-be-returned",
                  },
                  text: "被引用语音的微信转写",
                },
              },
            },
            text_item: { text: "总结这段语音" },
            type: 1,
          },
        ],
        message_id: 10,
      },
      "controller",
    ),
    {
      contextToken: "ctx-reference-voice",
      kind: "text",
      messageId: "10",
      receivedAtMs: 0,
      text: "[引用语音转写]\n被引用语音的微信转写\n总结这段语音",
    },
  );
});

test("unsafe or incomplete wire identifiers are ignored", () => {
  for (const message of [
    {
      context_token: "ctx",
      from_user_id: "controller",
      item_list: [{ text_item: { text: "x" }, type: 1 }],
    },
    {
      context_token: "ctx",
      from_user_id: "controller",
      item_list: [{ text_item: { text: "x" }, type: 1 }],
      message_id: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      from_user_id: "controller",
      item_list: [{ text_item: { text: "x" }, type: 1 }],
      message_id: 4,
    },
  ]) {
    assert.deepEqual(parseControllerMessage(message, "controller"), {
      kind: "ignored",
    });
  }
});
