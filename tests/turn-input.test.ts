import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDurableInboundFailure,
  parseDurableTurnInput,
  serializeDurableInboundFailure,
  serializeDurableTurnInput,
} from "../src/bridge/turn-input.ts";

test("durable turn input round-trips text and media paths", () => {
  const input = {
    attachments: [
      { kind: "image" as const, name: "photo.jpg", path: "C:\\Media\\photo.jpg" },
      { kind: "file" as const, name: "report.pdf", path: "C:\\Media\\report.pdf" },
      { kind: "video" as const, name: "clip.mp4", path: "C:\\Media\\clip.mp4" },
    ],
    text: "请分析这些附件",
    version: 1 as const,
  };

  assert.deepEqual(parseDurableTurnInput(serializeDurableTurnInput(input)), input);
});

test("durable turn input supports attachment-only turns", () => {
  const input = {
    attachments: [
      { kind: "image" as const, name: "photo.png", path: "D:\\Inbox\\photo.png" },
    ],
    text: "",
    version: 1 as const,
  };

  assert.deepEqual(parseDurableTurnInput(serializeDurableTurnInput(input)), input);
});

test("durable turn input rejects legacy text and unsafe payloads", () => {
  for (const body of [
    "legacy plain text",
    JSON.stringify({ attachments: [], text: "", version: 1 }),
    JSON.stringify({
      attachments: [{ kind: "file", name: "x", path: "..\\secret.txt" }],
      text: "x",
      version: 1,
    }),
    JSON.stringify({
      attachments: [{ kind: "audio", name: "voice.silk", path: "C:\\voice.silk" }],
      text: "x",
      version: 1,
    }),
  ]) {
    assert.throws(() => parseDurableTurnInput(body), /E_TURN_INPUT_INVALID/u);
  }
});

test("durable inbound failures preserve only a bounded public category", () => {
  for (const code of [
    "download-failed",
    "invalid-media",
    "too-large",
    "unsupported-media",
    "voice-transcript-missing",
  ] as const) {
    assert.equal(
      parseDurableInboundFailure(serializeDurableInboundFailure(code)),
      code,
    );
  }
  assert.equal(parseDurableInboundFailure("not-json"), null);
  assert.equal(
    parseDurableInboundFailure(
      JSON.stringify({ code: "credential=secret", kind: "failure", version: 1 }),
    ),
    null,
  );
});
