import type { CodexEvent } from "./bridge.ts";

export type ApprovalDecisionResult =
  | { kind: "decided"; index: number }
  | { kind: "not-found"; index: number };

export type PendingApproval = {
  expiresAtMs: number;
  index: number;
  method: ApprovalMethod;
  summary: string;
  threadId: string;
  turnId: string;
};

export type ApprovalCoordinatorOptions = {
  isLive?: (id: number | string) => boolean;
  notify: (text: string, clientId: string) => Promise<void>;
  now: () => number;
  respond: (
    id: number | string,
    result: Record<string, unknown>,
  ) => boolean | void;
  timeoutMs?: number;
};

type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval";

type LiveApproval = PendingApproval & {
  id: number | string;
  params: Record<string, unknown>;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const APPROVAL_METHODS = new Set<ApprovalMethod>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/**
 * Holds only live App Server callbacks. Deliberately nothing here is durable:
 * after a restart there is no safe callback to which an old approval can be
 * replayed, so close() declines every still-live request.
 */
export class ApprovalCoordinator {
  readonly #isLive: NonNullable<ApprovalCoordinatorOptions["isLive"]>;
  readonly #live = new Map<number, LiveApproval>();
  readonly #notify: ApprovalCoordinatorOptions["notify"];
  readonly #now: ApprovalCoordinatorOptions["now"];
  readonly #respond: ApprovalCoordinatorOptions["respond"];
  readonly #timeoutMs: number;
  #nextIndex = 1;

  constructor(options: ApprovalCoordinatorOptions) {
    this.#isLive = options.isLive ?? (() => true);
    this.#notify = options.notify;
    this.#now = options.now;
    this.#respond = options.respond;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ingest(event: CodexEvent & { id?: number | string }): Promise<boolean> {
    if (!isApprovalMethod(event.method) || event.id === undefined) return false;
    const threadId = stringField(event.params, "threadId");
    const turnId = stringField(event.params, "turnId");
    const itemId = stringField(event.params, "itemId");
    if (!threadId || !turnId || !itemId) return false;
    if (!this.#isLive(event.id)) return true;

    this.expire();
    const index = this.#nextIndex++;
    const timer = setTimeout(() => this.#expireIndex(index), this.#timeoutMs);
    timer.unref();
    const approval: LiveApproval = {
      expiresAtMs: this.#now() + this.#timeoutMs,
      id: event.id,
      index,
      method: event.method,
      params: event.params,
      summary: approvalSummary(event.method, event.params),
      timer,
      threadId,
      turnId,
    };
    this.#live.set(index, approval);
    try {
      await this.#notify(
        `Approval #${index}\n${approval.summary}\n/ok ${index} | /no ${index}`,
        `codex-ilink:approval:${turnId}:${itemId}`,
      );
    } catch (error) {
      this.#live.delete(index);
      clearTimeout(timer);
      this.#respond(event.id, denialResult(event.method));
      throw error;
    }
    if (!this.#isLive(event.id) && this.#live.get(index) === approval) {
      this.#live.delete(index);
      clearTimeout(timer);
    }
    return true;
  }

  decide(index: number, approved: boolean): ApprovalDecisionResult {
    this.expire();
    const approval = this.#live.get(index);
    if (!approval) return { index, kind: "not-found" };
    this.#live.delete(index);
    clearTimeout(approval.timer);
    const responded = this.#respond(
      approval.id,
      approved
        ? approvalResult(approval.method, approval.params)
        : denialResult(approval.method),
    );
    return responded === false
      ? { index, kind: "not-found" }
      : { index, kind: "decided" };
  }

  expire(nowMs = this.#now()): number {
    let expired = 0;
    for (const [index, approval] of this.#live) {
      if (!this.#isLive(approval.id)) {
        this.#live.delete(index);
        clearTimeout(approval.timer);
        expired += 1;
        continue;
      }
      if (approval.expiresAtMs > nowMs) continue;
      this.#live.delete(index);
      clearTimeout(approval.timer);
      this.#respond(approval.id, denialResult(approval.method));
      expired += 1;
    }
    return expired;
  }

  list(): PendingApproval[] {
    this.expire();
    return [...this.#live.values()]
      .sort((left, right) => left.index - right.index)
      .map(({ id: _id, params: _params, timer: _timer, ...approval }) =>
        approval,
      );
  }

  close(): void {
    for (const approval of this.#live.values()) {
      clearTimeout(approval.timer);
      if (this.#isLive(approval.id)) {
        this.#respond(approval.id, denialResult(approval.method));
      }
    }
    this.#live.clear();
  }

  #expireIndex(index: number): void {
    const approval = this.#live.get(index);
    if (!approval) return;
    this.#live.delete(index);
    if (this.#isLive(approval.id)) {
      this.#respond(approval.id, denialResult(approval.method));
    }
  }
}

function isApprovalMethod(method: string): method is ApprovalMethod {
  return APPROVAL_METHODS.has(method as ApprovalMethod);
}

function approvalResult(
  method: ApprovalMethod,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    const permissions = recordField(params, "permissions") ?? {};
    return { permissions, scope: "turn" };
  }
  return { decision: "accept" };
}

function denialResult(method: ApprovalMethod): Record<string, unknown> {
  return method === "item/permissions/requestApproval"
    ? { permissions: {}, scope: "turn" }
    : { decision: "decline" };
}

function approvalSummary(
  method: ApprovalMethod,
  params: Record<string, unknown>,
): string {
  const reason = truncate(
    stringField(params, "reason") ??
      stringField(params, "command") ??
      stringField(params, "cwd") ??
      "Codex requests additional permission",
  );
  const label =
    method === "item/commandExecution/requestApproval"
      ? "Command"
      : method === "item/fileChange/requestApproval"
        ? "File change"
        : "Permission";
  return `${label}: ${reason}`;
}

function truncate(value: string): string {
  return [...value].slice(0, 500).join("");
}

function stringField(
  value: Record<string, unknown>,
  name: string,
): string | null {
  const field = value[name];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function recordField(
  value: Record<string, unknown>,
  name: string,
): Record<string, unknown> | null {
  const field = value[name];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}
