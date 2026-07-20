import { createHash, randomBytes, randomInt } from "node:crypto";

import type { CodexEvent } from "./bridge.ts";

export type ApprovalDecisionResult =
  | { approvals: PendingApproval[]; kind: "ambiguous" }
  | { code: string; kind: "decided" }
  | { code: string | null; kind: "not-found" };

export type PendingApproval = {
  code: string;
  deliveryAttempts: number;
  deliveryStatus: "delivered" | "pending" | "retrying";
  expiresAtMs: number;
  method: ApprovalMethod;
  reminderCount: number;
  summary: string;
  threadId: string;
  turnId: string;
};

export type ApprovalCoordinatorOptions = {
  isLive?: (id: number | string) => boolean;
  notify: (text: string, clientId: string) => Promise<void>;
  now: () => number;
  onExpired?: (
    approval: PendingApproval,
    reason: "request-lost" | "timeout",
  ) => void;
  respond: (
    id: number | string,
    result: Record<string, unknown>,
  ) => boolean | void;
  sleep?: (milliseconds: number) => Promise<void>;
  reminderDelaysMs?: readonly number[];
  reminderSleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
};

type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval";

export type LiveApprovalCallbackInput = {
  isLive: () => boolean;
  method: ApprovalMethod;
  params: Record<string, unknown>;
  respond: (approved: boolean) => boolean | void;
};

type ApprovalCallback = Pick<
  LiveApprovalCallbackInput,
  "isLive" | "respond"
>;

type LiveApproval = PendingApproval & {
  callbacks: ApprovalCallback[];
  notificationText: string;
  params: Record<string, unknown>;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_REMINDER_DELAYS_MS = [60_000, 5 * 60_000] as const;
const APPROVAL_METHODS = new Set<ApprovalMethod>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/**
 * Holds only live App Server or Desktop Hook callbacks. Nothing here is durable:
 * after a restart there is no safe callback to which an old approval can be
 * replayed, so close() declines every still-live request.
 */
export class ApprovalCoordinator {
  readonly #isLive: NonNullable<ApprovalCoordinatorOptions["isLive"]>;
  readonly #live = new Map<string, LiveApproval>();
  readonly #notify: ApprovalCoordinatorOptions["notify"];
  readonly #now: ApprovalCoordinatorOptions["now"];
  readonly #onExpired: ApprovalCoordinatorOptions["onExpired"];
  readonly #respond: ApprovalCoordinatorOptions["respond"];
  readonly #reminderDelaysMs: readonly number[];
  readonly #reminderSleep: NonNullable<
    ApprovalCoordinatorOptions["reminderSleep"]
  >;
  readonly #sleep: NonNullable<ApprovalCoordinatorOptions["sleep"]>;
  readonly #timeoutMs: number;
  readonly #usedCodes = new Set<string>();

  constructor(options: ApprovalCoordinatorOptions) {
    this.#isLive = options.isLive ?? (() => true);
    this.#notify = options.notify;
    this.#now = options.now;
    this.#onExpired = options.onExpired;
    this.#respond = options.respond;
    this.#reminderDelaysMs =
      options.reminderDelaysMs ?? DEFAULT_REMINDER_DELAYS_MS;
    this.#reminderSleep = options.reminderSleep ?? retrySleep;
    this.#sleep = options.sleep ?? retrySleep;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ingest(event: CodexEvent & { id?: number | string }): Promise<boolean> {
    if (!isApprovalMethod(event.method) || event.id === undefined) return false;
    const id = event.id;
    const method = event.method;
    return this.ingestCallback({
      isLive: () => this.#isLive(id),
      method,
      params: event.params,
      respond: (approved) =>
        this.#respond(
          id,
          approved
            ? approvalResult(method, event.params)
            : denialResult(method),
        ),
    });
  }

  async ingestCallback(input: LiveApprovalCallbackInput): Promise<boolean> {
    const { method, params } = input;
    const threadId = stringField(params, "threadId");
    const turnId = stringField(params, "turnId");
    const itemId = stringField(params, "itemId");
    if (!threadId || !turnId || !itemId) return false;
    if (!input.isLive()) return true;

    this.expire();
    const existing = [...this.#live.values()].find(
      (approval) =>
        approval.method === method &&
        approval.threadId === threadId &&
        approval.turnId === turnId &&
        stringField(approval.params, "itemId") === itemId,
    );
    if (existing) {
      existing.callbacks.push({
        isLive: input.isLive,
        respond: input.respond,
      });
      return true;
    }
    const code = this.#newCode();
    const timer = setTimeout(() => this.#expireCode(code), this.#timeoutMs);
    timer.unref();
    const approval: LiveApproval = {
      code,
      callbacks: [{ isLive: input.isLive, respond: input.respond }],
      deliveryAttempts: 0,
      deliveryStatus: "pending",
      expiresAtMs: this.#now() + this.#timeoutMs,
      method,
      notificationText: "",
      params,
      reminderCount: 0,
      summary: approvalSummary(method, params),
      timer,
      threadId,
      turnId,
    };
    approval.notificationText = approvalNotification(
      approval,
      [...this.#live.values()],
    );
    this.#live.set(code, approval);
    await this.#deliver(code);
    this.#scheduleReminders(code);
    if (!this.#approvalIsLive(approval) && this.#live.get(code) === approval) {
      this.#live.delete(code);
      clearTimeout(timer);
      this.#emitExpired(approval, "request-lost");
    }
    return true;
  }

  decide(code: string | null, approved: boolean): ApprovalDecisionResult {
    this.expire();
    if (code === null && this.#live.size > 1) {
      return { approvals: this.list(), kind: "ambiguous" };
    }
    const normalizedCode = code?.toUpperCase() ?? this.#live.keys().next().value;
    if (typeof normalizedCode !== "string") {
      return { code, kind: "not-found" };
    }
    const approval = this.#live.get(normalizedCode);
    if (!approval) return { code: normalizedCode, kind: "not-found" };
    this.#live.delete(normalizedCode);
    clearTimeout(approval.timer);
    const responded = this.#respondToApproval(approval, approved);
    return responded === false
      ? { code: normalizedCode, kind: "not-found" }
      : { code: normalizedCode, kind: "decided" };
  }

  expire(nowMs = this.#now()): number {
    let expired = 0;
    for (const [code, approval] of this.#live) {
      if (!this.#approvalIsLive(approval)) {
        this.#live.delete(code);
        clearTimeout(approval.timer);
        this.#emitExpired(approval, "request-lost");
        expired += 1;
        continue;
      }
      if (approval.expiresAtMs > nowMs) continue;
      this.#live.delete(code);
      clearTimeout(approval.timer);
      this.#respondToApproval(approval, false);
      this.#emitExpired(approval, "timeout");
      expired += 1;
    }
    return expired;
  }

  list(): PendingApproval[] {
    this.expire();
    return [...this.#live.values()]
      .map(
        ({
          callbacks: _callbacks,
          notificationText: _notificationText,
          params: _params,
          timer: _timer,
          ...approval
        }) => approval,
      );
  }

  close(): void {
    for (const approval of this.#live.values()) {
      clearTimeout(approval.timer);
      if (this.#approvalIsLive(approval)) {
        this.#respondToApproval(approval, false);
      }
      this.#emitExpired(approval, "request-lost");
    }
    this.#live.clear();
  }

  #expireCode(code: string): void {
    const approval = this.#live.get(code);
    if (!approval) return;
    this.#live.delete(code);
    clearTimeout(approval.timer);
    const live = this.#approvalIsLive(approval);
    if (live) {
      this.#respondToApproval(approval, false);
    }
    this.#emitExpired(approval, live ? "timeout" : "request-lost");
  }

  async #deliver(code: string): Promise<void> {
    const approval = this.#live.get(code);
    if (!approval) return;
    if (!this.#approvalIsLive(approval)) {
      this.#live.delete(code);
      clearTimeout(approval.timer);
      this.#emitExpired(approval, "request-lost");
      return;
    }
    if (approval.expiresAtMs <= this.#now()) {
      this.#expireCode(code);
      return;
    }

    approval.deliveryAttempts += 1;
    try {
      await this.#notify(
        approval.notificationText,
        approvalClientId(approval),
      );
      if (this.#live.get(code) === approval) {
        approval.deliveryStatus = "delivered";
      }
    } catch {
      if (this.#live.get(code) !== approval) {
        return;
      }
      if (!this.#approvalIsLive(approval)) {
        this.#live.delete(code);
        clearTimeout(approval.timer);
        this.#emitExpired(approval, "request-lost");
        return;
      }
      approval.deliveryStatus = "retrying";
      const delayMs = Math.min(
        30_000,
        1_000 * 2 ** Math.min(approval.deliveryAttempts - 1, 5),
      );
      void this.#sleep(delayMs)
        .then(() => this.#deliver(code))
        .catch(() => undefined);
    }
  }

  #scheduleReminders(code: string): void {
    for (const [index, delayMs] of this.#reminderDelaysMs.entries()) {
      if (delayMs <= 0 || delayMs >= this.#timeoutMs) continue;
      void this.#reminderSleep(delayMs)
        .then(() => this.#deliverReminder(code, index + 1))
        .catch(() => undefined);
    }
  }

  async #deliverReminder(
    code: string,
    reminderNumber: number,
    attempt = 1,
  ): Promise<void> {
    const approval = this.#live.get(code);
    if (!approval || !this.#approvalIsLive(approval)) return;
    if (approval.expiresAtMs <= this.#now()) {
      this.#expireCode(code);
      return;
    }
    try {
      await this.#notify(
        approvalReminder(approval, this.#live.size > 1),
        `${approvalClientId(approval)}:reminder:${String(reminderNumber)}`,
      );
      if (this.#live.get(code) === approval) {
        approval.reminderCount = Math.max(
          approval.reminderCount,
          reminderNumber,
        );
      }
    } catch {
      if (this.#live.get(code) !== approval || !this.#approvalIsLive(approval)) {
        return;
      }
      const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
      void this.#sleep(delayMs)
        .then(() => this.#deliverReminder(code, reminderNumber, attempt + 1))
        .catch(() => undefined);
    }
  }

  #newCode(): string {
    for (;;) {
      const code = `${"ABCDEF"[randomInt(6)]}${randomBytes(3)
        .toString("hex")
        .slice(0, 5)}`.toUpperCase();
      if (this.#usedCodes.has(code)) continue;
      this.#usedCodes.add(code);
      return code;
    }
  }

  #approvalIsLive(approval: LiveApproval): boolean {
    return approval.callbacks.some((callback) => callback.isLive());
  }

  #respondToApproval(approval: LiveApproval, approved: boolean): boolean {
    let responded = false;
    for (const callback of approval.callbacks) {
      if (!callback.isLive()) continue;
      if (callback.respond(approved) !== false) responded = true;
    }
    return responded;
  }

  #emitExpired(
    approval: LiveApproval,
    reason: "request-lost" | "timeout",
  ): void {
    try {
      this.#onExpired?.(
        {
          deliveryAttempts: approval.deliveryAttempts,
          deliveryStatus: approval.deliveryStatus,
          expiresAtMs: approval.expiresAtMs,
          code: approval.code,
          method: approval.method,
          reminderCount: approval.reminderCount,
          summary: approval.summary,
          threadId: approval.threadId,
          turnId: approval.turnId,
        },
        reason,
      );
    } catch {
      // Expiry is final; an optional diagnostic callback cannot revive it.
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
  const details = [
    stringField(params, "reason"),
    stringField(params, "command"),
    stringField(params, "cwd"),
  ].filter((value): value is string => Boolean(value));
  const reason = truncate(
    [...new Set(details)].join(" | ") ||
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

function approvalNotification(
  approval: PendingApproval,
  existingApprovals: readonly PendingApproval[],
): string {
  if (existingApprovals.length === 0) {
    return `需要批准\n${approval.summary}\n回复：ok 或 no`;
  }
  return [
    "当前有多个待审批：",
    ...existingApprovals.map(
      (existing) => `${existing.code}：${existing.summary}`,
    ),
    `${approval.code}：${approval.summary}`,
    "回复：ok<code> 或 no<code>",
  ].join("\n");
}

function approvalReminder(
  approval: PendingApproval,
  multiple: boolean,
): string {
  return multiple
    ? [
        "⏳ 仍在等待审批",
        `${approval.code}：${approval.summary}`,
        `回复：ok${approval.code} 或 no${approval.code}`,
      ].join("\n")
    : ["⏳ 仍在等待审批", approval.summary, "回复：ok 或 no"].join("\n");
}

function approvalClientId(approval: LiveApproval): string {
  const itemId = stringField(approval.params, "itemId") ?? "unknown";
  const identity = [
    approval.method,
    approval.threadId,
    approval.turnId,
    itemId,
  ].join("\0");
  const suffix = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
  return `codex-ilink:approval:${suffix}`;
}

function retrySleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
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
