import assert from "node:assert/strict";
import test from "node:test";

import { parseInboundText } from "../src/bridge/commands.ts";

test("the documented short command table is parsed exactly", () => {
  assert.deepEqual(parseInboundText("/p"), { kind: "projects" });
  assert.deepEqual(parseInboundText("/p 2"), {
    index: 2,
    kind: "selectProject",
  });
  assert.deepEqual(parseInboundText("/s"), {
    kind: "sessions",
    page: "first",
  });
  assert.deepEqual(parseInboundText("/s +"), {
    kind: "sessions",
    page: "next",
  });
  assert.deepEqual(parseInboundText("/s arc"), {
    kind: "sessions",
    page: "archived",
  });
  assert.deepEqual(parseInboundText("/s 10"), {
    index: 10,
    kind: "enterSession",
  });
  assert.deepEqual(parseInboundText("/new"), { kind: "newSession" });
  assert.deepEqual(parseInboundText("/exit"), { kind: "exitSession" });
  assert.deepEqual(parseInboundText("/st"), { kind: "status" });
  assert.deepEqual(parseInboundText("/ok 3"), {
    index: 3,
    kind: "approve",
  });
  assert.deepEqual(parseInboundText("/no 4"), {
    index: 4,
    kind: "deny",
  });
  assert.deepEqual(parseInboundText("/help"), { kind: "help" });
});

test("aliases, Chinese commands and malformed indices are not guessed", () => {
  for (const text of [
    "/stop",
    "/status",
    "/项目",
    "/go 1",
    "/s 0",
    "/s -1",
    "/s 1.5",
    "/p 01",
    "/new now",
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
});
