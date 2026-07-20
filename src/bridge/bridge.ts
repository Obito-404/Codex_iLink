import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  type AtomicControlIntent,
  COMMAND_HELP,
  looksLikeControlRequest,
  parseInboundText,
  routedControlIntent,
} from "./commands.ts";
import {
  ApprovalCoordinator,
  type PendingApproval,
} from "./approval-coordinator.ts";
import {
  parseControllerMessage,
  type ParsedControllerMessage,
} from "./inbound-message.ts";
import {
  parseDurableInboundFailure,
  parseDurableTurnInput,
  serializeDurableInboundFailure,
  serializeDurableTurnInput,
  type DurableInboundFailureCode,
  type DurableTurnAttachment,
  type DurableTurnInput,
} from "./turn-input.ts";
import {
  SqliteState,
  OutboundAttachmentIntentError,
  type DispatchIntent,
  type InboundDispatchAdmission,
  type InboundMessageInput,
  type OutboundAttachmentIntent,
  type OutboxItem,
  type PendingOutboxInput,
} from "./sqlite-state.ts";
import {
  extractWechatLocalFileReferences,
  formatWechatFinalReply,
} from "./wechat-output.ts";
import {
  parseOutboundPayload,
  outboundMediaDirectory,
  removeOutboundMediaSnapshot,
  serializeOutboundPayload,
  stageOutboundMedia,
  stagedOutboundMedia,
} from "../media/outbound-media.ts";
import {
  dispatchOutboxItem,
  type OutboxILinkSender,
} from "./outbox-delivery.ts";
import { routeInboundText } from "../domain/route-inbound.ts";
import {
  SqliteTurnLeaseStore,
  type TurnLease,
} from "../coordination/turn-lease.ts";
import {
  buildThreadPreview,
  findThreadTitle,
  listActiveThreads,
  paginateThreads,
  type ThreadPreview,
} from "./thread-catalog.ts";
import type {
  ILinkSession,
  WireWeixinMessage,
} from "../ilink/protocol.ts";
import {
  InboundMediaError,
  type InboundMediaCandidate,
  type InboundMediaResolution,
} from "../media/inbound-media.ts";
import { CodexOutcomeUnknownError } from "../codex/protocol.ts";
import type { DefaultThreadPermissionSettings } from "../domain/user-settings.ts";
import type { SendTypingInput } from "../ilink/ilink-client.ts";

export type ILinkSender = OutboxILinkSender & {
  sendTyping?(input: SendTypingInput): Promise<boolean>;
};

export type BridgeEngineOptions = {
  bridgeInstanceId?: string;
  codex?: CodexTurnStarter;
  ilink: ILinkSender;
  inboxDirectory?: string;
  leases?: SqliteTurnLeaseStore;
  mainThreadId?: string;
  newId: () => string;
  now: () => number;
  listProjects?: () =>
    | Promise<readonly ProjectNavigationEntry[]>
    | readonly ProjectNavigationEntry[];
  media?: InboundMediaPort;
  session: ILinkSession;
  slowTurnNoticeAfterMs?: number;
  state: SqliteState;
};

export type InboundMediaPort = {
  cleanup(dedupeKey: string): Promise<void>;
  resolve(input: {
    candidate: InboundMediaCandidate;
    dedupeKey: string;
    signal?: AbortSignal;
  }): Promise<InboundMediaResolution>;
};

export type ProjectNavigationEntry = {
  cwd: string;
  name: string;
};

type ControlReplyResult = {
  ok: boolean;
  reply: string | null;
};

class ControlCommandRejected extends Error {
  readonly reply: string;

  constructor(reply: string) {
    super(reply);
    this.name = "ControlCommandRejected";
    this.reply = reply;
  }
}

export type CodexTurnStarter = {
  archiveThread?(threadId: string): Promise<Record<string, unknown>>;
  classifyControlIntent?(input: {
    cwd: string;
    text: string;
  }): Promise<unknown>;
  compactThread?(threadId: string): Promise<Record<string, unknown>>;
  ensureThread?(threadId: string): Promise<void>;
  listModels?(input?: { cursor?: string | null }): Promise<{
    data: Array<{
      defaultReasoningEffort: string;
      displayName: string;
      hidden: boolean;
      id: string;
      model: string;
      supportedReasoningEfforts: Array<{
        description: string;
        reasoningEffort: string;
      }>;
    }>;
    nextCursor: string | null;
  }>;
  listThreads?(input: {
    archived: boolean;
    cursor?: string;
  }): Promise<{ data: unknown[]; nextCursor: string | null }>;
  readThread?(input: {
    includeTurns: boolean;
    threadId: string;
  }): Promise<{ thread: Record<string, unknown> }>;
  isServerRequestLive?(id: number | string): boolean;
  interruptTurn?(input: {
    threadId: string;
    turnId: string;
  }): Promise<Record<string, unknown>>;
  respondToServerRequest?(
    id: number | string,
    result: Record<string, unknown>,
  ): boolean | void;
  resumeThread?(threadId: string): Promise<Record<string, unknown>>;
  setThreadName?(input: {
    name: string;
    threadId: string;
  }): Promise<Record<string, unknown>>;
  startThread?(
    cwd: string,
    permissions?: DefaultThreadPermissionSettings,
  ): Promise<Record<string, unknown> & {
    thread: { id: string } & Record<string, unknown>;
  }>;
  updateThreadModelSettings?(
    threadId: string,
    settings: { effort?: string; model?: string },
  ): Promise<Record<string, unknown>>;
  unarchiveThread?(threadId: string): Promise<Record<string, unknown>>;
  startTurn(input: {
    attachments?: readonly DurableTurnAttachment[];
    clientUserMessageId: string;
    text: string;
    threadId: string;
  }): Promise<{ turn: { id: string } }>;
};

export type CodexEvent = {
  id?: number | string;
  method: string;
  params: Record<string, unknown>;
};

type CodexTurnFailure = {
  category: "network" | "other";
  httpStatusCode: number | undefined;
};

type ModelCatalogEntry = {
  defaultReasoningEffort: string;
  displayName: string;
  hidden: boolean;
  id: string;
  model: string;
  supportedReasoningEfforts: Array<{
    description: string;
    reasoningEffort: string;
  }>;
};

const MAX_ACTIVE_BRIDGE_TURNS = 3;
const MAX_REMEMBERED_CODEX_FAILURES = 256;
const DEFAULT_SLOW_TURN_NOTICE_AFTER_MS = 2 * 60 * 1_000;
const TYPING_KEEPALIVE_INTERVAL_MS = 5_000;
const CODEX_OUTCOME_UNKNOWN_TEXT =
  "E_CODEX_OUTCOME_UNKNOWN：提交结果未知，请在 Desktop 查看后决定是否重发。";
const CODEX_EMPTY_REPLY_TEXT =
  "❌ Codex 未生成回复，可能发生网络或系统错误。请稍后重试；详情请在 Codex Desktop 查看。";
const CODEX_SUBMISSION_REJECTED_TEXT =
  "❌ Codex 提交失败：本次输入已被明确拒绝，未创建任务。请检查附件或输入后重试；详情请在 Codex Desktop 查看。";
const HOOK_GUARD_UNKNOWN_TEXT =
  "E_HOOK_GUARD：并发门禁未确认，结果状态未知，请在 Desktop 查看。";
const MISSING_THREAD_TEXT =
  "原会话尚未写入 Codex 历史，已失效；请使用 new 重新创建并发送。";
const CODEX_THREAD_RESUME_FAILED_TEXT =
  "❌ Codex 无法恢复目标任务，本条消息未执行。请在 Codex Desktop 确认任务可打开后重发。";
const CODEX_SLOW_TURN_TEXT =
  "⏳ Codex 任务仍在执行，已长时间没有结束；可能正在等待工具、审批或网络。任务未被取消，可用 st 查看或用 stop 停止。";
const LEGACY_ATTACHMENT_REJECTED_TEXT =
  "⚠️ 旧版附件记录未通过当前安全校验，未发送本机文件；请在新的 iLink 任务中重新发送。";

export class BridgeEngine {
  readonly #approvals: ApprovalCoordinator | undefined;
  readonly #ilink: ILinkSender;
  readonly #inboxDirectory: string | undefined;
  readonly #bridgeInstanceId: string | undefined;
  readonly #codex: CodexTurnStarter | undefined;
  readonly #leases: SqliteTurnLeaseStore | undefined;
  #mainThreadId: string | undefined;
  readonly #outboundDirectory: string | undefined;
  readonly #media: InboundMediaPort | undefined;
  readonly #listProjects: BridgeEngineOptions["listProjects"];
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #session: ILinkSession;
  readonly #shutdown = new AbortController();
  readonly #slowTurnNoticeAfterMs: number;
  readonly #state: SqliteState;
  readonly #turnFailures = new Map<string, CodexTurnFailure>();
  readonly #userStoppedTurns = new Set<string>();
  readonly #clearOperations = new Map<string, string>();
  readonly #compactOperations = new Map<
    string,
    {
      contextToken: string;
      operationId: string;
      unknownReason: "eof" | "timeout" | null;
    }
  >();
  readonly #typingTurns = new Set<string>();
  #closing = false;
  #ilinkHealthy = true;
  #reconcilePromise: Promise<void> | undefined;
  #typingContextToken: string | undefined;
  #typingKeepalive: ReturnType<typeof setInterval> | undefined;
  #pendingTyping:
    | { contextToken: string; status: "cancel" | "typing" }
    | undefined;
  #typingPumpRunning = false;

  constructor(options: BridgeEngineOptions) {
    this.#bridgeInstanceId = options.bridgeInstanceId;
    this.#codex = options.codex;
    this.#ilink = options.ilink;
    this.#inboxDirectory = options.inboxDirectory;
    this.#leases = options.leases;
    this.#mainThreadId = options.mainThreadId;
    this.#outboundDirectory = options.inboxDirectory
      ? outboundMediaDirectory(options.inboxDirectory)
      : undefined;
    this.#media = options.media;
    this.#listProjects = options.listProjects;
    this.#newId = options.newId;
    this.#now = options.now;
    this.#session = options.session;
    this.#slowTurnNoticeAfterMs =
      options.slowTurnNoticeAfterMs ?? DEFAULT_SLOW_TURN_NOTICE_AFTER_MS;
    if (
      !Number.isFinite(this.#slowTurnNoticeAfterMs) ||
      this.#slowTurnNoticeAfterMs < 0
    ) {
      throw new Error("E_SLOW_TURN_NOTICE_AFTER_INVALID");
    }
    this.#state = options.state;
    const isLive = options.codex?.isServerRequestLive?.bind(options.codex);
    const respond = options.codex?.respondToServerRequest?.bind(options.codex);
    this.#approvals = respond
      ? new ApprovalCoordinator({
          notify: async (text, clientId) => {
            const contextToken = this.#state.getILinkState(
              this.#session.botId,
            )?.contextToken;
            if (!contextToken) throw new Error("E_ILINK_CONTEXT_MISSING");
            try {
              await this.#send(contextToken, text, clientId);
            } catch (error) {
              this.#state.deletePendingOutbox(clientId);
              throw error;
            }
          },
          ...(isLive ? { isLive } : {}),
          now: this.#now,
          onExpired: (approval, reason) => {
            const contextToken =
              this.#state.getDispatchIntentByTurnId(approval.turnId)
                ?.contextToken ??
              this.#state.getILinkState(this.#session.botId)?.contextToken;
            if (!contextToken) return;
            const text =
              reason === "request-lost"
                ? "⚠️ 审批已失效，受限操作未执行；请重新发送操作。"
                : approval.deliveryStatus === "retrying"
                  ? "🌐 审批因微信网络异常未送达且已超时，受限操作未执行；请重新发送操作。"
                  : "⌛ 审批已超时，受限操作未执行；请重新发送操作。";
            void this.#send(
              contextToken,
              text,
              `codex-ilink:approval:${approval.turnId}:${approval.code}:expired`,
            ).catch(() => undefined);
          },
          respond,
        })
      : undefined;
  }

  async ingestBatch(input: {
    beforeAcceptedMessage?: () => Promise<void>;
    cursor: string;
    messages: readonly WireWeixinMessage[];
    onAccepted?: () => Promise<void>;
  }): Promise<{ accepted: number; sent: number }> {
    const parsed = input.messages.map((message) =>
      parseControllerMessage(message, this.#session.controllerUserId),
    );
    const knownMessageIds = this.#state.findExistingInboundMessageIds({
      accountId: this.#session.botId,
      candidateMessageIds: parsed.flatMap((message) =>
        message.kind === "ignored" ? [] : [message.messageId],
      ),
      controllerUserId: this.#session.controllerUserId,
    });
    const prepared = new Map<
      string,
      {
        body: string;
        failure: DurableInboundFailureCode | null;
        turnInput: DurableTurnInput | null;
      }
    >();
    const acceptedCandidates: InboundMessageInput[] = [];
    for (const message of parsed) {
      if (message.kind === "ignored") continue;
      let body = serializeDurableInboundFailure("unsupported-media");
      if (!knownMessageIds.has(message.messageId)) {
        const result = await this.#prepareInboundMessage(message);
        prepared.set(message.messageId, result);
        body = result.body;
        knownMessageIds.add(message.messageId);
      }
      acceptedCandidates.push({
        body,
        contextToken: message.contextToken,
        messageId: message.messageId,
        receivedAtMs:
          message.kind === "text" ? message.receivedAtMs : this.#now(),
      });
    }
    const accepted = this.#state.acceptInboundBatch({
      accountId: this.#session.botId,
      controllerUserId: this.#session.controllerUserId,
      messages: acceptedCandidates,
      nextCursor: input.cursor,
      updatedAtMs: this.#now(),
    });
    const acceptedIds = new Set(accepted.acceptedMessageIds);
    if (acceptedIds.size > 0) await input.onAccepted?.();
    let sent = 0;
    const processedAcceptedIds = new Set<string>();

    for (const message of parsed) {
      if (
        message.kind === "ignored" ||
        !acceptedIds.has(message.messageId) ||
        processedAcceptedIds.has(message.messageId)
      ) {
        continue;
      }
      processedAcceptedIds.add(message.messageId);
      await input.beforeAcceptedMessage?.();
      const preparedMessage = prepared.get(message.messageId);
      if (!preparedMessage) throw new Error("E_INBOUND_PREPARATION_MISSING");
      if (preparedMessage.failure) {
        await this.#send(
          message.contextToken,
          inboundFailureText(preparedMessage.failure),
          this.#inboundReplyClientId(message.messageId),
        );
        this.#clearInbound(message.messageId);
        await this.#cleanupMedia(this.#dedupeKey(message.messageId));
        sent += 1;
        continue;
      }
      if (!preparedMessage.turnInput) {
        throw new Error("E_INBOUND_TURN_INPUT_MISSING");
      }
      sent += await this.#processAcceptedTurn({
        contextToken: message.contextToken,
        messageId: message.messageId,
        turnInput: preparedMessage.turnInput,
      });
    }

    return { accepted: accepted.acceptedMessageIds.length, sent };
  }

  async ingestCodexEvent(event: CodexEvent): Promise<boolean> {
    if (event.method === "error") {
      const threadId = stringField(event.params, "threadId");
      const turnId = stringField(event.params, "turnId");
      const error = objectField(event.params, "error");
      if (!threadId || !turnId || !error || event.params.willRetry !== false) {
        return false;
      }
      this.#turnFailures.set(
        turnFailureKey(threadId, turnId),
        sanitizeCodexTurnFailure(error),
      );
      if (this.#turnFailures.size > MAX_REMEMBERED_CODEX_FAILURES) {
        const oldest = this.#turnFailures.keys().next().value;
        if (oldest !== undefined) this.#turnFailures.delete(oldest);
      }
      return true;
    }
    if (event.method === "item/tool/call") {
      return await this.#handleSendFileCall(event);
    }
    if (this.#approvals && (await this.#approvals.ingest(event))) return true;
    if (event.method === "item/started") {
      const threadId = stringField(event.params, "threadId");
      const turnId = stringField(event.params, "turnId");
      const item = objectField(event.params, "item");
      const operation = threadId
        ? this.#compactOperation(threadId)
        : undefined;
      if (
        !threadId ||
        !turnId ||
        stringField(item, "type") !== "contextCompaction" ||
        !operation ||
        !this.#leases
      ) {
        return false;
      }
      return this.#leases.claimBridgeTurn({
        instanceId: this.#bridgeInstanceId ?? "",
        threadId,
        turnId,
      });
    }
    if (event.method !== "turn/completed") return false;
    const threadId = stringField(event.params, "threadId");
    const turn = objectField(event.params, "turn");
    const turnId = stringField(turn, "id") ?? stringField(event.params, "turnId");
    const compactOperation = threadId
      ? this.#compactOperation(threadId)
      : undefined;
    if (threadId && turnId && compactOperation && this.#leases) {
      const lease = this.#leases.getLease(threadId);
      if (
        !lease ||
        lease.owner !== "bridge" ||
        lease.instanceId !== this.#bridgeInstanceId ||
        lease.operationId !== compactOperation.operationId ||
        lease.turnId !== turnId ||
        !this.#leases.release(lease)
      ) {
        return false;
      }
      this.#compactOperations.delete(threadId);
      this.#turnFailures.delete(turnFailureKey(threadId, turnId));
      const completionStatus = turn ? stringField(turn, "status") : null;
      try {
        await this.#notifyCompactCompletion(
          compactOperation.contextToken,
          turnId,
          completionStatus ?? null,
        );
      } finally {
        await this.#drainQueuedTurns();
      }
      return true;
    }
    if (
      !threadId ||
      !turnId ||
      !this.#codex?.readThread ||
      !this.#leases
    ) {
      return false;
    }

    const dispatch = this.#state.getDispatchIntentByTurnId(turnId);
    if (!dispatch || dispatch.status !== "accepted" || dispatch.threadId !== threadId) {
      return false;
    }
    const stoppedTurnKey = turnFailureKey(threadId, turnId);
    const existingFinalOutbox = this.#finalReplyOutbox(turnId);
    if (
      dispatch.completedAtMs !== null &&
      existingFinalOutbox.length > 0 &&
      existingFinalOutbox.every(({ status }) => status === "confirmed")
    ) {
      await this.#cleanupMedia(dispatch.dedupeKey);
      this.#turnFailures.delete(turnFailureKey(threadId, turnId));
      this.#userStoppedTurns.delete(stoppedTurnKey);
      await this.#drainQueuedTurns();
      this.#finishTyping(turnId);
      return true;
    }

    const mustPersistFinal =
      existingFinalOutbox.length === 0 || dispatch.completedAtMs === null;
    const completionStatus = turn ? stringField(turn, "status") : null;
    const completionError = turn ? objectField(turn, "error") : undefined;
    const rememberedFailure = this.#turnFailures.get(
      turnFailureKey(threadId, turnId),
    );
    const preliminaryFailureText = mustPersistFinal
      ? formatCodexTurnFailure(
          completionStatus,
          completionError,
          rememberedFailure,
        )
      : null;
    const knownLease =
      dispatch.completedAtMs === null ? this.#leases.getLease(threadId) : null;
    const exactDispatchLease =
      knownLease?.owner === "bridge" &&
      knownLease.operationId === dispatch.operationId &&
      knownLease.turnId === turnId
        ? knownLease
        : null;
    const needsThreadForLeaseRelease =
      dispatch.completedAtMs === null && exactDispatchLease === null;
    const readThread =
      mustPersistFinal &&
      (!preliminaryFailureText ||
        needsThreadForLeaseRelease ||
        completionStatus === null)
        ? (await this.#codex.readThread({ includeTurns: true, threadId })).thread
        : null;
    const persistedTurn = readThread
      ? findThreadTurn(readThread, turnId)
      : undefined;
    const effectiveCompletionStatus =
      completionStatus ??
      (persistedTurn ? stringField(persistedTurn, "status") : null);
    const suppressInterruptedFinal =
      effectiveCompletionStatus === "interrupted" &&
      this.#userStoppedTurns.has(stoppedTurnKey);
    const failureText = mustPersistFinal
      ? formatCodexTurnFailure(
          effectiveCompletionStatus,
          completionError ??
            (persistedTurn ? objectField(persistedTurn, "error") : undefined),
          rememberedFailure,
        )
      : null;
    const contextToken =
      existingFinalOutbox[0]?.contextToken ||
      dispatch.contextToken ||
      this.#state.getILinkState(this.#session.botId)?.contextToken;
    const attachmentIntents = mustPersistFinal
      ? this.#state.listOutboundAttachmentIntents(turnId)
      : [];
    const finalOutboxInput =
      mustPersistFinal && contextToken && !suppressInterruptedFinal
        ? this.#finalReplyInput(
            contextToken,
            failureText ??
              finalAgentText(readThread ?? {}, turnId) ??
              CODEX_EMPTY_REPLY_TEXT,
            turnId,
            failureText === null && effectiveCompletionStatus === "completed"
              ? attachmentIntents
              : [],
          )
        : null;
    if (dispatch.completedAtMs === null) {
      if (exactDispatchLease) {
        if (!this.#leases.release(exactDispatchLease)) {
          return false;
        }
      } else {
        const persistedDispatchTurn = readThread
          ? findThreadTurn(readThread, turnId)
          : undefined;
        if (
          !readThread ||
          !isExplicitlyIdleThread(readThread) ||
          !isTerminalTurnStatus(persistedDispatchTurn?.status)
        ) {
          return false;
        }
        if (knownLease) {
          const persistedLeaseTurn = knownLease.turnId
            ? findThreadTurn(readThread, knownLease.turnId)
            : undefined;
          if (
            !this.#leases.isHeldBy(knownLease) ||
            !isTerminalTurnStatus(persistedLeaseTurn?.status)
          ) {
            return false;
          }
        } else if (this.#leases.getLease(threadId) !== null) {
          return false;
        }
      }
      if (!contextToken) return false;
    }
    let finalOutbox = existingFinalOutbox;
    if (finalOutboxInput) {
      finalOutbox = this.#state.completeDispatchWithOutbox({
        completedAtMs: this.#now(),
        operationId: dispatch.operationId,
        outbox: finalOutboxInput,
        turnId,
      }).outbox;
    } else if (dispatch.completedAtMs === null) {
      this.#state.markDispatchCompleted(dispatch.operationId, turnId, this.#now());
    }
    this.#removeDetachedAttachmentSnapshots(attachmentIntents, finalOutbox);
    await this.#cleanupMedia(dispatch.dedupeKey);
    this.#turnFailures.delete(turnFailureKey(threadId, turnId));
    this.#userStoppedTurns.delete(stoppedTurnKey);
    try {
      await this.#sendFinalOutbox(finalOutbox);
    } finally {
      try {
        await this.#drainQueuedTurns();
      } finally {
        this.#finishTyping(turnId);
      }
    }
    return true;
  }

  async requestDesktopApproval(input: {
    requestId: string;
    signal: AbortSignal;
    summary: string;
    threadId: string;
    toolName: string | null;
    turnId: string;
  }): Promise<"allow" | "deny" | "passthrough"> {
    if (this.#closing) return "deny";
    const approvals = this.#approvals;
    if (!approvals || input.signal.aborted) return "passthrough";

    let settled = false;
    let resolveDecision!: (decision: "allow" | "deny" | "passthrough") => void;
    const decision = new Promise<"allow" | "deny" | "passthrough">(
      (resolve) => {
        resolveDecision = resolve;
      },
    );
    const finish = (behavior: "allow" | "deny" | "passthrough"): boolean => {
      if (settled) return false;
      settled = true;
      resolveDecision(behavior);
      return true;
    };
    const abort = () => {
      approvals.expire();
      finish("passthrough");
    };
    input.signal.addEventListener("abort", abort, { once: true });

    const method =
      input.toolName === "apply_patch"
        ? "item/fileChange/requestApproval"
        : "item/commandExecution/requestApproval";
    const ingested = await approvals.ingestCallback({
      isLive: () => !settled && !input.signal.aborted,
      method,
      params: {
        command: input.summary,
        itemId: input.requestId,
        threadId: input.threadId,
        turnId: input.turnId,
      },
      respond: (approved) => finish(approved ? "allow" : "deny"),
    });
    if (!ingested) finish("passthrough");

    try {
      return await decision;
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }

  async #handleSendFileCall(event: CodexEvent): Promise<boolean> {
    if (stringField(event.params, "tool") !== "send_file") return false;
    const respond = this.#codex?.respondToServerRequest;
    if (event.id === undefined || !respond) return false;
    const failure = (text: string): boolean =>
      respond.call(this.#codex, event.id!, {
        contentItems: [{ text, type: "inputText" }],
        success: false,
      }) !== false;
    const success = (): boolean =>
      respond.call(this.#codex, event.id!, {
        contentItems: [
          {
            text: "附件已登记，将随最终回复发送；不要再输出本地路径。",
            type: "inputText",
          },
        ],
        success: true,
      }) !== false;
    const threadId = stringField(event.params, "threadId");
    const turnId = stringField(event.params, "turnId");
    const callId = stringField(event.params, "callId");
    const argumentsValue = objectField(event.params, "arguments");
    const path = argumentsValue
      ? stringField(argumentsValue, "path")
      : undefined;
    if (
      !threadId ||
      !turnId ||
      !callId ||
      event.params.namespace !== null ||
      !argumentsValue ||
      Object.keys(argumentsValue).length !== 1 ||
      !path
    ) {
      return failure(
        "参数无效：path 必须是要发送的本机 Windows 绝对文件路径。",
      );
    }
    const dispatch = this.#state.getDispatchIntentByTurnId(turnId);
    if (
      !dispatch ||
      dispatch.status !== "accepted" ||
      dispatch.completedAtMs !== null ||
      dispatch.threadId !== threadId ||
      !this.#leases?.isHeldBy({
        instanceId: this.#bridgeInstanceId ?? "",
        operationId: dispatch.operationId,
        owner: "bridge",
        threadId,
        turnId,
      })
    ) {
      return failure("当前回合不属于微信入口，不能登记附件。");
    }
    if (!this.#outboundDirectory) {
      return failure("附件未登记：无法确认当前任务工作区。");
    }
    const existing = this.#state
      .listOutboundAttachmentIntents(turnId)
      .find((attachment) => attachment.callId === callId);
    if (existing) {
      if (existing.snapshotProvenance !== "staged-v1") {
        return failure("附件未登记：旧版附件记录不再受信任，请重新调用。");
      }
      try {
        stagedOutboundMedia({
          exportRoot: this.#outboundDirectory,
          label: existing.name,
          path: existing.path,
        });
        return success();
      } catch {
        return failure("附件未登记：旧版附件记录不再受信任，请重新调用。");
      }
    }
    if (!this.#codex?.readThread) {
      return failure("附件未登记：无法确认当前任务工作区。");
    }
    let workspaceRoot: string | undefined;
    try {
      const current = await this.#codex.readThread({
        includeTurns: false,
        threadId,
      });
      workspaceRoot = stringField(current.thread, "cwd");
    } catch {
      return failure("附件未登记：无法确认当前任务工作区。");
    }
    if (!workspaceRoot) {
      return failure("附件未登记：无法确认当前任务工作区。");
    }
    let media: ReturnType<typeof stageOutboundMedia> | undefined;
    try {
      media = stageOutboundMedia({
        exportRoot: this.#outboundDirectory,
        label: win32.basename(path.trim()),
        path,
        workspaceRoot,
      });
      this.#state.registerOutboundAttachmentIntent({
        callId,
        createdAtMs: this.#now(),
        kind: media.kind,
        name: media.name,
        operationId: dispatch.operationId,
        path: media.path,
        threadId,
        turnId,
      });
    } catch (error) {
      if (media) {
        removeOutboundMediaSnapshot(media.path, this.#outboundDirectory);
      }
      if (
        error instanceof OutboundAttachmentIntentError &&
        error.code === "TOO_MANY_ATTACHMENTS"
      ) {
        return failure("单次回复最多发送 2 个附件。");
      }
      if (
        error instanceof OutboundAttachmentIntentError &&
        error.code === "CALL_ID_COLLISION"
      ) {
        return failure("附件调用冲突，请重新调用。");
      }
      return failure(`附件未登记：${outboundMediaFailureText(error)}。`);
    }
    return success();
  }

  close(): void {
    this.beginShutdown();
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("E_BRIDGE_CLOSING"));
    }
    this.#approvals?.close();
  }

  beginShutdown(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#finishAllTyping();
  }

  async recoverPendingWork(): Promise<void> {
    this.#state.markPendingDispatchesUnknown(this.#now());
    await this.#persistRecoveredUnknownDiagnostics();
    this.#restoreTyping();
    await this.reconcilePendingWork();
    for (const inbound of this.#state.listInboundMessages()) {
      if (inbound.body === null) continue;
      const dedupeKey = `${this.#session.botId}/${this.#session.controllerUserId}/${inbound.messageId}`;
      if (this.#state.hasScheduledDedupeKey(dedupeKey)) {
        const dispatch = this.#state.getDispatchIntentByDedupeKey(dedupeKey);
        if (
          dispatch?.status === "unknown" &&
          !this.#state.getOutbox(
            `codex-ilink:${dispatch.operationId}:unknown`,
          )
        ) {
          continue;
        }
        this.#clearInbound(inbound.messageId);
        continue;
      }
      const failure = parseDurableInboundFailure(inbound.body);
      if (failure) {
        await this.#send(
          inbound.contextToken,
          inboundFailureText(failure),
          this.#inboundReplyClientId(inbound.messageId),
        );
        this.#clearInbound(inbound.messageId);
        continue;
      }
      let turnInput: DurableTurnInput;
      try {
        turnInput = parseDurableTurnInput(inbound.body);
      } catch {
        await this.#send(
          inbound.contextToken,
          inboundFailureText("invalid-media"),
          this.#inboundReplyClientId(inbound.messageId),
        );
        this.#clearInbound(inbound.messageId);
        continue;
      }
      await this.#processAcceptedTurn({
        contextToken: inbound.contextToken,
        messageId: inbound.messageId,
        turnInput,
      });
    }
    await this.#drainQueuedTurns();
  }

  async scheduleQueuedTurns(): Promise<void> {
    await this.#drainQueuedTurns();
  }

  async reconcilePendingWork(): Promise<void> {
    if (this.#reconcilePromise) return this.#reconcilePromise;
    const pending = (async () => {
      await this.#notifyExpiredBinding();
      await this.#reconcileDispatchLeases();
    })();
    this.#reconcilePromise = pending;
    try {
      await pending;
    } finally {
      if (this.#reconcilePromise === pending) this.#reconcilePromise = undefined;
    }
  }

  async #notifyExpiredBinding(): Promise<void> {
    const nowMs = this.#now();
    const binding = this.#state.getExpiredBindingForReminder(nowMs);
    if (!binding) return;
    const contextToken = this.#state.getILinkState(
      this.#session.botId,
    )?.contextToken;
    if (!contextToken) return;

    let title = binding.threadId;
    if (this.#codex?.readThread) {
      try {
        const read = await this.#codex.readThread({
          includeTurns: true,
          threadId: binding.threadId,
        });
        title =
          stringField(read.thread, "name") ??
          stringField(read.thread, "title") ??
          binding.threadId;
      } catch {
        // The routing reminder remains useful even if the preview is unavailable.
      }
    }
    const timeoutMinutes = Math.max(
      1,
      Math.round((binding.expiresAtMs - binding.updatedAtMs) / 60_000),
    );
    try {
      await this.#send(
        contextToken,
        [
          `会话“${title}”的微信绑定已因 ${String(timeoutMinutes)} 分钟无交互结束。`,
          "后续普通消息将进入微信主会话；原会话和运行中的任务仍保留，可用 s<n> 重新进入。",
        ].join("\n"),
        `codex-ilink:binding-expired:${binding.threadId}:${String(binding.updatedAtMs)}`,
      );
    } catch {
      // The durable outbox retries without blocking the user's next message.
      return;
    }
    this.#state.markBindingExpiryNotified(
      binding.threadId,
      binding.updatedAtMs,
      this.#now(),
    );
  }

  async #prepareInboundMessage(
    message: Exclude<ParsedControllerMessage, { kind: "ignored" }>,
  ): Promise<{
    body: string;
    failure: DurableInboundFailureCode | null;
    turnInput: DurableTurnInput | null;
  }> {
    const fail = (failure: DurableInboundFailureCode) => ({
      body: serializeDurableInboundFailure(failure),
      failure,
      turnInput: null,
    });
    if (message.kind === "unsupportedMedia") {
      return fail(
        message.mediaCandidates?.some(
          (candidate) =>
            candidate.status === "unsupported" && candidate.kind === "voice",
        )
          ? "voice-transcript-missing"
          : "unsupported-media",
      );
    }

    const intent = parseInboundText(message.text);
    if (intent.kind !== "message") {
      const turnInput: DurableTurnInput = {
        attachments: [],
        text: message.text,
        version: 1,
      };
      return {
        body: serializeDurableTurnInput(turnInput),
        failure: null,
        turnInput,
      };
    }
    if (message.hasUnsupportedMedia) return fail("unsupported-media");

    const candidates = message.mediaCandidates ?? [];
    if (
      candidates.some(
        (candidate) =>
          candidate.status === "unsupported" && candidate.kind === "voice",
      )
    ) {
      return fail("voice-transcript-missing");
    }
    if (candidates.length > 0 && !this.#media) {
      return fail("unsupported-media");
    }

    const dedupeKey = this.#dedupeKey(message.messageId);
    const attachments: DurableTurnAttachment[] = [];
    try {
      for (const candidate of candidates) {
        const resolved = await this.#media?.resolve({
          candidate,
          dedupeKey,
          signal: this.#shutdown.signal,
        });
        if (!resolved || resolved.status !== "stored") {
          return fail("voice-transcript-missing");
        }
        attachments.push({
          kind: resolved.kind,
          name: resolved.displayName,
          path: resolved.path,
        });
      }
    } catch (error) {
      return fail(inboundMediaFailureCode(error));
    }

    const turnInput: DurableTurnInput = {
      attachments,
      text: message.text,
      version: 1,
    };
    try {
      return {
        body: serializeDurableTurnInput(turnInput),
        failure: null,
        turnInput,
      };
    } catch {
      return fail("invalid-media");
    }
  }

  async #processAcceptedTurn(input: {
    contextToken: string;
    messageId: string;
    turnInput: DurableTurnInput;
  }): Promise<number> {
    await this.#notifyExpiredBinding();
    let intent = parseInboundText(input.turnInput.text);
    if (
      intent.kind === "message" &&
      input.turnInput.attachments.length === 0 &&
      this.#inboxDirectory &&
      this.#codex?.classifyControlIntent &&
      looksLikeControlRequest(input.turnInput.text)
    ) {
      try {
        const classified = routedControlIntent(
          await this.#codex.classifyControlIntent({
            cwd: this.#inboxDirectory,
            text: input.turnInput.text,
          }),
        );
        if (classified) intent = classified;
      } catch {
        // Classification is only a convenience fallback. Normal task delivery
        // remains available when the isolated router is unavailable.
      }
    }
    if (
      (intent.kind === "approve" || intent.kind === "deny") &&
      intent.code === null &&
      (this.#approvals?.list().length ?? 0) === 0
    ) {
      intent = { kind: "message", text: input.turnInput.text };
    }
    if (intent.kind !== "message" && !this.#claimInbound(input.messageId)) {
      // Another Bridge already claimed or terminally handled this control.
      // Only the atomic inbound winner may execute control side effects.
      return 0;
    }
    if (intent.kind === "unknownCommand") {
      return this.#replyToCommand(
        input.contextToken,
        input.messageId,
        `未知命令。\n${COMMAND_HELP}`,
      );
    }
    if (intent.kind === "message") {
      return this.#dispatchTurn({
        contextToken: input.contextToken,
        messageId: input.messageId,
        turnInput: {
          ...input.turnInput,
          text: intent.text,
        },
      });
    }
    this.#touchBinding();
    const controls: readonly AtomicControlIntent[] =
      intent.kind === "controlSequence"
        ? intent.intents
        : [intent];
    const replies: string[] = [];
    for (const control of controls) {
      const result = await this.#controlReply(control, input.contextToken);
      if (result.reply) replies.push(result.reply);
      if (!result.ok) break;
    }
    if (replies.length === 0) {
      this.#clearInbound(input.messageId);
      return 0;
    }
    return this.#replyToCommand(
      input.contextToken,
      input.messageId,
      replies.join("\n\n"),
    );
  }

  async #controlReply(
    intent: AtomicControlIntent,
    contextToken: string,
  ): Promise<ControlReplyResult> {
    if (intent.kind === "help") return { ok: true, reply: COMMAND_HELP };
    if (
      intent.kind === "clearSession" ||
      intent.kind === "compactSession" ||
      intent.kind === "stopTurn"
    ) {
      try {
        const reply =
          intent.kind === "clearSession"
            ? await this.#clearSessionReply()
            : intent.kind === "compactSession"
              ? await this.#compactSessionReply(contextToken)
              : await this.#stopTurnReply();
        return { ok: true, reply };
      } catch (error) {
        const action =
          intent.kind === "clearSession"
            ? "清除上下文"
            : intent.kind === "compactSession"
              ? "压缩上下文"
              : "停止任务";
        const code =
          intent.kind === "clearSession"
            ? "E_CONTEXT_CLEAR"
            : intent.kind === "compactSession"
              ? "E_CONTEXT_COMPACT"
              : "E_TURN_STOP";
        return controlFailureReply(
          error,
          `${code}：${action}失败，请稍后重试。`,
        );
      }
    }
    if (intent.kind === "projects" || intent.kind === "selectProject") {
      try {
        const reply =
          intent.kind === "projects"
            ? await this.#projectListReply()
            : await this.#selectProjectReply(intent.index);
        return { ok: true, reply };
      } catch (error) {
        return controlFailureReply(error, "项目命令执行失败，请稍后重试。");
      }
    }
    if (intent.kind === "sessions" || intent.kind === "enterSession") {
      try {
        const reply =
          intent.kind === "sessions"
            ? await this.#sessionListReply(intent.page)
            : await this.#enterSessionReply(intent.index);
        return { ok: true, reply };
      } catch (error) {
        return controlFailureReply(error, "会话命令执行失败，请稍后重试。");
      }
    }
    if (intent.kind === "permissions") {
      try {
        const reply = await this.#permissionReply();
        return { ok: true, reply };
      } catch (error) {
        return controlFailureReply(error, "权限查询失败，请稍后重试。");
      }
    }
    if (intent.kind === "models" || intent.kind === "selectModel") {
      try {
        const reply = await this.#modelReply(
          intent.kind === "selectModel"
            ? "id" in intent
              ? { id: intent.id }
              : { index: intent.index }
            : {},
        );
        return { ok: true, reply };
      } catch (error) {
        return controlFailureReply(error, "模型命令执行失败，请稍后重试。");
      }
    }
    if (intent.kind === "efforts" || intent.kind === "selectEffort") {
      try {
        const reply = await this.#effortReply(
          intent.kind === "selectEffort"
            ? "effort" in intent
              ? { effort: intent.effort }
              : { index: intent.index }
            : {},
        );
        return { ok: true, reply };
      } catch (error) {
        return controlFailureReply(
          error,
          "推理强度命令执行失败，请稍后重试。",
        );
      }
    }
    if (
      intent.kind === "newSession" ||
      intent.kind === "exitSession" ||
      intent.kind === "status"
    ) {
      try {
        const reply =
          intent.kind === "newSession"
            ? await this.#newSessionReply()
            : intent.kind === "exitSession"
              ? this.#exitSessionReply()
              : await this.#statusReply();
        return { ok: true, reply };
      } catch (error) {
        return controlFailureReply(error, "命令执行失败，请稍后重试。");
      }
    }

    const decision = this.#approvals?.decide(
      intent.code,
      intent.kind === "approve",
    );
    if (decision?.kind === "decided") {
      return { ok: true, reply: null };
    }
    const reply =
      decision?.kind === "ambiguous"
        ? formatAmbiguousApprovals(decision.approvals)
        : intent.code
          ? `审批 ${intent.code} 已失效或不存在。`
          : "当前没有待审批。";
    return { ok: false, reply };
  }

  async #send(
    contextToken: string,
    text: string,
    requestedClientId?: string,
  ): Promise<boolean> {
    const clientId = requestedClientId ?? this.#newId();
    if (this.#state.getOutbox(clientId)?.status === "confirmed") return false;
    const createdAtMs = this.#now();
    this.#state.enqueueOutbox({
      body: text,
      clientId,
      contextToken,
      createdAtMs,
      targetUserId: this.#session.controllerUserId,
    });
    try {
      await this.#ilink.sendText({
        clientId,
        contextToken,
        session: this.#session,
        signal: this.#shutdown.signal,
        text,
      });
      this.#ilinkHealthy = true;
    } catch (error) {
      this.#ilinkHealthy = false;
      throw error;
    }
    this.#state.confirmOutbox(clientId, this.#now());
    return true;
  }

  async #persistUnknownDiagnostic(
    contextToken: string,
    operationId: string,
    text: string,
  ): Promise<void> {
    const clientId = `codex-ilink:${operationId}:unknown`;
    const existing = this.#state.getOutbox(clientId);
    if (existing?.status === "confirmed") return;
    const item =
      existing ??
      this.#state.enqueueOutbox({
        body: text,
        clientId,
        contextToken,
        createdAtMs: this.#now(),
        targetUserId: this.#session.controllerUserId,
      });
    if (item.body === null) throw new Error("pending unknown diagnostic has no body");
    try {
      await this.#ilink.sendText({
        clientId: item.clientId,
        contextToken: item.contextToken,
        session: this.#session,
        signal: this.#shutdown.signal,
        text: item.body,
      });
    } catch {
      // The durable outbox owns later replay with the same client id.
      return;
    }
    this.#state.confirmOutbox(item.clientId, this.#now());
  }

  async #persistRecoveredUnknownDiagnostics(): Promise<void> {
    const inboundByDedupeKey = new Map(
      this.#state.listInboundMessages().map((inbound) => [
        `${inbound.accountId}/${inbound.controllerUserId}/${inbound.messageId}`,
        inbound,
      ]),
    );
    for (const dispatch of this.#state.listUnresolvedDispatchIntents()) {
      if (dispatch.status !== "unknown") continue;
      const inbound = inboundByDedupeKey.get(dispatch.dedupeKey);
      const contextToken =
        dispatch.contextToken ||
        inbound?.contextToken ||
        this.#state.getILinkState(this.#session.botId)?.contextToken;
      if (!contextToken) {
        continue;
      }
      await this.#persistUnknownDiagnostic(
        contextToken,
        dispatch.operationId,
        CODEX_OUTCOME_UNKNOWN_TEXT,
      );
      if (inbound) this.#clearInbound(inbound.messageId);
    }
  }

  #finalReplyInput(
    contextToken: string,
    text: string,
    turnId: string,
    registeredAttachments: readonly OutboundAttachmentIntent[],
  ): PendingOutboxInput[] {
    const extracted = extractWechatLocalFileReferences(text);
    const mediaBodies: string[] = [];
    const mediaFailures: string[] = [];
    if (extracted.references.length > 0) {
      mediaFailures.push(
        registeredAttachments.length > 0
          ? "⚠️ 已忽略回复中的本地路径；附件仅按 send_file 的登记结果发送。"
          : "⚠️ 本地文件未发送；请在微信中新建 iLink 任务后使用 send_file。",
      );
    }
    if (
      registeredAttachments.some(
        ({ snapshotProvenance }) => snapshotProvenance !== "staged-v1",
      )
    ) {
      mediaFailures.push(LEGACY_ATTACHMENT_REJECTED_TEXT);
    }
    const uniqueReferences: Array<{ label: string; path: string }> = [];
    const seenPaths = new Set<string>();
    for (const reference of [
      ...registeredAttachments
        .filter(({ snapshotProvenance }) => snapshotProvenance === "staged-v1")
        .map((attachment) => ({
          label: attachment.name,
          path: attachment.path,
          pathKey: attachment.pathKey,
        })),
    ]) {
      if (seenPaths.has(reference.pathKey)) continue;
      seenPaths.add(reference.pathKey);
      uniqueReferences.push({ label: reference.label, path: reference.path });
    }
    for (const reference of uniqueReferences.slice(0, 2)) {
      try {
        mediaBodies.push(
          serializeOutboundPayload(
            stagedOutboundMedia({
              exportRoot: this.#outboundDirectory ?? "",
              label: reference.label,
              path: reference.path,
            }),
          ),
        );
      } catch (error) {
        mediaFailures.push(
          `⚠️ 附件“${reference.label}”未发送：${outboundMediaFailureText(error)}`,
        );
      }
    }
    if (uniqueReferences.length > 2) {
      mediaFailures.push("⚠️ 单次回复最多发送 2 个附件，其余未发送。");
    }
    const finalText = [...mediaFailures, extracted.text]
      .filter((part) => part.length > 0)
      .join("\n\n");
    const messages = formatWechatFinalReply(finalText, {
      maxMessages: 3 - mediaBodies.length,
    });
    const bodies = [...mediaBodies, ...messages];
    if (bodies.length === 0) bodies.push(CODEX_EMPTY_REPLY_TEXT);
    const baseClientId = `codex-ilink:${turnId}:final`;
    const createdAtMs = this.#now();
    return bodies.map((body, index) => ({
      body,
      clientId:
        bodies.length === 1
          ? baseClientId
          : `${baseClientId}:part:${String(index + 1)}`,
      contextToken,
      createdAtMs,
      targetUserId: this.#session.controllerUserId,
    }));
  }

  async #sendFinalOutbox(items: readonly OutboxItem[]): Promise<void> {
    for (const item of items) {
      if (item.status === "confirmed") continue;
      if (item.body === null) throw new Error("pending final reply has no body");
      await dispatchOutboxItem({
        contextToken: item.contextToken,
        ilink: this.#ilink,
        item,
        ...(this.#outboundDirectory
          ? { outboundDirectory: this.#outboundDirectory }
          : {}),
        session: this.#session,
        signal: this.#shutdown.signal,
        state: this.#state,
      });
      this.#state.confirmOutbox(item.clientId, this.#now());
    }
  }

  #removeDetachedAttachmentSnapshots(
    attachments: readonly OutboundAttachmentIntent[],
    outbox: readonly OutboxItem[],
  ): void {
    if (!this.#outboundDirectory || attachments.length === 0) return;
    const referenced = new Set<string>();
    for (const item of outbox) {
      if (!item.body) continue;
      try {
        const payload = parseOutboundPayload(item.body);
        if (payload.type === "local-media" && payload.staged === true) {
          referenced.add(payload.path.toLowerCase());
        }
      } catch {
        // Invalid payloads do not authorize retaining a private snapshot.
      }
    }
    for (const attachment of attachments) {
      if (attachment.snapshotProvenance !== "staged-v1") continue;
      if (!referenced.has(attachment.path.toLowerCase())) {
        removeOutboundMediaSnapshot(
          attachment.path,
          this.#outboundDirectory,
        );
      }
    }
  }

  #finalReplyOutbox(turnId: string): OutboxItem[] {
    const baseClientId = `codex-ilink:${turnId}:final`;
    const single = this.#state.getOutbox(baseClientId);
    if (single) return [single];
    return Array.from({ length: 3 }, (_, index) =>
      this.#state.getOutbox(`${baseClientId}:part:${String(index + 1)}`),
    ).filter((item): item is OutboxItem => item !== null);
  }

  async #replyToCommand(
    contextToken: string,
    messageId: string,
    text: string,
  ): Promise<number> {
    try {
      return (await this.#send(
        contextToken,
        text,
        this.#inboundReplyClientId(messageId),
      ))
        ? 1
        : 0;
    } finally {
      this.#clearInbound(messageId);
    }
  }

  #inboundReplyClientId(messageId: string): string {
    return `codex-ilink:inbound:${this.#session.botId}:${messageId}:reply`;
  }

  async #projectListReply(): Promise<string> {
    const projects = await this.#refreshProjectSnapshot();
    if (projects.length === 0) {
      return "暂无可选项目。";
    }
    return [
      "项目",
      ...projects.map(
        (project, index) => `${String(index + 1)}. ${project.name}`,
      ),
      "使用 p<n> 选择项目；编号自本列表生成起 10 分钟内有效。",
    ].join("\n");
  }

  async #refreshProjectSnapshot(): Promise<readonly ProjectNavigationEntry[]> {
    if (!this.#inboxDirectory || !this.#listProjects) {
      throw new Error("project navigation is not configured");
    }
    const projects = [...(await this.#listProjects())].filter(
      (project) => !sameWindowsPath(project.cwd, this.#inboxDirectory ?? ""),
    );
    const nowMs = this.#now();
    this.#state.replaceProjectSnapshot({
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 10 * 60 * 1_000,
      projects: projects.map(({ cwd }) => cwd),
    });
    return projects;
  }

  async #selectProjectReply(index: number): Promise<string> {
    let snapshot = this.#state.getProjectSnapshot(this.#now());
    if (!snapshot) {
      await this.#refreshProjectSnapshot();
      snapshot = this.#state.getProjectSnapshot(this.#now());
    }
    if (!snapshot) throw new Error("project snapshot was not created");
    const projectPath = snapshot.projects[index - 1];
    if (!projectPath) {
      throw new ControlCommandRejected("项目编号无效，请按 p 当前列表选择。");
    }
    this.#state.selectProjectForNavigation(projectPath);
    return `已选择项目：${projectDisplayName(projectPath)}\n已退出原会话；使用 s 查看或 new 新建。`;
  }

  async #sessionListReply(
    mode: "archived" | "first" | "next",
  ): Promise<string> {
    if (!this.#inboxDirectory) {
      throw new Error("session navigation is not configured");
    }
    let archived = mode === "archived";
    let pageNumber = 1;
    if (mode === "next") {
      const previous = this.#state.getSessionSnapshot(this.#now());
      if (!previous) {
        throw new ControlCommandRejected(
          "会话列表已过期，请先用 s 或 sarc 刷新。",
        );
      }
      if (!previous.hasNext) {
        throw new ControlCommandRejected("当前会话列表没有下一页。");
      }
      archived = previous.archived;
      pageNumber = previous.page + 1;
    }
    const { currentProject, page } = await this.#refreshSessionSnapshot(
      archived,
      pageNumber,
    );
    const scope = projectDisplayName(currentProject);
    if (page.items.length === 0) {
      return `${archived ? "归档会话" : "会话"} · ${scope}\n暂无会话。`;
    }
    return [
      `${archived ? "归档会话" : "会话"} · ${scope} · 第 ${String(page.page)} 页`,
      ...page.items.map((thread, index) => {
        const title = thread.title ?? thread.id;
        const status = thread.status ?? "unknown";
        return `${String(index + 1)}. ${title} [${status}]`;
      }),
      ...(page.hasNext ? ["下一页：s+"] : []),
      "使用 s<n> 进入会话；编号自本页生成起 10 分钟内有效。",
    ].join("\n");
  }

  async #refreshSessionSnapshot(archived: boolean, pageNumber: number) {
    if (!this.#inboxDirectory) {
      throw new Error("session navigation is not configured");
    }
    const currentProject = this.#state.getBridgeSettings().selectedProjectPath;
    const rawPages = await this.#listThreadPages(archived);
    const page = paginateThreads(rawPages, {
      archived,
      inboxCwd: this.#inboxDirectory,
      mainThreadId: this.#mainThreadId ?? null,
      page: pageNumber,
      projectCwd: currentProject,
    });
    const nowMs = this.#now();
    this.#state.replaceSessionSnapshot({
      archived,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 10 * 60 * 1_000,
      hasNext: page.hasNext,
      page: page.page,
      projectPath: currentProject,
      threads: page.items.map((thread) => ({
        archived,
        projectPath: currentProject,
        threadId: thread.id,
      })),
    });
    return { currentProject, page };
  }

  async #enterSessionReply(index: number): Promise<string> {
    const nowMs = this.#now();
    let snapshot = this.#state.getSessionSnapshot(nowMs);
    if (!snapshot) {
      await this.#refreshSessionSnapshot(false, 1);
      snapshot = this.#state.getSessionSnapshot(this.#now());
    }
    if (!snapshot) throw new Error("session snapshot was not created");
    const target = snapshot.threads[index - 1];
    if (!target) {
      throw new ControlCommandRejected("会话编号无效，请按当前 s 列表选择。");
    }
    if (
      !this.#codex?.resumeThread ||
      !this.#codex.readThread ||
      (target.archived && !this.#codex.unarchiveThread)
    ) {
      throw new Error("session resume is not configured");
    }
    if (target.archived) {
      await this.#codex.unarchiveThread?.(target.threadId);
    }
    const resumed = await this.#resumeThreadForControl(target.threadId);
    this.#state.setBindingForNavigation({
      expiresAtMs: nowMs + this.#bindingIdleTimeoutMs(),
      projectPath: target.projectPath,
      threadId: target.threadId,
      updatedAtMs: nowMs,
    });
    let preview: ThreadPreview | null = null;
    try {
      const read = await this.#codex.readThread({
        includeTurns: true,
        threadId: target.threadId,
      });
      preview = buildThreadPreview(read, resumed);
    } catch {
      // Resume is already committed. A missing preview must not make the user
      // believe that navigation itself failed.
    }
    return [
      ...(target.archived ? ["Unarchived"] : []),
      this.#formatThreadPreview(preview, target.threadId),
      `${String(this.#bindingIdleTimeoutMinutes())} 分钟无活动后自动退出。`,
    ].join("\n");
  }

  #formatThreadPreview(preview: ThreadPreview | null, threadId: string): string {
    if (!preview) return `已进入会话：${threadId}`;
    return [
      `已进入会话：${preview.title ?? preview.id}`,
      `状态：${preview.status ?? "未知"}`,
      `模型：${preview.model ? compactModelName(preview.model, " ") : "未知"}`,
      `强度：${preview.reasoningEffort ?? "未知"}`,
      `权限：${preview.approvalsReviewer ?? "未知"}`,
      "",
      `最近提问：${preview.latestUserText ?? "（无）"}`,
      `最近回复：${preview.finalAgentText ?? "（无）"}`,
    ].join("\n");
  }

  async #newSessionReply(): Promise<string> {
    return this.#startSessionReply(
      this.#state.getBridgeSettings().selectedProjectPath,
    );
  }

  async #startSessionReply(
    projectPath: string | null,
    mode: "clear" | "new" = "new",
  ): Promise<string> {
    if (!this.#codex?.startThread || !this.#inboxDirectory) {
      throw new Error("new session is not configured");
    }
    const cwd = projectPath ?? this.#inboxDirectory;
    const started = await this.#codex.startThread(
      cwd,
      this.#state.getDefaultThreadPermissionSettings(),
    );
    const threadId = stringField(started.thread, "id");
    if (!threadId) throw new Error("Codex did not return a thread id");
    const nowMs = this.#now();
    this.#state.setBindingForNavigation({
      expiresAtMs: nowMs + this.#bindingIdleTimeoutMs(),
      projectPath,
      threadId,
      updatedAtMs: nowMs,
    });
    return [
      mode === "clear"
        ? "已清除当前上下文并进入空白会话。"
        : `已新建并进入会话：${threadId}`,
      `项目：${projectDisplayName(projectPath)}`,
      `权限：${approvalsReviewerText(started)}`,
      `${String(this.#bindingIdleTimeoutMinutes())} 分钟无活动后自动退出。`,
    ].join("\n");
  }

  async #clearSessionReply(): Promise<string> {
    if (!this.#bridgeInstanceId || !this.#leases) {
      throw new Error("atomic context clearing is not configured");
    }
    const binding = this.#state.getBinding(this.#now());
    const threadId = binding?.threadId ?? this.#currentThreadId();
    const projectPath = await this.#clearProjectPath(binding, threadId);
    if (this.#threadHasScheduledWork(threadId)) {
      throw new ControlCommandRejected(
        "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。",
      );
    }
    const operationId = this.#newId();
    const acquired = this.#leases.tryAcquire({
      createdAtMs: this.#now(),
      instanceId: this.#bridgeInstanceId,
      operationId,
      owner: "bridge",
      threadId,
      turnId: null,
    });
    if (!acquired.acquired) {
      throw new ControlCommandRejected(
        "当前会话正在被其他任务使用，请先用 stop 停止或等待任务结束。",
      );
    }
    this.#clearOperations.set(threadId, operationId);
    try {
      if (this.#threadHasScheduledWork(threadId)) {
        throw new ControlCommandRejected(
          "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。",
        );
      }
      if (!binding && threadId === this.#mainThreadId) {
        return await this.#replaceMainSessionReply(threadId);
      }
      const replacement = await this.#startSessionReply(projectPath, "clear");
      const archived = await this.#archiveClearedThread(threadId);
      return [
        replacement,
        archived
          ? "原会话已归档，可用 sarc 查看。"
          : "原会话仍保留在任务列表中。",
      ].join("\n");
    } finally {
      this.#clearOperations.delete(threadId);
      this.#leases.release(acquired.lease);
    }
  }

  async #compactSessionReply(contextToken: string): Promise<string> {
    if (
      !this.#bridgeInstanceId ||
      !this.#codex?.compactThread ||
      !this.#leases
    ) {
      throw new Error("context compaction is not configured");
    }
    const threadId = this.#currentThreadId();
    if (this.#threadHasPendingWork(threadId)) {
      throw new ControlCommandRejected(
        "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。",
      );
    }

    const operationId = this.#newId();
    const acquired = this.#leases.tryAcquire({
      createdAtMs: this.#now(),
      instanceId: this.#bridgeInstanceId,
      operationId,
      owner: "bridge",
      threadId,
      turnId: null,
    });
    if (!acquired.acquired) {
      throw new ControlCommandRejected(
        "当前会话正在被其他任务使用，请稍后再 compact。",
      );
    }
    this.#compactOperations.set(threadId, {
      contextToken,
      operationId,
      unknownReason: null,
    });
    try {
      await this.#ensureThread(threadId);
      await this.#codex.compactThread(threadId);
    } catch (error) {
      if (error instanceof CodexOutcomeUnknownError) {
        this.#compactOperations.set(threadId, {
          contextToken,
          operationId,
          unknownReason: error.reason,
        });
        throw new ControlCommandRejected(
          "压缩请求结果未知，请在 Desktop 查看；确认结束前的新消息会自动排队。",
        );
      }
      this.#compactOperations.delete(threadId);
      this.#leases.release(acquired.lease);
      throw error;
    }
    return "已开始压缩当前会话上下文；完成前的新消息会自动排队。";
  }

  async #notifyCompactCompletion(
    contextToken: string,
    turnId: string,
    status: string | null,
  ): Promise<void> {
    if (status === "failed") {
      await this.#send(
        contextToken,
        "E_CONTEXT_COMPACT_FAILED：上下文压缩失败，请在 Desktop 查看。",
        `codex-ilink:compact:${turnId}:failed`,
      );
    } else if (status === "interrupted") {
      await this.#send(
        contextToken,
        "上下文压缩已停止。",
        `codex-ilink:compact:${turnId}:interrupted`,
      );
    }
  }

  async #stopTurnReply(): Promise<string> {
    if (!this.#codex?.interruptTurn) {
      throw new Error("turn interruption is not configured");
    }
    const threadId = this.#currentThreadId();
    const dispatch = this.#state
      .listUnresolvedDispatchIntents()
      .find(
        (candidate) =>
          candidate.threadId === threadId &&
          (candidate.status === "accepted" || candidate.status === "unknown") &&
          candidate.turnId !== null,
      );
    let turnId = dispatch?.turnId ?? null;
    const compactOperation = this.#compactOperation(threadId);
    const lease = this.#leases?.getLease(threadId) ?? null;
    if (
      !turnId &&
      compactOperation &&
      lease?.owner === "bridge" &&
      lease.operationId === compactOperation.operationId
    ) {
      turnId = lease.turnId;
    }
    if (!turnId) {
      const unresolved = this.#state
        .listUnresolvedDispatchIntents()
        .some((candidate) => candidate.threadId === threadId);
      if (unresolved || compactOperation) {
        throw new ControlCommandRejected(
          "当前任务尚未取得可中断的 Turn ID，请稍后再试。",
        );
      }
      if (lease?.owner === "desktop") {
        throw new ControlCommandRejected(
          "当前任务由 Desktop 发起，请在电脑端停止。",
        );
      }
      return "当前会话没有正在执行的微信任务。";
    }
    const stoppedTurnKey = turnFailureKey(threadId, turnId);
    this.#userStoppedTurns.add(stoppedTurnKey);
    if (this.#userStoppedTurns.size > MAX_REMEMBERED_CODEX_FAILURES) {
      const oldest = this.#userStoppedTurns.values().next().value;
      if (oldest !== undefined) this.#userStoppedTurns.delete(oldest);
    }
    try {
      await this.#codex.interruptTurn({ threadId, turnId });
    } catch (error) {
      if (error instanceof CodexOutcomeUnknownError) {
        throw new ControlCommandRejected(
          "停止请求结果未知，请在 Desktop 查看当前任务状态。",
        );
      }
      this.#userStoppedTurns.delete(stoppedTurnKey);
      throw error;
    }
    return "已请求停止当前任务。";
  }

  #compactOperation(
    threadId: string,
  ):
    | {
        contextToken: string;
        operationId: string;
        unknownReason: "eof" | "timeout" | null;
      }
    | undefined {
    const operation = this.#compactOperations.get(threadId);
    if (!operation) return undefined;
    const lease = this.#leases?.getLease(threadId) ?? null;
    if (
      lease?.owner === "bridge" &&
      lease.instanceId === this.#bridgeInstanceId &&
      lease.operationId === operation.operationId
    ) {
      return operation;
    }
    this.#compactOperations.delete(threadId);
    return undefined;
  }

  #activeControlOperationId(threadId: string): string | undefined {
    const compactOperation = this.#compactOperation(threadId);
    if (compactOperation && compactOperation.unknownReason !== "eof") {
      return compactOperation.operationId;
    }
    const clearOperationId = this.#clearOperations.get(threadId);
    if (!clearOperationId) return undefined;
    const lease = this.#leases?.getLease(threadId) ?? null;
    if (
      lease?.owner === "bridge" &&
      lease.instanceId === this.#bridgeInstanceId &&
      lease.operationId === clearOperationId
    ) {
      return clearOperationId;
    }
    this.#clearOperations.delete(threadId);
    return undefined;
  }

  async #clearProjectPath(
    binding: ReturnType<SqliteState["getBinding"]>,
    threadId: string,
  ): Promise<string | null> {
    if (!binding || threadId === this.#mainThreadId) return null;
    if (binding.projectPath) return binding.projectPath;
    if (!this.#inboxDirectory) {
      throw new Error("clear session environment is not configured");
    }
    const thread = await this.#readThreadForReconciliation(threadId);
    const cwd = stringField(thread, "cwd");
    if (!cwd || sameWindowsPath(cwd, this.#inboxDirectory)) return null;
    return cwd;
  }

  #currentThreadId(): string {
    const threadId =
      this.#state.getBinding(this.#now())?.threadId ?? this.#mainThreadId;
    if (!threadId) throw new Error("current session is not configured");
    return threadId;
  }

  #threadHasPendingWork(threadId: string): boolean {
    const lease = this.#leases?.getLease(threadId) ?? null;
    return this.#threadHasScheduledWork(threadId) || lease !== null;
  }

  #threadHasScheduledWork(threadId: string): boolean {
    return (
      this.#state.hasActiveDispatchForThread(threadId) ||
      this.#state.getDesktopTurnObservation(threadId) !== null ||
      this.#state.peekQueuedTurn(threadId) !== null
    );
  }

  async #permissionReply(): Promise<string> {
    if (!this.#codex?.resumeThread || !this.#mainThreadId) {
      throw new Error("permission metadata is not configured");
    }
    const binding = this.#state.getBinding(this.#now());
    const threadId = binding?.threadId ?? this.#mainThreadId;
    const current = await this.#resumeThreadForControl(threadId);
    return `权限：${approvalsReviewerText(current)}`;
  }

  async #replaceMainSessionReply(previousThreadId: string): Promise<string> {
    if (!this.#codex?.startThread || !this.#inboxDirectory) {
      throw new Error("main session replacement is not configured");
    }
    const started = await this.#codex.startThread(
      this.#inboxDirectory,
      this.#state.getDefaultThreadPermissionSettings(),
    );
    const threadId = stringField(started.thread, "id");
    if (!threadId) throw new Error("Codex did not return a thread id");
    try {
      await this.#codex.setThreadName?.({ name: "微信主会话", threadId });
    } catch {
      // The main identity is the durable thread id; naming is best-effort UI.
    }
    this.#state.replaceMainThreadForNavigation(threadId);
    this.#mainThreadId = threadId;
    const archived = await this.#archiveClearedThread(previousThreadId);
    return [
      "已清除微信主会话上下文，当前仍在微信主会话。",
      "当前未选择项目。",
      ...(archived ? [] : ["原主会话仍保留在任务列表中。"]),
    ].join("\n");
  }

  async #archiveClearedThread(threadId: string): Promise<boolean> {
    if (!this.#codex?.archiveThread) return false;
    try {
      await this.#codex.archiveThread(threadId);
      return true;
    } catch {
      return false;
    }
  }

  async #modelReply(selection: {
    id?: string;
    index?: number;
  }): Promise<string> {
    if (
      !this.#codex?.listModels ||
      !this.#codex.resumeThread ||
      !this.#codex.updateThreadModelSettings
    ) {
      throw new Error("model settings are not configured");
    }
    const threadId = this.#currentThreadId();
    const [models, current] = await Promise.all([
      this.#availableModels(),
      this.#resumeThreadForControl(threadId),
    ]);
    const currentModel = stringField(current, "model");
    const currentEffort = stringField(current, "reasoningEffort");

    if (selection.id !== undefined || selection.index !== undefined) {
      const selected =
        selection.id !== undefined
          ? findModelByReference(models, selection.id)
          : models[(selection.index as number) - 1];
      if (!selected) {
        throw new ControlCommandRejected(
          "模型不可用，请发送 model 查看当前可选模型。",
        );
      }
      const supportedEfforts = selected.supportedReasoningEfforts.map(
        (option) => option.reasoningEffort,
      );
      const effort =
        currentEffort && supportedEfforts.includes(currentEffort)
          ? currentEffort
          : supportedEfforts.includes(selected.defaultReasoningEffort)
            ? selected.defaultReasoningEffort
            : supportedEfforts[0];
      const changed = await this.#codex.updateThreadModelSettings(threadId, {
        ...(effort ? { effort } : {}),
        model: selected.model,
      });
      return [
        `模型：${formatModel(selected)}`,
        `强度：${stringField(changed, "reasoningEffort") ?? "未知"}`,
      ].join("\n");
    }

    const activeIndex = models.findIndex(
      (model) => model.model === currentModel || model.id === currentModel,
    );
    const activeModel = activeIndex >= 0 ? models[activeIndex] : undefined;
    return [
      `模型：${activeModel ? formatModel(activeModel) : currentModel ? compactModelName(currentModel, "-") : "未知"}`,
      ...models.map(
        (model, index) => `${String(index + 1)}. ${formatModel(model)}`,
      ),
      "回复 model<n> 切换。",
    ].join("\n");
  }

  async #effortReply(selection: {
    effort?: string;
    index?: number;
  }): Promise<string> {
    if (
      !this.#codex?.listModels ||
      !this.#codex.resumeThread ||
      !this.#codex.updateThreadModelSettings
    ) {
      throw new Error("model settings are not configured");
    }
    const threadId = this.#currentThreadId();
    const [models, current] = await Promise.all([
      this.#availableModels(),
      this.#resumeThreadForControl(threadId),
    ]);
    const currentModel = stringField(current, "model");
    const model = models.find(
      (candidate) =>
        candidate.model === currentModel || candidate.id === currentModel,
    );
    if (!model) {
      throw new ControlCommandRejected(
        "当前模型不在可选目录中，无法切换推理强度。",
      );
    }
    const options = model.supportedReasoningEfforts;

    if (selection.effort !== undefined || selection.index !== undefined) {
      const selected =
        selection.effort !== undefined
          ? options.find(
              (option) => option.reasoningEffort === selection.effort,
            )
          : options[(selection.index as number) - 1];
      if (!selected) {
        throw new ControlCommandRejected(
          `推理强度不可用，请发送 effort 查看 ${formatModel(model)} 支持的选项。`,
        );
      }
      await this.#codex.updateThreadModelSettings(threadId, {
        effort: selected.reasoningEffort,
      });
      return [
        `模型：${formatModel(model)}`,
        `强度：${selected.reasoningEffort}`,
      ].join("\n");
    }

    return [
      `模型：${formatModel(model)}`,
      `强度：${stringField(current, "reasoningEffort") ?? "未知"}`,
      ...options.map(
        (option, index) => `${String(index + 1)}. ${option.reasoningEffort}`,
      ),
      "回复 effort<n> 切换。",
    ].join("\n");
  }

  async #availableModels(): Promise<ModelCatalogEntry[]> {
    if (!this.#codex?.listModels) throw new Error("model list is not configured");
    const models: ModelCatalogEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const page = await this.#codex.listModels(
        cursor === undefined ? {} : { cursor },
      );
      models.push(
        ...page.data.filter(isModelCatalogEntry).filter((model) => !model.hidden),
      );
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) throw new Error("model list cursor repeated");
        seenCursors.add(cursor);
      }
    } while (cursor !== null);
    return models;
  }

  #exitSessionReply(): string {
    const binding = this.#state.getBinding(this.#now());
    const hadProject =
      this.#state.getBridgeSettings().selectedProjectPath !== null;
    this.#state.returnToMainForNavigation();
    const returned = hadProject
      ? "已返回微信主会话。已退出当前项目。"
      : "已返回微信主会话。";
    return binding
      ? [
          returned,
          "原会话和运行中的任务仍保留。",
        ].join("\n")
      : returned;
  }

  async #statusReply(): Promise<string> {
    const nowMs = this.#now();
    const projectPath = this.#state.getBridgeSettings().selectedProjectPath;
    const binding = this.#state.getBinding(nowMs);
    const notificationCount = this.#state.listLiveNotificationRoutes(nowMs).length;
    const queueCount = this.#state.countQueuedTurns();
    const arbitrationHealthy =
      this.#state.getBridgeRuntime()?.arbitrationEnabled === true;
    let codexHealthy = true;
    let threadPages: unknown[] = [];
    let active: ReturnType<typeof listActiveThreads> = [];
    try {
      threadPages = await this.#listThreadPages(false);
      active = listActiveThreads(threadPages);
    } catch {
      codexHealthy = false;
    }
    let permissionMetadata: Record<string, unknown> | null = null;
    const permissionThreadId = binding?.threadId ?? this.#mainThreadId;
    if (permissionThreadId && this.#codex?.resumeThread) {
      try {
        permissionMetadata = await this.#resumeThreadForControl(
          permissionThreadId,
        );
      } catch {
        codexHealthy = false;
      }
    }
    const knownActive = new Map(
      active.map((thread) => [
        thread.id,
        { id: thread.id, title: thread.title },
      ]),
    );
    const guardedThreadIds = new Set(this.#state.listGuardedThreadIds(nowMs));
    for (const lease of this.#leases?.listLeases() ?? []) {
      if (lease.owner === "desktop" && !guardedThreadIds.has(lease.threadId)) {
        continue;
      }
      if (knownActive.has(lease.threadId)) continue;
      knownActive.set(lease.threadId, {
        id: lease.threadId,
        title:
          lease.owner === "desktop"
            ? "Desktop 任务（租约活动，状态保守）"
            : "微信任务（租约活动，状态保守）",
      });
    }
    const knownActiveTasks = [...knownActive.values()];
    const pendingApprovals = this.#approvals?.list() ?? [];
    const retryingApprovalCount = pendingApprovals.filter(
      (approval) => approval.deliveryStatus === "retrying",
    ).length;
    const approvalDeliveryAttempts = pendingApprovals.reduce(
      (total, approval) => total + approval.deliveryAttempts,
      0,
    );
    const approvalReminderCount = pendingApprovals.reduce(
      (total, approval) => total + approval.reminderCount,
      0,
    );
    const approvalRemainingMinutes =
      pendingApprovals.length === 0
        ? 0
        : Math.max(
            0,
            Math.ceil(
              (Math.min(
                ...pendingApprovals.map((approval) => approval.expiresAtMs),
              ) -
                nowMs) /
                60_000,
            ),
          );
    const sessionTitle = binding
      ? (findThreadTitle(threadPages, binding.threadId) ?? "当前会话")
      : null;
    const session = binding
      ? `${sessionTitle}（剩余 ${String(Math.max(1, Math.ceil((binding.expiresAtMs - nowMs) / 60_000)))} 分钟）`
      : "微信主会话";
    const hasPendingWork =
      knownActiveTasks.length > 0 ||
      queueCount > 0 ||
      pendingApprovals.length > 0;
    const connectionsHealthy =
      codexHealthy && arbitrationHealthy && this.#ilinkHealthy;
    return [
      `项目：${projectDisplayName(projectPath)}`,
      `会话：${session}`,
      `模型：${formatModelAndEffort(
        permissionMetadata ? stringField(permissionMetadata, "model") : undefined,
        permissionMetadata
          ? stringField(permissionMetadata, "reasoningEffort")
          : undefined,
      )}`,
      `权限：${permissionMetadata ? approvalsReviewerText(permissionMetadata) : "未知"}`,
      ...(!hasPendingWork ? ["状态：空闲"] : []),
      ...(knownActiveTasks.length > 0
        ? [
            `活动任务：${String(knownActiveTasks.length)}`,
            ...knownActiveTasks.map(
              (thread) => `- ${thread.title ?? thread.id} (${thread.id})`,
            ),
          ]
        : []),
      ...(queueCount > 0 ? [`队列：${String(queueCount)}`] : []),
      ...(notificationCount > 0
        ? [`通知回复窗口：${String(notificationCount)}`]
        : []),
      ...(pendingApprovals.length > 0
        ? [
            `待审批：${String(pendingApprovals.length)}（${
              retryingApprovalCount > 0
                ? `通知重试中：${String(retryingApprovalCount)}`
                : "微信接口已接收"
            }；发送尝试：${String(approvalDeliveryAttempts)}；提醒：${String(approvalReminderCount)}；最短剩余：${String(approvalRemainingMinutes)} 分钟）`,
          ]
        : []),
      connectionsHealthy
        ? "连接：正常"
        : `连接：Codex ${codexHealthy ? "正常" : "异常"}；仲裁${arbitrationHealthy ? "正常" : "关闭"}；微信${this.#ilinkHealthy ? "正常" : "异常"}`,
    ].join("\n");
  }

  #touchBinding(): void {
    const nowMs = this.#now();
    const binding = this.#state.getBinding(nowMs);
    if (!binding) return;
    this.#state.setBinding({
      ...binding,
      expiresAtMs: nowMs + this.#bindingIdleTimeoutMs(),
      updatedAtMs: nowMs,
    });
  }

  #bindingIdleTimeoutMinutes(): number {
    return this.#state.getBridgeSettings().sessionTimeoutMinutes;
  }

  #bindingIdleTimeoutMs(): number {
    return this.#bindingIdleTimeoutMinutes() * 60 * 1_000;
  }

  async #listThreadPages(archived: boolean): Promise<unknown[]> {
    const listThreads = this.#codex?.listThreads;
    if (!listThreads) throw new Error("thread listing is not configured");
    const pages: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await listThreads.call(this.#codex, {
        archived,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      if (!page.nextCursor) return pages;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("thread list cursor cycle");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async #dispatchTurn(input: {
    contextToken: string;
    messageId: string;
    turnInput: DurableTurnInput;
  }): Promise<number> {
    if (
      !this.#bridgeInstanceId ||
      !this.#codex ||
      !this.#leases ||
      !this.#mainThreadId
    ) {
      throw new Error("Bridge Codex dispatch is not configured");
    }

    const nowMs = this.#now();
    const serializedInput = serializeDurableTurnInput(input.turnInput);
    const currentBinding = this.#state.getBinding(nowMs);
    const route = routeInboundText({
      binding: currentBinding
        ? {
            expiresAtMs: currentBinding.expiresAtMs,
            threadId: currentBinding.threadId,
            updatedAtMs: currentBinding.updatedAtMs,
          }
        : null,
      bindingIdleTimeoutMs: this.#bindingIdleTimeoutMs(),
      mainThreadId: this.#mainThreadId,
      notificationWindows: this.#state
        .listLiveNotificationRoutes(nowMs)
        .map(({ deliveredAtMs, expiresAtMs, threadId }) => ({
          deliveredAtMs,
          expiresAtMs,
          threadId,
        })),
      nowMs,
      text: input.turnInput.text,
    });
    if (route.kind === "ambiguousNotificationRoute") {
      if (!this.#claimInbound(input.messageId)) return 0;
      try {
        return await this.#replyToCommand(
          input.contextToken,
          input.messageId,
          "有多个可回复任务，请先用 p 选择项目，再用 s<n> 进入目标会话。",
        );
      } finally {
        await this.#cleanupMedia(this.#dedupeKey(input.messageId));
      }
    }
    const applyRouteBinding = (): void => {
      if (!route.binding) return;
      this.#state.setBinding({
        expiresAtMs: route.binding.expiresAtMs,
        projectPath:
          route.route === "binding" ? currentBinding?.projectPath ?? null : null,
        threadId: route.binding.threadId,
        updatedAtMs: nowMs,
      });
    };

    const dedupeKey = `${this.#session.botId}/${this.#session.controllerUserId}/${input.messageId}`;
    const notifyQueued = async (queued: { id: number }): Promise<number> => {
      try {
        await this.#send(input.contextToken, `Queued #${queued.id}`);
        return 1;
      } finally {
        await this.#drainQueuedTurns();
      }
    };
    const enqueueInbound = async (): Promise<number> => {
      const queued = this.#state.enqueueInboundTurn({
        accountId: this.#session.botId,
        body: serializedInput,
        contextToken: input.contextToken,
        controllerUserId: this.#session.controllerUserId,
        createdAtMs: nowMs,
        dedupeKey,
        messageId: input.messageId,
        threadId: route.threadId,
      });
      if (!queued) return 0;
      applyRouteBinding();
      return notifyQueued(queued);
    };
    if (
      this.#state.countActiveDispatches() >= MAX_ACTIVE_BRIDGE_TURNS ||
      this.#state.hasActiveDispatchForThread(route.threadId) ||
      this.#state.getDesktopTurnObservation(route.threadId) !== null ||
      this.#state.peekQueuedTurn(route.threadId) !== null
    ) {
      return enqueueInbound();
    }

    const operationId = this.#newId();
    const lease = this.#leases.tryAcquire({
      createdAtMs: nowMs,
      instanceId: this.#bridgeInstanceId,
      operationId,
      owner: "bridge",
      threadId: route.threadId,
      turnId: null,
    });
    if (!lease.acquired) {
      return enqueueInbound();
    }

    try {
      await this.#ensureThread(route.threadId);
    } catch (error) {
      try {
        if (isMissingThreadError(error)) {
          const failedOutbox =
            this.#state.rejectInboundMessageAndReleaseLeaseWithOutbox({
              accountId: this.#session.botId,
              controllerUserId: this.#session.controllerUserId,
              lease: lease.lease,
              messageId: input.messageId,
              outbox: {
                body: MISSING_THREAD_TEXT,
                clientId: this.#inboundReplyClientId(input.messageId),
                contextToken: input.contextToken,
                createdAtMs: this.#now(),
                targetUserId: this.#session.controllerUserId,
              },
            });
          if (!failedOutbox) return 0;
          if (currentBinding?.threadId === route.threadId) {
            this.#state.clearNavigationRoutes();
          }
          await this.#cleanupMedia(dedupeKey);
          await this.#sendPersistedOutbox(failedOutbox);
          return 1;
        }
        const failedOutbox =
          this.#state.rejectInboundMessageAndReleaseLeaseWithOutbox({
            accountId: this.#session.botId,
            controllerUserId: this.#session.controllerUserId,
            lease: lease.lease,
            messageId: input.messageId,
            outbox: {
              body: CODEX_THREAD_RESUME_FAILED_TEXT,
              clientId: this.#inboundReplyClientId(input.messageId),
              contextToken: input.contextToken,
              createdAtMs: this.#now(),
              targetUserId: this.#session.controllerUserId,
            },
          });
        if (!failedOutbox) return 0;
        await this.#cleanupMedia(dedupeKey);
        await this.#sendPersistedOutbox(failedOutbox);
        return 1;
      } finally {
        this.#leases.release(lease.lease);
        await this.#drainQueuedTurns();
      }
    }

    let admission: InboundDispatchAdmission;
    try {
      admission = this.#state.admitInboundDispatchWithLease({
        accountId: this.#session.botId,
        body: serializedInput,
        contextToken: input.contextToken,
        controllerUserId: this.#session.controllerUserId,
        createdAtMs: nowMs,
        dedupeKey,
        lease: lease.lease,
        maxActiveDispatches: MAX_ACTIVE_BRIDGE_TURNS,
        messageId: input.messageId,
        operationId,
        threadId: route.threadId,
      });
    } catch (error) {
      this.#leases.release(lease.lease);
      await this.#drainQueuedTurns();
      throw error;
    }
    if (admission.kind === "terminal") {
      await this.#drainQueuedTurns();
      return 0;
    }
    if (admission.kind === "queued") {
      applyRouteBinding();
      return notifyQueued(admission.queued);
    }
    applyRouteBinding();

    let started: { turn: { id: string } };
    try {
      started = await this.#codex.startTurn({
        ...(input.turnInput.attachments.length > 0
          ? { attachments: input.turnInput.attachments }
          : {}),
        clientUserMessageId: dedupeKey,
        text: input.turnInput.text,
        threadId: route.threadId,
      });
    } catch (error) {
      if (!(error instanceof CodexOutcomeUnknownError)) {
        await this.#completeRejectedDispatch({
          dedupeKey,
          lease: lease.lease,
          operationId,
          contextToken: input.contextToken,
        });
        await this.#drainQueuedTurns();
        return 1;
      }
      this.#state.markDispatchUnknown(operationId, this.#now());
      await this.#persistUnknownDiagnostic(
        input.contextToken,
        operationId,
        CODEX_OUTCOME_UNKNOWN_TEXT,
      );
      return 1;
    }
    this.#leases.claimBridgeTurn({
      instanceId: this.#bridgeInstanceId,
      threadId: route.threadId,
      turnId: started.turn.id,
    });
    if (
      !this.#leases.isHeldBy({
        instanceId: this.#bridgeInstanceId,
        operationId,
        owner: "bridge",
        threadId: route.threadId,
        turnId: started.turn.id,
      })
    ) {
      this.#state.markDispatchUnknown(
        operationId,
        this.#now(),
        started.turn.id,
      );
      await this.#persistUnknownDiagnostic(
        input.contextToken,
        operationId,
        HOOK_GUARD_UNKNOWN_TEXT,
      );
      return 1;
    }
    this.#state.markDispatchAccepted(operationId, started.turn.id, this.#now());
    this.#beginTyping(started.turn.id, input.contextToken);
    return 0;
  }

  async #reconcileDispatchLeases(): Promise<void> {
    if (!this.#codex?.readThread || !this.#leases) return;
    let releasedWork = false;
    const leasedOperations = new Set<string>();

    for (const lease of this.#leases.listLeases()) {
      if (lease.owner === "desktop") {
        if (!lease.turnId) continue;
        let thread: Record<string, unknown>;
        try {
          thread = await this.#readThreadForReconciliation(lease.threadId);
        } catch {
          continue;
        }
        const turn = findThreadTurn(thread, lease.turnId);
        if (
          isTerminalTurnStatus(turn?.status) &&
          this.#leases.releaseStoppedDesktop({
            threadId: lease.threadId,
            turnId: lease.turnId,
          })
        ) {
          releasedWork = true;
        }
        continue;
      }
      leasedOperations.add(lease.operationId);
      const dispatch = this.#state.getDispatchIntent(lease.operationId);
      if (!dispatch) {
        if (this.#activeControlOperationId(lease.threadId) === lease.operationId) {
          continue;
        }
        const compactOperation = this.#compactOperation(lease.threadId);
        let thread: Record<string, unknown>;
        try {
          thread = await this.#readThreadForReconciliation(lease.threadId);
        } catch {
          continue;
        }
        const leasedTurn = lease.turnId
          ? findThreadTurn(thread, lease.turnId)
          : null;
        const safeToRelease = lease.turnId
          ? isTerminalTurnStatus(leasedTurn?.status)
          : isExplicitlyIdleThread(thread);
        if (safeToRelease && this.#leases.release(lease)) {
          if (compactOperation?.operationId === lease.operationId) {
            this.#compactOperations.delete(lease.threadId);
            if (lease.turnId) {
              try {
                await this.#notifyCompactCompletion(
                  compactOperation.contextToken,
                  lease.turnId,
                  typeof leasedTurn?.status === "string"
                    ? leasedTurn.status
                    : null,
                );
              } catch {
                // The durable outbox retains the terminal notification.
              }
            }
          }
          releasedWork = true;
        }
        continue;
      }
      if (dispatch.threadId !== lease.threadId) continue;

      let thread: Record<string, unknown>;
      try {
        thread = await this.#readThreadForReconciliation(lease.threadId);
      } catch {
        if (dispatch.status === "accepted") {
          await this.#notifySlowDispatch(dispatch);
        }
        continue;
      }

      if (dispatch.status === "accepted") {
        if (dispatch.turnId === null || dispatch.turnId !== lease.turnId) continue;
        const turn = findThreadTurn(thread, dispatch.turnId);
        if (!turn || !isTerminalTurnStatus(turn.status)) {
          await this.#notifySlowDispatch(dispatch);
          continue;
        }
        if (dispatch.completedAtMs !== null && !this.#leases.release(lease)) {
          continue;
        }
        try {
          await this.ingestCodexEvent({
            method: "turn/completed",
            params: {
              threadId: lease.threadId,
              turn,
            },
          });
        } catch {
          // Completion state and the durable final-reply outbox are reconciled
          // independently on the next poll.
        }
        continue;
      }

      if (dispatch.status !== "unknown" || dispatch.completedAtMs !== null) {
        continue;
      }
      if (dispatch.turnId && lease.turnId && dispatch.turnId !== lease.turnId) {
        continue;
      }
      const turnId = dispatch.turnId ?? lease.turnId;
      if (turnId) {
        const turn = findThreadTurn(thread, turnId);
        if (!isTerminalTurnStatus(turn?.status)) continue;
        this.#state.markDispatchUnknown(dispatch.operationId, this.#now(), turnId);
      } else if (!isExplicitlyIdleThread(thread)) {
        continue;
      }
      if (!this.#leases.release(lease)) continue;
      this.#state.resolveUnknownDispatch(dispatch.operationId, this.#now());
      await this.#cleanupMedia(dispatch.dedupeKey);
      releasedWork = true;
    }

    for (const dispatch of this.#state.listUnresolvedDispatchIntents()) {
      const threadLease = this.#leases.getLease(dispatch.threadId);
      if (
        leasedOperations.has(dispatch.operationId) ||
        (threadLease !== null && dispatch.status !== "accepted") ||
        (dispatch.status !== "accepted" && dispatch.status !== "unknown")
      ) {
        continue;
      }
      let thread: Record<string, unknown>;
      try {
        thread = await this.#readThreadForReconciliation(dispatch.threadId);
      } catch {
        if (dispatch.status === "accepted") {
          await this.#notifySlowDispatch(dispatch);
        }
        continue;
      }
      if (!isExplicitlyIdleThread(thread)) continue;

      if (dispatch.status === "accepted") {
        if (dispatch.turnId === null) continue;
        const turn = findThreadTurn(thread, dispatch.turnId);
        if (!turn || !isTerminalTurnStatus(turn.status)) {
          await this.#notifySlowDispatch(dispatch);
          continue;
        }
        try {
          await this.ingestCodexEvent({
            method: "turn/completed",
            params: {
              threadId: dispatch.threadId,
              turn,
            },
          });
        } catch {
          // Completion state and the durable final-reply outbox are reconciled
          // independently on the next poll.
        }
        continue;
      }

      if (dispatch.turnId) {
        const turn = findThreadTurn(thread, dispatch.turnId);
        if (!isTerminalTurnStatus(turn?.status)) continue;
      }
      this.#state.resolveUnknownDispatch(dispatch.operationId, this.#now());
      await this.#cleanupMedia(dispatch.dedupeKey);
      releasedWork = true;
    }

    for (const observation of this.#state.listStoppedDesktopTurnObservations()) {
      let thread: Record<string, unknown>;
      try {
        thread = await this.#readThreadForReconciliation(observation.threadId);
      } catch {
        continue;
      }
      if (
        isTerminalTurnStatus(findThreadTurn(thread, observation.turnId)?.status) &&
        this.#state.releaseStoppedDesktopTurnObservation(observation)
      ) {
        releasedWork = true;
      }
    }

    if (releasedWork) await this.#drainQueuedTurns();
  }

  async #drainQueuedTurns(): Promise<void> {
    if (
      this.#closing ||
      !this.#bridgeInstanceId ||
      (!this.#codex?.ensureThread && !this.#codex?.resumeThread) ||
      !this.#leases
    ) {
      return;
    }

    let rescan = true;
    while (rescan) {
      rescan = false;
      for (const queued of this.#state.listQueuedTurns()) {
        if (this.#state.countActiveDispatches() >= MAX_ACTIVE_BRIDGE_TURNS) return;
        if (this.#state.hasActiveDispatchForThread(queued.threadId)) continue;
        if (this.#state.getDesktopTurnObservation(queued.threadId)) continue;
        const contextToken =
          queued.contextToken ||
          this.#state.getILinkState(this.#session.botId)?.contextToken;
        if (!contextToken) continue;
        const head = this.#state.peekQueuedTurn(queued.threadId);
        if (
          !head ||
          head.id !== queued.id ||
          head.dedupeKey !== queued.dedupeKey
        ) {
          continue;
        }
        try {
          parseDurableTurnInput(queued.body);
        } catch {
          const failedOutbox = this.#state.rejectQueuedTurnWithOutbox({
            dedupeKey: queued.dedupeKey,
            queuedTurnId: queued.id,
            threadId: queued.threadId,
            outbox: {
              body: inboundFailureText("invalid-media"),
              clientId: queuedFailureClientId(queued.dedupeKey, "invalid-input"),
              contextToken,
              createdAtMs: this.#now(),
              targetUserId: this.#session.controllerUserId,
            },
          });
          if (!failedOutbox) {
            rescan = true;
            continue;
          }
          await this.#cleanupMedia(queued.dedupeKey);
          await this.#sendPersistedOutbox(failedOutbox);
          continue;
        }

        const operationId = this.#newId();
        const lease = this.#leases.tryAcquire({
          createdAtMs: this.#now(),
          instanceId: this.#bridgeInstanceId,
          operationId,
          owner: "bridge",
          threadId: queued.threadId,
          turnId: null,
        });
        if (!lease.acquired) continue;

        try {
          await this.#ensureThread(queued.threadId);
        } catch (error) {
          let failedOutbox: OutboxItem | null;
          try {
            failedOutbox =
              this.#state.rejectQueuedTurnAndReleaseLeaseWithOutbox({
                dedupeKey: queued.dedupeKey,
                lease: lease.lease,
                queuedTurnId: queued.id,
                threadId: queued.threadId,
                outbox: {
                  body: isMissingThreadError(error)
                    ? MISSING_THREAD_TEXT
                    : CODEX_THREAD_RESUME_FAILED_TEXT,
                  clientId: queuedFailureClientId(
                    queued.dedupeKey,
                    isMissingThreadError(error)
                      ? "missing-thread"
                      : "resume-failed",
                  ),
                  contextToken,
                  createdAtMs: this.#now(),
                  targetUserId: this.#session.controllerUserId,
                },
              });
          } catch {
            this.#leases.release(lease.lease);
            continue;
          }
          rescan = true;
          if (!failedOutbox) continue;
          await this.#cleanupMedia(queued.dedupeKey);
          if (isMissingThreadError(error)) {
            const binding = this.#state.getBinding(this.#now());
            if (binding?.threadId === queued.threadId) {
              this.#state.clearNavigationRoutes();
            }
          }
          await this.#sendPersistedOutbox(failedOutbox);
          continue;
        }
        if (this.#closing) {
          this.#leases.release(lease.lease);
          return;
        }

        let dispatch: DispatchIntent;
        try {
          const promotion = this.#state.promoteQueuedTurnWithLease({
            contextToken,
            createdAtMs: this.#now(),
            dedupeKey: queued.dedupeKey,
            lease: lease.lease,
            maxActiveDispatches: MAX_ACTIVE_BRIDGE_TURNS,
            operationId,
            queuedTurnId: queued.id,
            threadId: queued.threadId,
          });
          if (promotion.kind !== "promoted") {
            if (promotion.kind === "stale") rescan = true;
            continue;
          }
          dispatch = promotion.dispatch;
        } catch {
          this.#leases.release(lease.lease);
          continue;
        }

        const dispatchContextToken = dispatch.contextToken || contextToken;
        let dispatchInput: DurableTurnInput;
        try {
          if (dispatch.body === null) throw new Error("missing queued body");
          dispatchInput = parseDurableTurnInput(dispatch.body);
        } catch {
          await this.#completeRejectedDispatch({
            contextToken: dispatchContextToken,
            dedupeKey: dispatch.dedupeKey,
            lease: lease.lease,
            operationId,
          });
          continue;
        }

        let started: { turn: { id: string } };
        try {
          started = await this.#codex.startTurn({
            ...(dispatchInput.attachments.length > 0
              ? { attachments: dispatchInput.attachments }
              : {}),
            clientUserMessageId: dispatch.dedupeKey,
            text: dispatchInput.text,
            threadId: dispatch.threadId,
          });
        } catch (error) {
          if (!(error instanceof CodexOutcomeUnknownError)) {
            await this.#completeRejectedDispatch({
              contextToken: dispatchContextToken,
              dedupeKey: dispatch.dedupeKey,
              lease: lease.lease,
              operationId,
            });
            continue;
          }
          this.#state.markDispatchUnknown(operationId, this.#now());
          await this.#persistUnknownDiagnostic(
            dispatchContextToken,
            operationId,
            CODEX_OUTCOME_UNKNOWN_TEXT,
          );
          continue;
        }
        this.#leases.claimBridgeTurn({
          instanceId: this.#bridgeInstanceId,
          threadId: dispatch.threadId,
          turnId: started.turn.id,
        });
        if (
          !this.#leases.isHeldBy({
            instanceId: this.#bridgeInstanceId,
            operationId,
            owner: "bridge",
            threadId: dispatch.threadId,
            turnId: started.turn.id,
          })
        ) {
          this.#state.markDispatchUnknown(
            operationId,
            this.#now(),
            started.turn.id,
          );
          await this.#persistUnknownDiagnostic(
            dispatchContextToken,
            operationId,
            HOOK_GUARD_UNKNOWN_TEXT,
          );
          continue;
        }
        this.#state.markDispatchAccepted(
          operationId,
          started.turn.id,
          this.#now(),
        );
        this.#beginTyping(started.turn.id, dispatchContextToken);
      }
    }
  }

  #beginTyping(turnId: string, contextToken: string): void {
    if (this.#closing || !this.#ilink.sendTyping) return;
    const wasIdle = this.#typingTurns.size === 0;
    this.#typingTurns.add(turnId);
    this.#typingContextToken = contextToken;
    if (!wasIdle) return;

    this.#typingKeepalive = setInterval(() => {
      if (this.#typingTurns.size > 0) this.#queueTyping("typing");
    }, TYPING_KEEPALIVE_INTERVAL_MS);
    this.#typingKeepalive.unref();
    this.#queueTyping("typing");
  }

  #finishTyping(turnId: string): void {
    if (!this.#typingTurns.delete(turnId) || this.#typingTurns.size > 0) return;
    this.#clearTypingKeepalive();
    this.#queueTyping("cancel");
  }

  #finishAllTyping(): void {
    if (this.#typingTurns.size === 0) {
      this.#clearTypingKeepalive();
      return;
    }
    this.#typingTurns.clear();
    this.#clearTypingKeepalive();
    this.#queueTyping("cancel");
  }

  #restoreTyping(): void {
    for (const dispatch of this.#state.listUnresolvedDispatchIntents()) {
      if (
        dispatch.status === "accepted" &&
        dispatch.completedAtMs === null &&
        dispatch.turnId &&
        dispatch.contextToken
      ) {
        this.#beginTyping(dispatch.turnId, dispatch.contextToken);
      }
    }
  }

  #clearTypingKeepalive(): void {
    if (this.#typingKeepalive === undefined) return;
    clearInterval(this.#typingKeepalive);
    this.#typingKeepalive = undefined;
  }

  #queueTyping(status: "cancel" | "typing"): void {
    const contextToken = this.#typingContextToken;
    const sendTyping = this.#ilink.sendTyping;
    if (!contextToken || !sendTyping) return;

    this.#pendingTyping = { contextToken, status };
    if (this.#typingPumpRunning) return;
    this.#typingPumpRunning = true;
    void this.#pumpTyping(sendTyping);
  }

  async #pumpTyping(
    sendTyping: NonNullable<ILinkSender["sendTyping"]>,
  ): Promise<void> {
    try {
      while (this.#pendingTyping) {
        const pending = this.#pendingTyping;
        this.#pendingTyping = undefined;
        if (pending.status === "typing" && this.#typingTurns.size === 0) continue;
        try {
          await sendTyping.call(this.#ilink, {
            contextToken: pending.contextToken,
            session: this.#session,
            status: pending.status,
          });
        } catch {
          // Typing is best-effort UI state and must never affect turn delivery.
        }
      }
    } finally {
      this.#typingPumpRunning = false;
      if (this.#pendingTyping) {
        this.#typingPumpRunning = true;
        void this.#pumpTyping(sendTyping);
      }
    }
  }

  async #cleanupMedia(dedupeKey: string): Promise<void> {
    try {
      await this.#media?.cleanup(dedupeKey);
    } catch {
      // A later startup prune can retry orphan cleanup. Delivery state must
      // never be rolled back because a local media deletion failed.
    }
  }

  async #notifySlowDispatch(dispatch: DispatchIntent): Promise<void> {
    const current = this.#state.getDispatchIntent(dispatch.operationId);
    if (
      current?.status !== "accepted" ||
      current.completedAtMs !== null ||
      current.turnId === null ||
      current.turnId !== dispatch.turnId ||
      this.#now() - current.updatedAtMs < this.#slowTurnNoticeAfterMs
    ) {
      return;
    }
    const contextToken =
      current.contextToken ||
      this.#state.getILinkState(this.#session.botId)?.contextToken;
    if (!contextToken) return;
    try {
      await this.#send(
        contextToken,
        CODEX_SLOW_TURN_TEXT,
        `codex-ilink:${current.turnId}:slow`,
      );
    } catch {
      // The durable outbox retries the same one-time progress notice.
    }
  }

  async #completeRejectedDispatch(input: {
    contextToken: string;
    dedupeKey: string;
    lease: TurnLease;
    operationId: string;
  }): Promise<void> {
    const rejectedOutbox = this.#state.rejectPendingDispatchWithOutbox({
      operationId: input.operationId,
      outbox: {
        body: CODEX_SUBMISSION_REJECTED_TEXT,
        clientId: `codex-ilink:${input.operationId}:rejected`,
        contextToken: input.contextToken,
        createdAtMs: this.#now(),
        targetUserId: this.#session.controllerUserId,
      },
    });
    if (!this.#leases?.release(input.lease)) {
      throw new Error("E_BRIDGE_REJECTED_LEASE_RELEASE");
    }
    await this.#cleanupMedia(input.dedupeKey);
    await this.#sendPersistedOutbox(rejectedOutbox);
  }

  async #sendPersistedOutbox(item: OutboxItem): Promise<void> {
    if (item.status === "confirmed") return;
    if (item.body === null) throw new Error("pending rejected reply has no body");
    try {
      await this.#send(item.contextToken, item.body, item.clientId);
    } catch {
      // The rejection and its reply are persisted atomically. The outbox
      // worker owns replay while later FIFO work remains free to continue.
    }
  }

  #dedupeKey(messageId: string): string {
    return `${this.#session.botId}/${this.#session.controllerUserId}/${messageId}`;
  }

  #claimInbound(messageId: string): boolean {
    return this.#state.clearInboundBody(
      this.#session.botId,
      this.#session.controllerUserId,
      messageId,
    );
  }

  #clearInbound(messageId: string): void {
    this.#claimInbound(messageId);
  }

  async #ensureThread(threadId: string): Promise<void> {
    if (this.#codex?.ensureThread) {
      await this.#codex.ensureThread(threadId);
      return;
    }
    if (!this.#codex?.resumeThread) {
      throw new Error("Codex thread resume is not configured");
    }
    await this.#codex.resumeThread(threadId);
  }

  async #resumeThreadForControl(
    threadId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.#codex?.resumeThread) {
      throw new Error("Codex thread resume is not configured");
    }
    return this.#codex.resumeThread(threadId);
  }

  async #readThreadForReconciliation(
    threadId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.#codex?.readThread) {
      throw new Error("Codex thread reading is not configured");
    }
    if (this.#codex.ensureThread) await this.#codex.ensureThread(threadId);
    return (
      await this.#codex.readThread({ includeTurns: true, threadId })
    ).thread;
  }
}

function inboundMediaFailureCode(error: unknown): DurableInboundFailureCode {
  if (!(error instanceof InboundMediaError)) return "download-failed";
  if (error.code === "TOO_LARGE") return "too-large";
  if (
    error.code === "CANCELLED" ||
    error.code === "DOWNLOAD_FAILED" ||
    error.code === "HTTP_ERROR" ||
    error.code === "REDIRECT_ERROR" ||
    error.code === "TIMEOUT"
  ) {
    return "download-failed";
  }
  return "invalid-media";
}

function outboundMediaFailureText(error: unknown): string {
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
    return "路径不存在或不是文件";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "E_OUTBOUND_MEDIA_TOO_LARGE") return "文件超过 100 MB";
  if (message === "E_OUTBOUND_MEDIA_NOT_FILE") return "路径不存在或不是文件";
  if (message === "E_OUTBOUND_MEDIA_OUTSIDE_WORKSPACE") {
    return "文件不在当前任务工作区";
  }
  if (message === "E_OUTBOUND_MEDIA_LINK") return "不允许发送链接或硬链接";
  if (message === "E_OUTBOUND_MEDIA_CHANGED") return "文件在读取时发生变化";
  if (message === "E_OUTBOUND_MEDIA_PATH") return "本地路径格式不安全";
  return "本地路径无效或不可访问";
}

function inboundFailureText(code: DurableInboundFailureCode): string {
  switch (code) {
    case "download-failed":
      return "❌ 微信附件下载失败（网络或 CDN 异常），请稍后重发。";
    case "invalid-media":
      return "❌ 微信附件无效、解密或本地保存失败，未发送给 Codex。";
    case "too-large":
      return "❌ 微信附件超过 100 MB，未发送给 Codex。";
    case "voice-transcript-missing":
      return "❌ 这条语音没有微信转写文本；当前 Codex 任务不能直接接收音频，请开启语音转文字后重发。";
    case "unsupported-media":
      return "❌ 此消息包含当前不支持或不完整的媒体，未发送给 Codex。";
  }
}

function finalAgentText(
  thread: Record<string, unknown>,
  turnId: string,
): string | null {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns
    .map(asObject)
    .find((candidate) => stringField(candidate, "id") === turnId);
  const items = turn && Array.isArray(turn.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asObject(items[index]);
    if (item?.type === "agentMessage" && item.phase === "final_answer") {
      const text = stringField(item, "text");
      if (text) return text;
    }
  }
  return null;
}

function formatCodexTurnFailure(
  status: unknown,
  completionError: Record<string, unknown> | undefined,
  remembered: CodexTurnFailure | undefined,
): string | null {
  const failure = completionError
    ? sanitizeCodexTurnFailure(completionError)
    : remembered;
  if (failure?.category === "network") {
    if (failure.httpStatusCode === 403) {
      return "❌ Codex 网络请求失败：上游服务拒绝访问（HTTP 403）。请稍后重试。";
    }
    return failure.httpStatusCode === undefined
      ? "❌ Codex 网络连接失败。请检查网络后重试。"
      : `❌ Codex 网络请求失败（HTTP ${String(failure.httpStatusCode)}）。请稍后重试。`;
  }
  if (status === "interrupted") {
    return "❌ Codex 任务已中断，未生成最终结果。请重试；详情请在 Codex Desktop 查看。";
  }
  if (status === "failed" || failure) {
    return "❌ Codex 执行失败。请稍后重试；详情请在 Codex Desktop 查看。";
  }
  return null;
}

function sanitizeCodexTurnFailure(
  error: Record<string, unknown>,
): CodexTurnFailure {
  const info = objectField(error, "codexErrorInfo");
  const httpStatusCode = codexHttpStatusCode(error);
  const networkVariants = new Set([
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]);
  return {
    category:
      httpStatusCode !== undefined ||
      (info && Object.keys(info).some((key) => networkVariants.has(key)))
        ? "network"
        : "other",
    httpStatusCode,
  };
}

function codexHttpStatusCode(
  error: Record<string, unknown>,
): number | undefined {
  const info = objectField(error, "codexErrorInfo");
  const value = info
    ? Object.values(info)
        .map(asObject)
        .find((value) => typeof value?.httpStatusCode === "number")
        ?.httpStatusCode
    : undefined;
  return typeof value === "number" ? value : undefined;
}

function turnFailureKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/iu.test(message);
}

function findThreadTurn(
  thread: Record<string, unknown>,
  turnId: string,
): Record<string, unknown> | undefined {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return turns
    .map(asObject)
    .find((candidate) => stringField(candidate, "id") === turnId);
}

function isTerminalTurnStatus(value: unknown): boolean {
  return value === "completed" || value === "failed" || value === "interrupted";
}

function isExplicitlyIdleThread(thread: Record<string, unknown>): boolean {
  if (thread.status === "idle") return true;
  const status = asObject(thread.status);
  return status?.type === "idle";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function objectField(
  value: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  return asObject(value[name]);
}

function stringField(
  value: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const field = value?.[name];
  return typeof field === "string" ? field : undefined;
}

function isModelCatalogEntry(value: unknown): value is ModelCatalogEntry {
  const model = asObject(value);
  return (
    typeof model?.defaultReasoningEffort === "string" &&
    typeof model.displayName === "string" &&
    typeof model.hidden === "boolean" &&
    typeof model.id === "string" &&
    model.id.length > 0 &&
    typeof model.model === "string" &&
    model.model.length > 0 &&
    Array.isArray(model.supportedReasoningEfforts) &&
    model.supportedReasoningEfforts.every((option) => {
      const effort = asObject(option);
      return (
        typeof effort?.description === "string" &&
        typeof effort.reasoningEffort === "string" &&
        effort.reasoningEffort.length > 0
      );
    })
  );
}

function formatModel(model: ModelCatalogEntry): string {
  return compactModelName(model.displayName, "-");
}

function formatModelAndEffort(
  model: string | undefined,
  effort: string | undefined,
): string {
  const name = model ? compactModelName(model, " ") : "未知";
  return effort ? `${name}-${effort}` : name;
}

function compactModelName(value: string, separator: " " | "-"): string {
  const withoutPrefix = value.trim().replace(/^gpt[-\s]+/iu, "");
  const match = /^(\d+(?:\.\d+)*)(?:[-_\s]+(.+))?$/u.exec(withoutPrefix);
  if (!match) return value;
  const family = match[2]
    ?.split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(separator);
  return family ? `${match[1]}${separator}${family}` : (match[1] as string);
}

function findModelByReference(
  models: readonly ModelCatalogEntry[],
  reference: string,
): ModelCatalogEntry | undefined {
  const normalized = reference.trim().toLowerCase();
  const exact = models.find(
    (model) =>
      model.id.toLowerCase() === normalized ||
      model.model.toLowerCase() === normalized ||
      model.displayName.toLowerCase() === normalized,
  );
  if (exact) return exact;

  const aliases = models.filter((model) => {
    const values = [model.id, model.model, model.displayName]
      .map((value) => value.toLowerCase())
      .flatMap((value) => [value, ...value.split(/[-_\s]+/u)]);
    return values.includes(normalized);
  });
  return aliases.length === 1 ? aliases[0] : undefined;
}

function controlFailureReply(
  error: unknown,
  fallback: string,
): ControlReplyResult {
  return {
    ok: false,
    reply: error instanceof ControlCommandRejected ? error.reply : fallback,
  };
}

function formatAmbiguousApprovals(
  approvals: readonly PendingApproval[],
): string {
  return [
    "当前有多个待审批：",
    ...approvals.map((approval) => `${approval.code}：${approval.summary}`),
    "回复：ok<code> 或 no<code>。",
  ].join("\n");
}

function queuedFailureClientId(
  dedupeKey: string,
  reason: "invalid-input" | "missing-thread" | "resume-failed",
): string {
  const identity = createHash("sha256")
    .update(dedupeKey, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `codex-ilink:queued:${identity}:${reason}`;
}

function approvalsReviewerValue(
  metadata: Record<string, unknown>,
): string | null {
  const reviewer = metadata.approvalsReviewer;
  return typeof reviewer === "string" && reviewer.length > 0 ? reviewer : null;
}

function approvalsReviewerText(metadata: Record<string, unknown>): string {
  return approvalsReviewerValue(metadata) ?? "未知";
}

function projectDisplayName(projectPath: string | null): string {
  if (projectPath === null) return "无项目";
  const normalized = win32.normalize(projectPath);
  return win32.basename(normalized) || normalized;
}

function sameWindowsPath(left: string, right: string): boolean {
  return windowsPathKey(left) === windowsPathKey(right);
}

function windowsPathKey(path: string): string {
  const normalized = win32.normalize(path);
  const root = win32.parse(normalized).root;
  const withoutTrailing =
    normalized === root ? normalized : normalized.replace(/[\\/]+$/u, "");
  return withoutTrailing.toLocaleLowerCase("en-US");
}
