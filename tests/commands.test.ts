import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeControlRequest,
  parseInboundText,
  routedControlIntent,
} from "../src/bridge/commands.ts";

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
  assert.deepEqual(parseInboundText("model"), { kind: "models" });
  assert.deepEqual(parseInboundText("model2"), {
    index: 2,
    kind: "selectModel",
  });
  assert.deepEqual(parseInboundText("model:gpt-5.6-sol"), {
    id: "gpt-5.6-sol",
    kind: "selectModel",
  });
  assert.deepEqual(parseInboundText("effort"), { kind: "efforts" });
  assert.deepEqual(parseInboundText("effort4"), {
    index: 4,
    kind: "selectEffort",
  });
  assert.deepEqual(parseInboundText("effort:xhigh"), {
    effort: "xhigh",
    kind: "selectEffort",
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

test("explicit Chinese control requests map to the same command intents", () => {
  const cases: Array<[string, ReturnType<typeof parseInboundText>]> = [
    ["查看项目", { kind: "projects" }],
    ["帮我切换到第二个项目", { index: 2, kind: "selectProject" }],
    ["最近任务", { kind: "sessions", page: "first" }],
    ["下一页任务", { kind: "sessions", page: "next" }],
    ["查看归档任务", { kind: "sessions", page: "archived" }],
    ["打开第 12 个会话", { index: 12, kind: "enterSession" }],
    ["切换会话任务2吧", { index: 2, kind: "enterSession" }],
    ["新建任务", { kind: "newSession" }],
    ["清空当前上下文", { kind: "clearSession" }],
    ["压缩上下文", { kind: "compactSession" }],
    ["停止当前微信回合", { kind: "stopTurn" }],
    ["回到主会话", { kind: "exitSession" }],
    ["看一下当前状态", { kind: "status" }],
    ["权限列表", { kind: "permissions" }],
    ["切换到第3个权限", { index: 3, kind: "selectPermission" }],
    ["有哪些模型", { kind: "models" }],
    ["把当前任务模型换成 gpt-5.6-sol", {
      id: "gpt-5.6-sol",
      kind: "selectModel",
    }],
    ["把当前任务模型换成 Sol", { id: "sol", kind: "selectModel" }],
    ["切换到第二个模型", { index: 2, kind: "selectModel" }],
    ["查看推理强度", { kind: "efforts" }],
    ["推理强度调到 xhigh", {
      effort: "xhigh",
      kind: "selectEffort",
    }],
    ["选择第2个推理强度", { index: 2, kind: "selectEffort" }],
    ["批准当前审批", { code: null, kind: "approve" }],
    ["拒绝审批 A7C9E2", { code: "A7C9E2", kind: "deny" }],
    ["命令列表", { kind: "help" }],
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(parseInboundText(text), expected, text);
  }
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
    "model0",
    "model01",
    "model:",
    "model gpt-5.6-sol",
    "effort0",
    "effort01",
    "effort:",
    "effort:very high",
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
  assert.deepEqual(parseInboundText("model architecture"), {
    kind: "message",
    text: "model architecture",
  });
  assert.deepEqual(parseInboundText("effort estimate"), {
    kind: "message",
    text: "effort estimate",
  });
  for (const text of [
    "查看项目代码有没有问题",
    "帮我新建一个文件",
    "停止开发服务器",
    "清空这个数组",
    "同意这个修改方案",
    "使用 sol 解决这个问题",
    "任务状态字段在哪里定义",
  ]) {
    assert.deepEqual(parseInboundText(text), { kind: "message", text }, text);
  }
});

test("ambiguous control-like text is isolated for AI fallback", () => {
  assert.equal(looksLikeControlRequest("能不能帮我回到之前的任务"), true);
  assert.equal(looksLikeControlRequest("查看项目代码有没有问题"), true);
  assert.equal(looksLikeControlRequest("实现项目状态组件"), false);
  assert.equal(looksLikeControlRequest("停止开发服务器"), false);

  assert.deepEqual(
    routedControlIntent({ index: 2, kind: "enterSession" }),
    { index: 2, kind: "enterSession" },
  );
  assert.deepEqual(
    routedControlIntent({ id: "GPT-5.6-SOL", kind: "selectModel" }),
    { id: "gpt-5.6-sol", kind: "selectModel" },
  );
  assert.equal(routedControlIntent({ index: 0, kind: "selectProject" }), null);
  assert.equal(routedControlIntent({ code: "wrong", kind: "approve" }), null);
  assert.equal(routedControlIntent({ kind: "message" }), null);
});
