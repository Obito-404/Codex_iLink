import { createHash, randomBytes, randomInt } from "node:crypto";

import type { CodexEvent } from "./bridge.ts";

export type ApprovalDecisionResult =
  | { approvals: PendingApproval[]; kind: "ambiguous" }
  | { code: string; kind: "decided" }
  | { code: string | null; kind: "not-found" };

export type ApprovalBatchDecisionResult = {
  attempted: number;
  decided: number;
};

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
  payloadFingerprint: string;
  requestIdentity: string;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_REMINDER_DELAYS_MS = [60_000, 5 * 60_000] as const;
const MAX_APPROVAL_SUMMARY_CODE_POINTS = 500;
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
    const params = approvalParamsSnapshot(event.params);
    if (params === null) {
      this.#respond(id, denialResult(method));
      return true;
    }
    if (
      !stringField(params, "threadId") ||
      !stringField(params, "turnId") ||
      !stringField(params, "itemId")
    ) {
      this.#respond(id, denialResult(method));
      return true;
    }
    const approvedResult = approvalResult(method, params);
    if (approvedResult === null) {
      this.#respond(id, denialResult(method));
      return true;
    }
    return this.#ingestCallback(
      {
        isLive: () => this.#isLive(id),
        method,
        params,
        respond: (approved) =>
          this.#respond(
            id,
            approved ? approvedResult : denialResult(method),
          ),
      },
      false,
    );
  }

  async ingestCallback(input: LiveApprovalCallbackInput): Promise<boolean> {
    return this.#ingestCallback(input, true);
  }

  async #ingestCallback(
    input: LiveApprovalCallbackInput,
    trustedCallbackSummary: boolean,
  ): Promise<boolean> {
    const { method } = input;
    const params = approvalParamsSnapshot(input.params);
    if (params === null) {
      input.respond(false);
      return true;
    }
    const threadId = stringField(params, "threadId");
    const turnId = stringField(params, "turnId");
    const itemId = stringField(params, "itemId");
    if (!threadId || !turnId || !itemId) return false;
    if (!input.isLive()) return true;

    this.expire();
    const summary = approvalSummary(method, params, trustedCallbackSummary);
    if (summary === null) {
      input.respond(false);
      return true;
    }
    const payloadFingerprint = approvalPayloadFingerprint(method, params);
    if (payloadFingerprint === null) {
      input.respond(false);
      return true;
    }
    const requestIdentity = approvalRequestIdentity(method, params);
    const existing = [...this.#live.values()].find(
      (approval) =>
        approval.method === method &&
        approval.threadId === threadId &&
        approval.turnId === turnId &&
        approval.requestIdentity === requestIdentity,
    );
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        input.respond(false);
        return true;
      }
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
      payloadFingerprint,
      requestIdentity,
      reminderCount: 0,
      summary,
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

  decideMany(
    codes: readonly string[],
    approved: boolean,
  ): ApprovalBatchDecisionResult {
    const uniqueCodes = [...new Set(codes)];
    let decided = 0;
    for (const code of uniqueCodes) {
      if (this.decide(code, approved).kind === "decided") decided += 1;
    }
    return { attempted: uniqueCodes.length, decided };
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
          payloadFingerprint: _payloadFingerprint,
          requestIdentity: _requestIdentity,
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
): Record<string, unknown> | null {
  if (method === "item/permissions/requestApproval") {
    const permissions = recordField(params, "permissions");
    const parsed = permissions ? parsePermissionProfile(permissions) : null;
    return parsed
      ? { permissions: parsed.normalized, scope: "turn" }
      : null;
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
  trustedCallbackSummary: boolean,
): string | null {
  const rawDetails: string[] = [];
  const reason = stringField(params, "reason");
  const command = stringField(params, "command");
  if (
    (reason !== null &&
      (containsCredentialContext(reason) ||
        containsNonDisplayableLocalPath(reason))) ||
    (command !== null && containsNonDisplayableCommand(command))
  ) {
    return null;
  }
  if (reason) rawDetails.push(reason);
  if (command) rawDetails.push(command);
  if (hasOwn(params, "cwd")) {
    const projectName = windowsProjectName(params.cwd);
    if (!projectName) return null;
    rawDetails.push(`Project: ${projectName}`);
  }

  if (method === "item/commandExecution/requestApproval") {
    if (!command) return null;
    if (
      !trustedCallbackSummary &&
      !hasOnlyKeys(params, [
        "additionalPermissions",
        "approvalId",
        "availableDecisions",
        "command",
        "commandActions",
        "cwd",
        "environmentId",
        "itemId",
        "networkApprovalContext",
        "proposedExecpolicyAmendment",
        "proposedNetworkPolicyAmendments",
        "reason",
        "startedAtMs",
        "threadId",
        "turnId",
      ])
    ) {
      return null;
    }
    if (
      (hasOwn(params, "environmentId") && params.environmentId !== null) ||
      (hasOwn(params, "networkApprovalContext") &&
        params.networkApprovalContext !== null) ||
      (hasOwn(params, "commandActions") && params.commandActions !== null) ||
      (hasOwn(params, "proposedExecpolicyAmendment") &&
        params.proposedExecpolicyAmendment !== null) ||
      (hasOwn(params, "proposedNetworkPolicyAmendments") &&
        params.proposedNetworkPolicyAmendments !== null)
    ) {
      return null;
    }
    if (hasOwn(params, "additionalPermissions")) {
      const value = params.additionalPermissions;
      if (value !== null) {
        const profile = asRecord(value);
        const parsed = profile ? parsePermissionProfile(profile) : null;
        if (!parsed) return null;
        rawDetails.push(`Additional permissions: ${parsed.summary}`);
      }
    }
    if (hasOwn(params, "availableDecisions")) {
      const decisions = params.availableDecisions;
      if (
        decisions !== null &&
        (!Array.isArray(decisions) || !decisions.includes("accept"))
      ) {
        return null;
      }
    }
  }

  if (
    method === "item/fileChange/requestApproval" &&
    (!trustedCallbackSummary ||
      !hasOnlyKeys(params, [
        "command",
        "itemId",
        "requestFingerprint",
        "threadId",
        "turnId",
      ]) ||
      !command ||
      !/^[a-f0-9]{64}$/u.test(
        stringField(params, "requestFingerprint") ?? "",
      ) ||
      (hasOwn(params, "grantRoot") && params.grantRoot !== null))
  ) {
    // Native file-change callbacks do not contain the actual patch or target.
    // Only the already validated online Hook callback carries a bound summary.
    return null;
  }

  if (method === "item/permissions/requestApproval") {
    if (
      !hasOnlyKeys(params, [
        "cwd",
        "environmentId",
        "itemId",
        "permissions",
        "reason",
        "startedAtMs",
        "threadId",
        "turnId",
      ]) ||
      (hasOwn(params, "environmentId") && params.environmentId !== null)
    ) {
      return null;
    }
    const permissions = recordField(params, "permissions");
    const parsed = permissions ? parsePermissionProfile(permissions) : null;
    if (!parsed) return null;
    rawDetails.push(`Requested permissions: ${parsed.summary}`);
  }

  if (rawDetails.length === 0) return null;
  if (
    rawDetails.some(
      (value) =>
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
        redactionCouldHideExecution(value),
    )
  ) {
    return null;
  }
  if (
    rawDetails.some((value) =>
      hasMoreThanCodePoints(value, MAX_APPROVAL_SUMMARY_CODE_POINTS),
    )
  ) {
    return null;
  }
  const details = rawDetails.map(sanitizeApprovalDetail);
  if (details.some((detail, index) => detail !== rawDetails[index])) {
    // Redaction must never change the command a user is authorizing. Requests
    // containing secrets or forged reply instructions stay in the native UI.
    return null;
  }
  const summaryDetails = [...new Set(details)].join(" | ");
  if (!summaryDetails) return null;
  const label =
    method === "item/commandExecution/requestApproval"
      ? "Command"
      : method === "item/fileChange/requestApproval"
        ? "File change"
        : "Permission";
  const summary = `${label}: ${summaryDetails}`;
  return hasMoreThanCodePoints(summary, MAX_APPROVAL_SUMMARY_CODE_POINTS)
    ? null
    : summary;
}

function sanitizeApprovalDetail(value: string): string {
  if (containsCredentialSyntax(value)) return "[REDACTED]";
  return value
    .replace(/\p{Cc}/gu, " ")
      .replace(/\p{Cf}/gu, "")
      .replace(
        /(\bauthorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s&|,'";}<>]+/giu,
        "$1[REDACTED]",
      )
      .replace(
        /((?:--)?[A-Z0-9_-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|KEY|COOKIE|SESSION)["']?\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s&|,'";}<>]+)/giu,
        "$1[REDACTED]",
      )
      .replace(
        /(\b(?:set-cookie|cookie)\s*:\s*)[^\s&|;<>"']+/giu,
        "$1[REDACTED]",
      )
      .replace(
        /(^|\s)(--cookie(?:-jar)?(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s&|,'";}<>]+)/gimu,
        "$1$2[REDACTED]",
      )
      .replace(
        /(^|\s)((?:-u|--user|-b)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s&|,'";}<>]+)/gimu,
        "$1$2[REDACTED]",
      )
      .replace(
        /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gu,
        "$1[REDACTED]@",
      )
      .replace(
        /(?:回复|答复)\s*[:：]?\s*(?:y|n)(?:\s*(?:或|\/)\s*(?:y|n))?/giu,
        "[REDACTED]",
      )
      .replace(/\breply\s*[:：]?\s*(?:y|n)\b/giu, "[REDACTED]")
      .replace(/【(?:请求内容|系统操作)】/gu, "[REDACTED]");
}

function hasMoreThanCodePoints(value: string, limit: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function approvalPayloadFingerprint(
  method: ApprovalMethod,
  params: Record<string, unknown>,
): string | null {
  try {
    return createHash("sha256")
      .update(method)
      .update("\0")
      .update(canonicalJson(params, new Set()))
      .digest("hex");
  } catch {
    return null;
  }
}

function approvalParamsSnapshot(
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    const snapshot = JSON.parse(
      canonicalJson(params, new Set()),
    ) as unknown;
    return asRecord(snapshot);
  } catch {
    return null;
  }
}

function approvalRequestIdentity(
  method: ApprovalMethod,
  params: Record<string, unknown>,
): string {
  const approvalId =
    method === "item/commandExecution/requestApproval"
      ? stringField(params, "approvalId")
      : null;
  return approvalId
    ? `approval:${approvalId}`
    : `item:${stringField(params, "itemId") ?? "unknown"}`;
}

function redactionCouldHideExecution(value: string): boolean {
  if (!containsPotentialSecret(value)) return false;
  return /\$\(|`|[&|;<>^()]|%[^%]+%|![^!]+!/u.test(value);
}

function containsNonDisplayableCommand(value: string): boolean {
  // The approval payload does not identify the shell. Dynamic evaluation is
  // therefore unverifiable, while lexical escape variants are checked as
  // additional candidates and fall back to the native client on any match.
  if (containsUnverifiableShellExpansion(value)) return true;
  return shellDetectionCandidates(value).some(
    (candidate) =>
      containsCredentialContext(candidate) ||
      containsNonDisplayableLocalPath(candidate),
  );
}

function containsUnverifiableShellExpansion(value: string): boolean {
  return (
    /[$`]|%[A-Za-z_][A-Za-z0-9_]*(?::[^%\r\n]*)?%|![A-Za-z_][A-Za-z0-9_]*(?::[^!\r\n]*)?!/u.test(
      value,
    ) ||
    /(?:^|[\s"'=([{,;])~(?=$|[\\/])/u.test(value) ||
    /(?:^|[;&|])\s*[.&]\s*\(/u.test(value) ||
    /(?:^|[\s;&|])[^\s"'{}]*\{[^{}\s"',]*,[^{}\s"',]*\}[^\s"'{}]*(?=\s|$)/u.test(
      value,
    ) ||
    /\b(?:iex|invoke-expression|start-process)\b/iu.test(value) ||
    /\b(?:system|exec|spawn|popen)\s*\(/iu.test(value) ||
    /(?:^|[\s;&|])(?:bash|bun|cmd|deno|fish|lua|luajit|node|perl|php|powershell|pwsh|py|python(?:\d+(?:\.\d+)*)?|ruby|rscript|sh|zsh)(?:\.exe)?\b[^\r\n]*(?:\s-(?:c|e|command|encodedcommand)\b|\s--(?:eval|execute)\b|\s\/[ck]\b)/iu.test(
      value,
    )
  );
}

function shellDetectionCandidates(value: string): string[] {
  const candidates = [value];
  const withoutCaretEscapes = value.replace(/\^/gu, "");
  candidates.push(withoutCaretEscapes);
  const withoutLiteralConcatenation = withoutCaretEscapes.replace(
    /["']\s*\+\s*["']/gu,
    "",
  );
  candidates.push(withoutLiteralConcatenation);
  const withoutQuotes = withoutLiteralConcatenation.replace(/["']/gu, "");
  candidates.push(withoutQuotes);
  candidates.push(
    withoutQuotes.replace(
      /(?<=[\p{L}\p{N}_-])\\(?=[\p{L}\p{N}_-])/gu,
      "",
    ),
  );
  return [...new Set(candidates)];
}

function containsPotentialSecret(value: string): boolean {
  return (
    containsCredentialSyntax(value) ||
    /\bauthorization\s*[:=]\s*(?:bearer|basic)\s+/iu.test(value) ||
    /(?:--)?[A-Z0-9_-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|KEY|COOKIE|SESSION)["']?\s*(?:=|:|\s)/iu.test(
      value,
    ) ||
    /\b(?:set-cookie|cookie)\s*:/iu.test(value) ||
    /(^|\s)--cookie(?:-jar)?(?:=|\s+)/imu.test(value) ||
    /(^|\s)(?:-u|--user|-b)(?:=|\s+)/imu.test(value) ||
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value)
  );
}

function containsCredentialSyntax(value: string): boolean {
  const credentialHeader =
    /\b(?:proxy-)?authorization\s*[:=]|\bx[-_](?:auth|api[-_]?key)\s*[:=]/iu;
  return (
    credentialHeader.test(value) ||
    /(?:^|\s)--proxy-user(?:=|\s+)/u.test(value) ||
    executableUsesArgument(
      value,
      "docker",
      /\blogin\b[^\r\n]*(?:^|\s)(?:-p(?:=|\s|(?=\S)|$)|--password(?:-stdin)?(?:=|\s|$))/mu,
    ) ||
    executableUsesArgument(
      value,
      "mysql(?:admin|check|dump|import|pump|show|slap)?|mariadb(?:-(?:admin|check|dump|import|show))?",
      /(?:^|\s)(?:-p(?:=|\s|(?=\S)|$)|--password(?:=|\s|$))/mu,
    ) ||
    executableUsesArgument(
      value,
      "sshpass",
      /(?:^|\s)-p(?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "redis-cli",
      /(?:^|\s)(?:-a|--pass)(?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "sqlcmd|bcp",
      /(?:^|\s)-P(?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "gpg2?",
      /(?:^|\s)--passphrase(?:=|\s|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "7z(?:a|r)?|rar|unrar",
      /(?:^|\s)-[pP](?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "zip|unzip",
      /(?:^|\s)-P(?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "plink|pscp|psftp|putty",
      /(?:^|\s)-[pP][wW](?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "ldapsearch",
      /(?:^|\s)-w(?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(
      value,
      "sqlplus|rman|expdp|impdp|sqlldr",
      /(?:^|\s)(?:"[^"\r\n\s/]+\/[^"\r\n\s]+"|'[^'\r\n\s/]+\/[^'\r\n\s]+'|[^\s"'&|;<>/]+\/[^\s"'&|;<>]+)/mu,
    )
  );
}

function executableUsesArgument(
  value: string,
  executablePattern: string,
  argumentPattern: RegExp,
): boolean {
  const executable = new RegExp(
    `\\b(?:${executablePattern})(?:\\.exe)?\\b`,
    "giu",
  );
  for (const match of value.matchAll(executable)) {
    const start = (match.index ?? 0) + match[0].length;
    argumentPattern.lastIndex = 0;
    if (argumentPattern.test(value.slice(start))) return true;
  }
  return false;
}

function containsCredentialContext(value: string): boolean {
  return (
    containsCredentialSyntax(value) ||
    /(?:^|[^A-Z0-9])(?:AUTH(?:ENTICATION|ORIZATION)?|OAUTH\d*|BEARER|CREDENTIALS?|LOGIN|PASSWORD|PASSWD|PASSPHRASE|PASS|SECRET|TOKEN|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|COOKIE|SESSION|CERT(?:IFICATE)?|NETRC)(?:[^A-Z0-9]|$)/iu.test(
      value,
    ) ||
    /(?:^|[^A-Z0-9])(?:[A-Z0-9_-]*(?:PWD|PASS|AUTH|CREDENTIALS?))\s*(?:=|:)/iu.test(
      value,
    )
  );
}

function containsNonDisplayableLocalPath(value: string): boolean {
  if (/^\s*shutdown(?:\.exe)?\s+\/(?:s|r|l|h)(?:\s+\/f)?(?:\s+\/t\s+\d+)?\s*$/iu.test(value)) {
    return false;
  }
  return (
    /(?<![\p{L}\p{N}_])[A-Za-z]:[\\/]/u.test(value) ||
    /(?:^|[\s"'=([{,;:])\\\\/u.test(value) ||
    /(?:^|[\s"'=([{,;:])\\(?!\\)[^\s"'<>|:]*/u.test(value) ||
    /(?:^|[\s"'=([{,;])\/(?!\/)[^\s"'<>|:]*/u.test(value) ||
    /\bfile:\/{3}/iu.test(value) ||
    /\b(?:HKLM|HKCU|HKCR|HKU|CERT|REGISTRY):[\\/]/iu.test(value)
  );
}

function windowsProjectName(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^[A-Za-z]:[\\/]/u.test(value)
  ) {
    return null;
  }
  const segments = value.slice(3).split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment !== segment.trim() ||
        segment === "." ||
        segment === ".." ||
        /[ .]$/u.test(segment) ||
        /[<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(segment) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(
          segment,
        ),
    )
  ) {
    return null;
  }
  return segments.at(-1) ?? null;
}

type ParsedPermissionProfile = {
  normalized: Record<string, unknown>;
  summary: string;
};

function parsePermissionProfile(
  profile: Record<string, unknown>,
): ParsedPermissionProfile | null {
  if (!hasOnlyKeys(profile, ["fileSystem", "network"])) return null;
  const normalized: Record<string, unknown> = {};
  const summary: string[] = [];

  if (hasOwn(profile, "network")) {
    if (profile.network === null) {
      normalized.network = null;
    } else {
      const network = asRecord(profile.network);
      if (!network || !hasOnlyKeys(network, ["enabled"])) return null;
      const normalizedNetwork: Record<string, unknown> = {};
      if (hasOwn(network, "enabled")) {
        if (network.enabled === null) {
          normalizedNetwork.enabled = null;
        } else if (typeof network.enabled === "boolean") {
          normalizedNetwork.enabled = network.enabled;
          summary.push(
            `network access ${network.enabled ? "enabled" : "disabled"}`,
          );
        } else {
          return null;
        }
      }
      normalized.network = normalizedNetwork;
    }
  }

  if (hasOwn(profile, "fileSystem")) {
    if (profile.fileSystem === null) {
      normalized.fileSystem = null;
    } else {
      const fileSystem = asRecord(profile.fileSystem);
      if (
        !fileSystem ||
        !hasOnlyKeys(fileSystem, [
          "entries",
          "globScanMaxDepth",
          "read",
          "write",
        ])
      ) {
        return null;
      }
      const normalizedFileSystem: Record<string, unknown> = {};

      for (const field of ["read", "write"] as const) {
        if (!hasOwn(fileSystem, field)) continue;
        const value = fileSystem[field];
        if (value === null) {
          normalizedFileSystem[field] = null;
          continue;
        }
        if (
          !Array.isArray(value) ||
          !value.every((entry) => typeof entry === "string") ||
          value.length > 0
        ) {
          // Legacy entries contain local paths. A basename is ambiguous while
          // the full path is private, so native approval is required.
          return null;
        }
        normalizedFileSystem[field] = [];
      }

      if (hasOwn(fileSystem, "entries")) {
        const entries = fileSystem.entries;
        if (entries === null) {
          normalizedFileSystem.entries = null;
        } else if (Array.isArray(entries)) {
          const normalizedEntries: Record<string, unknown>[] = [];
          for (const entry of entries) {
            const parsed = parsePermissionEntry(entry);
            if (!parsed) return null;
            normalizedEntries.push(parsed.normalized);
            summary.push(parsed.summary);
          }
          normalizedFileSystem.entries = normalizedEntries;
        } else {
          return null;
        }
      }

      if (hasOwn(fileSystem, "globScanMaxDepth")) {
        const depth = fileSystem.globScanMaxDepth;
        if (depth === null) {
          normalizedFileSystem.globScanMaxDepth = null;
        } else if (Number.isInteger(depth) && Number(depth) >= 1) {
          normalizedFileSystem.globScanMaxDepth = depth;
          summary.push(`filesystem glob scan depth ${String(depth)}`);
        } else {
          return null;
        }
      }
      normalized.fileSystem = normalizedFileSystem;
    }
  }

  return summary.length > 0
    ? { normalized, summary: summary.join(", ") }
    : null;
}

function parsePermissionEntry(value: unknown): {
  normalized: Record<string, unknown>;
  summary: string;
} | null {
  const entry = asRecord(value);
  if (!entry || !hasOnlyKeys(entry, ["access", "path"])) return null;
  if (
    entry.access !== "read" &&
    entry.access !== "write" &&
    entry.access !== "deny"
  ) {
    return null;
  }
  const path = asRecord(entry.path);
  if (
    !path ||
    !hasOnlyKeys(path, ["type", "value"]) ||
    path.type !== "special"
  ) {
    // Explicit and glob paths cannot be both private and unambiguous in a
    // cross-channel notification.
    return null;
  }
  const special = asRecord(path.value);
  if (!special || typeof special.kind !== "string") return null;
  const labels: Record<string, string> = {
    minimal: "minimal system paths",
    project_roots: "project roots",
    root: "filesystem root",
    slash_tmp: "/tmp",
    tmpdir: "temporary directory",
  };
  const label = labels[special.kind];
  if (!label) return null;
  if (special.kind === "project_roots") {
    if (!hasOnlyKeys(special, ["kind", "subpath"])) return null;
    if (hasOwn(special, "subpath") && special.subpath !== null) return null;
  } else if (!hasOnlyKeys(special, ["kind"])) {
    return null;
  }
  const normalizedSpecial: Record<string, unknown> = { kind: special.kind };
  if (hasOwn(special, "subpath")) normalizedSpecial.subpath = null;
  return {
    normalized: {
      access: entry.access,
      path: { type: "special", value: normalizedSpecial },
    },
    summary: `filesystem ${entry.access}: ${label}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwn(value: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, name);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function canonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("E_APPROVAL_PARAMS_INVALID");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("E_APPROVAL_PARAMS_INVALID");
  if (seen.has(value)) throw new Error("E_APPROVAL_PARAMS_CYCLIC");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
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
    return [
      "需要批准",
      `【请求内容】${approval.summary}`,
      "【系统操作】回复：y 或 n",
    ].join("\n");
  }
  return [
    "当前有多个待审批：",
    ...existingApprovals.map(
      (existing) => `${existing.code}：${existing.summary}`,
    ),
    `${approval.code}：${approval.summary}`,
    "【系统操作】逐条：y<code> / n<code>；批量：ya / na（需确认）",
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
        `回复：y${approval.code} 或 n${approval.code}`,
      ].join("\n")
    : ["⏳ 仍在等待审批", approval.summary, "回复：y 或 n"].join("\n");
}

function approvalClientId(approval: LiveApproval): string {
  const identity = [
    approval.method,
    approval.threadId,
    approval.turnId,
    approval.requestIdentity,
    approval.payloadFingerprint,
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
