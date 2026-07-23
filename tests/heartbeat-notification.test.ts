import assert from "node:assert/strict";
import test from "node:test";

import { heartbeatTerminalDecision } from "../src/daemon/heartbeat-notification.ts";

const heartbeatPrompt = `<heartbeat>
  <automation_id>automation</automation_id>
  <current_time_iso>2026-07-23T07:03:57.770Z</current_time_iso>
  <instructions>
这是一次定时推送测试。触发后请在当前任务中发送：⏰ 定时测试已触发。
  </instructions>
</heartbeat>`;

test("extracts a completed heartbeat NOTIFY message from the exact target turn", () => {
  assert.deepEqual(
    heartbeatTerminalDecision(
      {
        id: "turn-heartbeat",
        items: [
          {
            content: [{ text: heartbeatPrompt, type: "text" }],
            type: "userMessage",
          },
          {
            phase: "final_answer",
            text: `⏰ 定时测试已触发；测试任务已自动删除。

<heartbeat>
  <automation_id>automation</automation_id>
  <decision>NOTIFY</decision>
  <message>⏰ 定时测试已触发。</message>
</heartbeat>`,
            type: "agentMessage",
          },
        ],
      },
      "completed",
    ),
    {
      automationId: "automation",
      kind: "notify",
      message: "⏰ 定时测试已触发。",
    },
  );
});

test("keeps a completed DONT_NOTIFY heartbeat quiet", () => {
  assert.deepEqual(
    heartbeatTerminalDecision(
      heartbeatTurn(`<heartbeat>
  <automation_id>automation</automation_id>
  <decision>DONT_NOTIFY</decision>
  <message>没有需要提醒的更新。</message>
</heartbeat>`),
      "completed",
    ),
    {
      automationId: "automation",
      kind: "quiet",
    },
  );
});

test("does not classify ordinary prose that merely contains a heartbeat tag", () => {
  assert.equal(
    heartbeatTerminalDecision(
      {
        items: [
          {
            content: [
              {
                text: "请解释正文里的 <heartbeat> 标签是什么意思。",
                type: "text",
              },
            ],
            type: "userMessage",
          },
          {
            phase: "final_answer",
            text: "这是普通正文。",
            type: "agentMessage",
          },
        ],
      },
      "completed",
    ),
    null,
  );
});

test("fails closed for malformed or duplicated heartbeat envelopes", () => {
  for (const text of [
    heartbeatPrompt.replace(
      "</automation_id>",
      "</automation_id><automation_id>x</automation_id>",
    ),
    `${heartbeatPrompt}\n${heartbeatPrompt}`,
    heartbeatPrompt.replace(
      "<current_time_iso>",
      "<unexpected></unexpected><current_time_iso>",
    ),
  ]) {
    assert.deepEqual(
      heartbeatTerminalDecision(
        {
          items: [
            {
              content: [{ text, type: "text" }],
              type: "userMessage",
            },
          ],
        },
        "completed",
      ),
      { kind: "invalid" },
    );
  }
});

test("fails closed when a heartbeat turn has multiple user messages or text blocks", () => {
  assert.deepEqual(
    heartbeatTerminalDecision(
      {
        items: [
          {
            content: [{ text: heartbeatPrompt, type: "text" }],
            type: "userMessage",
          },
          {
            content: [{ text: "额外消息", type: "text" }],
            type: "userMessage",
          },
        ],
      },
      "completed",
    ),
    { kind: "invalid" },
  );
  assert.deepEqual(
    heartbeatTerminalDecision(
      {
        items: [
          {
            content: [
              { text: heartbeatPrompt, type: "text" },
              { text: "额外文本块", type: "text" },
            ],
            type: "userMessage",
          },
        ],
      },
      "completed",
    ),
    { kind: "invalid" },
  );
});

test("fails closed when the output id, decision, or final answer is invalid", () => {
  for (const answer of [
    `<heartbeat>
  <automation_id>different</automation_id>
  <decision>NOTIFY</decision>
  <message>不应推送</message>
</heartbeat>`,
    `<heartbeat>
  <automation_id>automation</automation_id>
  <decision>MAYBE</decision>
  <message>不应推送</message>
</heartbeat>`,
    "回答里没有 heartbeat 决策。",
  ]) {
    assert.deepEqual(
      heartbeatTerminalDecision(heartbeatTurn(answer), "completed"),
      { kind: "invalid" },
    );
  }
  assert.deepEqual(
    heartbeatTerminalDecision(
      {
        items: [
          {
            content: [{ text: heartbeatPrompt, type: "text" }],
            type: "userMessage",
          },
          {
            phase: "final_answer",
            text: `<heartbeat>
  <automation_id>automation</automation_id>
  <decision>NOTIFY</decision>
  <message>不应推送</message>
</heartbeat>`,
            type: "agentMessage",
          },
          {
            phase: "final_answer",
            text: "重复的最终回答",
            type: "agentMessage",
          },
        ],
      },
      "completed",
    ),
    { kind: "invalid" },
  );
});

test("waits when a completed heartbeat final answer is not visible yet", () => {
  assert.deepEqual(
    heartbeatTerminalDecision(
      {
        items: [
          {
            content: [{ text: heartbeatPrompt, type: "text" }],
            type: "userMessage",
          },
        ],
      },
      "completed",
    ),
    {
      kind: "pending",
    },
  );
  assert.deepEqual(
    heartbeatTerminalDecision(
      {
        items: [],
        itemsView: "notLoaded",
      },
      "completed",
    ),
    { kind: "pending" },
  );
});

test("recognizes failed and interrupted heartbeat turns from the strict input", () => {
  for (const status of ["failed", "interrupted"] as const) {
    assert.deepEqual(
      heartbeatTerminalDecision(
        {
          items: [
            {
              content: [{ text: heartbeatPrompt, type: "text" }],
              type: "userMessage",
            },
          ],
        },
        status,
      ),
      {
        automationId: "automation",
        kind: "notify",
      },
    );
  }
});

function heartbeatTurn(finalAnswer: string): Record<string, unknown> {
  return {
    id: "turn-heartbeat",
    items: [
      {
        content: [{ text: heartbeatPrompt, type: "text" }],
        type: "userMessage",
      },
      {
        phase: "final_answer",
        text: finalAnswer,
        type: "agentMessage",
      },
    ],
  };
}
