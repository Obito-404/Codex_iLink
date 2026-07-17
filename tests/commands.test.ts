import assert from "node:assert/strict";
import test from "node:test";

import { parseInboundText } from "../src/bridge/commands.ts";

test("the documented short command table is parsed exactly", () => {
  assert.deepEqual(parseInboundText("p"), { kind: "projects" });
  assert.deepEqual(parseInboundText("p2"), {
    index: 2,
    kind: "selectProject",
  });
  assert.deepEqual(parseInboundText("s"), {
    kind: "sessions",
    page: "first",
  });
  assert.deepEqual(parseInboundText("s+"), {
    kind: "sessions",
    page: "next",
  });
  assert.deepEqual(parseInboundText("sarc"), {
    kind: "sessions",
    page: "archived",
  });
  assert.deepEqual(parseInboundText("s10"), {
    index: 10,
    kind: "enterSession",
  });
  assert.deepEqual(parseInboundText("new"), { kind: "newSession" });
  assert.deepEqual(parseInboundText("clear"), { kind: "clearSession" });
  assert.deepEqual(parseInboundText("compact"), { kind: "compactSession" });
  assert.deepEqual(parseInboundText("stop"), { kind: "stopTurn" });
  assert.deepEqual(parseInboundText("exit"), { kind: "exitSession" });
  assert.deepEqual(parseInboundText("st"), { kind: "status" });
  assert.deepEqual(parseInboundText("perm"), { kind: "permissions" });
  assert.deepEqual(parseInboundText("perm3"), {
    index: 3,
    kind: "selectPermission",
  });
  assert.deepEqual(parseInboundText("ok"), {
    code: null,
    kind: "approve",
  });
  assert.deepEqual(parseInboundText("noa7c9e2"), {
    code: "A7C9E2",
    kind: "deny",
  });
  assert.deepEqual(parseInboundText("help"), { kind: "help" });
});

test("legacy slash commands, spaced forms, aliases and malformed indices are rejected", () => {
  for (const text of [
    "/p",
    "/st",
    "p 1",
    "s 1",
    "perm 3",
    "ok 3",
    "ok1",
    "no123456",
    "okA7C9E",
    "noA7C9E20",
    "/stop",
    "/status",
    "/项目",
    "go1",
    "s0",
    "s-1",
    "s1.5",
    "p01",
    "perm0",
    "perm01",
  ]) {
    assert.deepEqual(parseInboundText(text), { kind: "unknownCommand", text });
  }
});

test("ordinary text stays ordinary and preserves its content", () => {
  assert.deepEqual(parseInboundText("继续这个任务"), {
    kind: "message",
    text: "继续这个任务",
  });
  assert.deepEqual(parseInboundText("  保留两侧空格  "), {
    kind: "message",
    text: "  保留两侧空格  ",
  });
  assert.deepEqual(parseInboundText("new task question"), {
    kind: "message",
    text: "new task question",
  });
  assert.deepEqual(parseInboundText("okay"), {
    kind: "message",
    text: "okay",
  });
  assert.deepEqual(parseInboundText("notice"), {
    kind: "message",
    text: "notice",
  });
  assert.deepEqual(parseInboundText("good morning"), {
    kind: "message",
    text: "good morning",
  });
  assert.deepEqual(parseInboundText("permission issue"), {
    kind: "message",
    text: "permission issue",
  });
  assert.deepEqual(parseInboundText("permfull"), {
    kind: "message",
    text: "permfull",
  });
});
