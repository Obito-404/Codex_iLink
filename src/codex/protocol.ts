export type JsonObject = Record<string, unknown>;

export type CodexOutcomeUnknownReason = "eof" | "timeout";

export class CodexOutcomeUnknownError extends Error {
  readonly kind = "outcome-unknown";
  readonly method: string;
  readonly reason: CodexOutcomeUnknownReason;

  constructor(method: string, reason: CodexOutcomeUnknownReason) {
    super(`${method} outcome is unknown after ${reason}`);
    this.name = "CodexOutcomeUnknownError";
    this.method = method;
    this.reason = reason;
  }
}

export type AppServerCommand = readonly [string, ...string[]];

export type AppServerEvent = {
  id?: number | string;
  method: string;
  params: JsonObject;
};

export type AppServerEventListener = (event: AppServerEvent) => void;

export type ThreadListResult = JsonObject & {
  data: unknown[];
  nextCursor: string | null;
};

export type PermissionProfileSummary = JsonObject & {
  allowed: boolean;
  description?: string | null;
  id: string;
};

export type PermissionProfileListResult = JsonObject & {
  data: PermissionProfileSummary[];
  nextCursor: string | null;
};

export type ModelSummary = JsonObject & {
  defaultReasoningEffort: string;
  displayName: string;
  hidden: boolean;
  id: string;
  model: string;
  supportedReasoningEfforts: Array<
    JsonObject & { description: string; reasoningEffort: string }
  >;
};

export type ModelListResult = JsonObject & {
  data: ModelSummary[];
  nextCursor: string | null;
};

export type CodexThread = JsonObject & { id: string };
export type CodexTurn = JsonObject & { id: string };

export type ThreadReadResult = JsonObject & { thread: CodexThread };
export type ThreadResumeResult = JsonObject & { thread: CodexThread };
export type ThreadStartResult = JsonObject & { thread: CodexThread };
export type ThreadUnarchiveResult = JsonObject & { thread: CodexThread };

export type TurnStartResult = JsonObject & { turn: CodexTurn };
