import { win32 } from "node:path";

export type DurableTurnAttachment = {
  kind: "file" | "image" | "video";
  name: string;
  path: string;
};

export type DurableTurnInput = {
  attachments: DurableTurnAttachment[];
  text: string;
  version: 1;
};

export type DurableInboundFailureCode =
  | "download-failed"
  | "invalid-media"
  | "too-large"
  | "unsupported-media"
  | "voice-transcript-missing";

const DURABLE_INBOUND_FAILURE_CODES = new Set<DurableInboundFailureCode>([
  "download-failed",
  "invalid-media",
  "too-large",
  "unsupported-media",
  "voice-transcript-missing",
]);

export function serializeDurableTurnInput(input: DurableTurnInput): string {
  assertDurableTurnInput(input);
  return JSON.stringify(input);
}

export function parseDurableTurnInput(body: string): DurableTurnInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalidTurnInput();
  }
  assertDurableTurnInput(parsed);
  return parsed;
}

export function serializeDurableInboundFailure(
  code: DurableInboundFailureCode,
): string {
  if (!DURABLE_INBOUND_FAILURE_CODES.has(code)) throw invalidTurnInput();
  return JSON.stringify({ code, kind: "failure", version: 1 });
}

export function parseDurableInboundFailure(
  body: string,
): DurableInboundFailureCode | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.kind !== "failure" ||
    parsed.version !== 1 ||
    typeof parsed.code !== "string" ||
    !DURABLE_INBOUND_FAILURE_CODES.has(
      parsed.code as DurableInboundFailureCode,
    )
  ) {
    return null;
  }
  return parsed.code as DurableInboundFailureCode;
}

function assertDurableTurnInput(value: unknown): asserts value is DurableTurnInput {
  if (!isRecord(value) || value.version !== 1 || typeof value.text !== "string") {
    throw invalidTurnInput();
  }
  if (!Array.isArray(value.attachments)) throw invalidTurnInput();
  if (value.text.trim().length === 0 && value.attachments.length === 0) {
    throw invalidTurnInput();
  }
  for (const attachment of value.attachments) {
    if (
      !isRecord(attachment) ||
      (attachment.kind !== "image" &&
        attachment.kind !== "file" &&
        attachment.kind !== "video") ||
      typeof attachment.name !== "string" ||
      attachment.name.length === 0 ||
      attachment.name.length > 255 ||
      typeof attachment.path !== "string" ||
      !win32.isAbsolute(attachment.path)
    ) {
      throw invalidTurnInput();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTurnInput(): Error {
  return new Error("E_TURN_INPUT_INVALID");
}
