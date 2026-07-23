export type HeartbeatTerminalDecision =
  | {
      automationId: string;
      kind: "notify";
      message?: string;
    }
  | {
      automationId: string;
      kind: "quiet";
    }
  | {
      kind: "pending";
    }
  | {
      kind: "invalid";
    };

type TerminalStatus = "completed" | "failed" | "interrupted";

const MAX_AUTOMATION_ID_CHARACTERS = 256;
const MAX_HEARTBEAT_MESSAGE_CHARACTERS = 16_000;
const HEARTBEAT_INPUT =
  /^\s*<heartbeat>\s*<automation_id>([^<>\r\n]+)<\/automation_id>\s*<current_time_iso>([^<>\r\n]+)<\/current_time_iso>\s*<instructions>([\s\S]*?)<\/instructions>\s*<\/heartbeat>\s*$/u;
const HEARTBEAT_OUTPUT =
  /<heartbeat>\s*<automation_id>([^<>\r\n]+)<\/automation_id>\s*<decision>(NOTIFY|DONT_NOTIFY)<\/decision>(?:\s*<message>([\s\S]*?)<\/message>)?\s*<\/heartbeat>\s*$/u;

export function heartbeatTerminalDecision(
  rawTurn: unknown,
  status: TerminalStatus,
): HeartbeatTerminalDecision | null {
  const turn = asObject(rawTurn);
  if (!turn) return null;
  if (typeof turn.itemsView === "string" && turn.itemsView !== "full") {
    return { kind: "pending" };
  }
  if (!Array.isArray(turn.items)) return null;

  const userMessages = turn.items
    .map(asObject)
    .filter(
      (item): item is Record<string, unknown> => item?.type === "userMessage",
    );
  if (userMessages.length !== 1) {
    return userMessages.some(heartbeatCandidate) ? { kind: "invalid" } : null;
  }

  const userMessage = userMessages[0];
  if (!userMessage) return null;
  const prompt = exactUserMessageText(userMessage);
  if (prompt === null) {
    return heartbeatCandidate(userMessage) ? { kind: "invalid" } : null;
  }
  const heartbeat = parseHeartbeatInput(prompt);
  if (!heartbeat) {
    return startsWithHeartbeatEnvelope(prompt) ? { kind: "invalid" } : null;
  }

  if (status !== "completed") {
    return { automationId: heartbeat.automationId, kind: "notify" };
  }

  const finalAnswers = turn.items
    .map(asObject)
    .filter(
      (item): item is Record<string, unknown> =>
        item?.type === "agentMessage" && item.phase === "final_answer",
    );
  if (finalAnswers.length === 0) {
    return { kind: "pending" };
  }
  if (finalAnswers.length !== 1) return { kind: "invalid" };
  const finalAnswerItem = finalAnswers[0];
  if (!finalAnswerItem) {
    return { kind: "pending" };
  }
  const finalAnswer = stringField(finalAnswerItem, "text");
  if (!finalAnswer) {
    return { kind: "pending" };
  }

  const output = parseHeartbeatOutput(finalAnswer);
  if (!output || output.automationId !== heartbeat.automationId) {
    return { kind: "invalid" };
  }
  if (output.decision === "DONT_NOTIFY") {
    return { automationId: heartbeat.automationId, kind: "quiet" };
  }
  return {
    automationId: heartbeat.automationId,
    kind: "notify",
    message: output.message,
  };
}

function parseHeartbeatInput(
  value: string,
): { automationId: string } | null {
  if (
    tagCount(value, "<heartbeat>") !== 1 ||
    tagCount(value, "</heartbeat>") !== 1
  ) {
    return null;
  }
  const match = HEARTBEAT_INPUT.exec(value);
  const automationId = match?.[1]?.trim() ?? "";
  const currentTime = match?.[2]?.trim() ?? "";
  const instructions = match?.[3]?.trim() ?? "";
  if (
    !validAutomationId(automationId) ||
    !validIsoTime(currentTime) ||
    instructions.length === 0
  ) {
    return null;
  }
  return { automationId };
}

function parseHeartbeatOutput(
  value: string,
): {
  automationId: string;
  decision: "DONT_NOTIFY" | "NOTIFY";
  message: string;
} | null {
  if (
    tagCount(value, "<heartbeat>") !== 1 ||
    tagCount(value, "</heartbeat>") !== 1
  ) {
    return null;
  }
  const match = HEARTBEAT_OUTPUT.exec(value);
  const automationId = match?.[1]?.trim() ?? "";
  const decision = match?.[2];
  const message = match?.[3]?.trim() ?? null;
  if (
    !validAutomationId(automationId) ||
    (decision !== "NOTIFY" && decision !== "DONT_NOTIFY") ||
    message === null ||
    message.length === 0 ||
    [...message].length > MAX_HEARTBEAT_MESSAGE_CHARACTERS
  ) {
    return null;
  }
  return { automationId, decision, message };
}

function exactUserMessageText(
  item: Record<string, unknown>,
): string | null {
  if (!Array.isArray(item.content) || item.content.length !== 1) return null;
  const block = asObject(item.content[0]);
  return block?.type === "text" ? stringField(block, "text") : null;
}

function heartbeatCandidate(item: Record<string, unknown>): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some((rawBlock) => {
    const block = asObject(rawBlock);
    return (
      block?.type === "text" &&
      typeof block.text === "string" &&
      startsWithHeartbeatEnvelope(block.text)
    );
  });
}

function startsWithHeartbeatEnvelope(value: string): boolean {
  return value.trimStart().startsWith("<heartbeat");
}

function validAutomationId(value: string): boolean {
  return (
    [...value].length <= MAX_AUTOMATION_ID_CHARACTERS &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function validIsoTime(value: string): boolean {
  return (
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function tagCount(value: string, tag: string): number {
  return value.split(tag).length - 1;
}

function stringField(
  value: Record<string, unknown>,
  name: string,
): string | null {
  const field = value[name];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
