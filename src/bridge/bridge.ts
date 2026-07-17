import { win32 } from "node:path";

import { parseInboundText, COMMAND_HELP } from "./commands.ts";
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
  localOutboundMedia,
  outboundMediaPathKey,
  serializeOutboundPayload,
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

export type CodexTurnStarter = {
  compactThread?(threadId: string): Promise<Record<string, unknown>>;
  ensureThread?(
    threadId: string,
    options?: { permissions?: string },
  ): Promise<void>;
  listPermissionProfiles?(input: { cwd?: string }): Promise<{
    data: Array<{
      allowed: boolean;
      description?: string | null;
      id: string;
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
  resumeThread?(
    threadId: string,
    options?: { permissions?: string },
  ): Promise<Record<string, unknown>>;
  startThread?(cwd: string): Promise<Record<string, unknown> & {
    thread: { id: string } & Record<string, unknown>;
  }>;
  updateThreadPermissions?(
    threadId: string,
    permissions: string,
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
const CODEX_SLOW_TURN_TEXT =
  "⏳ Codex 任务仍在执行，已长时间没有结束；可能正在等待工具、审批或网络。任务未被取消，可用 st 查看或用 stop 停止。";

export class BridgeEngine {
  readonly #approvals: ApprovalCoordinator | undefined;
  readonly #ilink: ILinkSender;
  readonly #inboxDirectory: string | undefined;
  readonly #bridgeInstanceId: string | undefined;
  readonly #codex: CodexTurnStarter | undefined;
  readonly #leases: SqliteTurnLeaseStore | undefined;
  readonly #mainThreadId: string | undefined;
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
    const knownMessageIds = new Set(
      this.#state
        .listInboundMessages()
        .filter(
          (message) =>
            message.accountId === this.#session.botId &&
            message.controllerUserId === this.#session.controllerUserId,
        )
        .map(({ messageId }) => messageId),
    );
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
      return this.#handleSendFileCall(event);
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
    const needsThreadForLeaseRelease =
      dispatch.completedAtMs === null && knownLease === null;
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
    const finalOutboxInput =
      mustPersistFinal && contextToken && !suppressInterruptedFinal
        ? this.#finalReplyInput(
            contextToken,
            failureText ??
              finalAgentText(readThread ?? {}, turnId) ??
              CODEX_EMPTY_REPLY_TEXT,
            turnId,
            failureText === null && effectiveCompletionStatus === "completed"
              ? this.#state.listOutboundAttachmentIntents(turnId)
              : [],
          )
        : null;
    if (dispatch.completedAtMs === null) {
      const lease = knownLease ?? this.#leases.getLease(threadId);
      if (lease) {
        if (
          lease.owner !== "bridge" ||
          lease.operationId !== dispatch.operationId ||
          lease.turnId !== turnId ||
          !this.#leases.release(lease)
        ) {
          return false;
        }
      } else {
        const turn = readThread ? findThreadTurn(readThread, turnId) : undefined;
        if (
          !readThread ||
          !isExplicitlyIdleThread(readThread) ||
          !isTerminalTurnStatus(turn?.status)
        ) {
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

  #handleSendFileCall(event: CodexEvent): boolean {
    if (stringField(event.params, "tool") !== "send_file") return false;
    const respond = this.#codex?.respondToServerRequest;
    if (event.id === undefined || !respond) return false;
    const failure = (text: string): boolean =>
      respond.call(this.#codex, event.id!, {
        contentItems: [{ text, type: "inputText" }],
        success: false,
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
    try {
      const media = localOutboundMedia({
        label: win32.basename(path.trim()),
        path,
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
    return (
      respond.call(this.#codex, event.id, {
        contentItems: [
          {
            text: "附件已登记，将随最终回复发送；不要再输出本地路径。",
            type: "inputText",
          },
        ],
        success: true,
      }) !== false
    );
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
    const pending = this.#reconcileDispatchLeases();
    this.#reconcilePromise = pending;
    try {
      await pending;
    } finally {
      if (this.#reconcilePromise === pending) this.#reconcilePromise = undefined;
    }
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
          await this.#cleanupMedia(dedupeKey);
          return fail("voice-transcript-missing");
        }
        attachments.push({
          kind: resolved.kind,
          name: resolved.displayName,
          path: resolved.path,
        });
      }
    } catch (error) {
      await this.#cleanupMedia(dedupeKey);
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
      await this.#cleanupMedia(dedupeKey);
      return fail("invalid-media");
    }
  }

  async #processAcceptedTurn(input: {
    contextToken: string;
    messageId: string;
    turnInput: DurableTurnInput;
  }): Promise<number> {
    let intent = parseInboundText(input.turnInput.text);
    if (
      (intent.kind === "approve" || intent.kind === "deny") &&
      intent.code === null &&
      (this.#approvals?.list().length ?? 0) === 0
    ) {
      intent = { kind: "message", text: input.turnInput.text };
    }
    if (intent.kind !== "message") this.#touchBinding();
    if (intent.kind === "help") {
      return this.#replyToCommand(input.contextToken, input.messageId, COMMAND_HELP);
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
              ? await this.#compactSessionReply(input.contextToken)
              : await this.#stopTurnReply();
        return this.#replyToCommand(input.contextToken, input.messageId, reply);
      } catch {
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
        return this.#replyToCommand(
          input.contextToken,
          input.messageId,
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
        return this.#replyToCommand(input.contextToken, input.messageId, reply);
      } catch {
        return this.#replyToCommand(
          input.contextToken,
          input.messageId,
          "项目命令执行失败，请稍后重试。",
        );
      }
    }
    if (intent.kind === "sessions" || intent.kind === "enterSession") {
      try {
        const reply =
          intent.kind === "sessions"
            ? await this.#sessionListReply(intent.page)
            : await this.#enterSessionReply(intent.index);
        return this.#replyToCommand(input.contextToken, input.messageId, reply);
      } catch {
        return this.#replyToCommand(
          input.contextToken,
          input.messageId,
          "会话命令执行失败，请稍后重试。",
        );
      }
    }
    if (intent.kind === "permissions" || intent.kind === "selectPermission") {
      try {
        const reply = await this.#permissionReply(
          intent.kind === "selectPermission" ? intent.index : undefined,
        );
        return this.#replyToCommand(input.contextToken, input.messageId, reply);
      } catch {
        return this.#replyToCommand(
          input.contextToken,
          input.messageId,
          "权限命令执行失败，请稍后重试。",
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
        return this.#replyToCommand(input.contextToken, input.messageId, reply);
      } catch {
        return this.#replyToCommand(
          input.contextToken,
          input.messageId,
          "命令执行失败，请稍后重试。",
        );
      }
    }

    const decision = this.#approvals?.decide(
      intent.code,
      intent.kind === "approve",
    );
    if (decision?.kind === "decided") {
      this.#clearInbound(input.messageId);
      return 0;
    }
    const reply =
      decision?.kind === "ambiguous"
        ? formatAmbiguousApprovals(decision.approvals)
        : intent.code
          ? `审批 ${intent.code} 已失效或不存在。`
          : "当前没有待审批。";
    return this.#replyToCommand(input.contextToken, input.messageId, reply);
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
    const uniqueReferences: Array<{ label: string; path: string }> = [];
    const seenPaths = new Set<string>();
    for (const reference of [
      ...registeredAttachments.map((attachment) => ({
        label: attachment.name,
        path: attachment.path,
        pathKey: attachment.pathKey,
      })),
      ...extracted.references.map((reference) => ({
        ...reference,
        pathKey: outboundMediaPathKey(reference.path),
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
            localOutboundMedia({
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
    const finalText = [extracted.text, ...mediaFailures]
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
        session: this.#session,
        signal: this.#shutdown.signal,
        state: this.#state,
      });
      this.#state.confirmOutbox(item.clientId, this.#now());
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
    if (!projectPath) return "项目编号无效，请按 p 当前列表选择。";
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
      if (!previous) return "会话列表已过期，请先用 s 或 sarc 刷新。";
      if (!previous.hasNext) return "当前会话列表没有下一页。";
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
    if (!target) return "会话编号无效，请按当前 s 列表选择。";
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
      expiresAtMs: nowMs + 30 * 60 * 1_000,
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
      "30 分钟无活动后自动退出。",
    ].join("\n");
  }

  #formatThreadPreview(preview: ThreadPreview | null, threadId: string): string {
    if (!preview) return `已进入会话：${threadId}`;
    const permission = preview.permissionProfileId
      ? permissionProfileDisplayName(preview.permissionProfileId)
      : (preview.permissionMode ?? "未知");
    return [
      `已进入会话：${preview.title ?? preview.id}`,
      `状态：${preview.status ?? "未知"}`,
      `模型：${preview.model ?? "未知"}`,
      `权限：${permission}`,
      `审批：${preview.approvalPolicy ?? "未知"}`,
      `Sandbox：${preview.sandboxType ?? "未知"}`,
      `最近提问：${preview.latestUserText ?? "（无）"}`,
      `最近回复：${preview.finalAgentText ?? "（无）"}`,
    ].join("\n");
  }

  async #newSessionReply(): Promise<string> {
    return this.#startSessionReply(
      this.#state.getBridgeSettings().selectedProjectPath,
    );
  }

  async #startSessionReply(projectPath: string | null): Promise<string> {
    if (!this.#codex?.startThread || !this.#inboxDirectory) {
      throw new Error("new session is not configured");
    }
    const cwd = projectPath ?? this.#inboxDirectory;
    const started = await this.#codex.startThread(cwd);
    const threadId = stringField(started.thread, "id");
    if (!threadId) throw new Error("Codex did not return a thread id");
    const nowMs = this.#now();
    this.#state.setBindingForNavigation({
      expiresAtMs: nowMs + 30 * 60 * 1_000,
      projectPath,
      threadId,
      updatedAtMs: nowMs,
    });
    const activePermission = activePermissionProfileId(started);
    return [
      `已新建并进入会话：${threadId}`,
      `项目：${projectDisplayName(projectPath)}`,
      `权限：${
        activePermission
          ? permissionProfileDisplayName(activePermission)
          : "未知"
      }`,
      `审批：${approvalPolicyText(started)}`,
      `Sandbox：${sandboxTypeText(started)}`,
      "30 分钟无活动后自动退出。",
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
      return "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。";
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
      return "当前会话正在被其他任务使用，请先用 stop 停止或等待任务结束。";
    }
    this.#clearOperations.set(threadId, operationId);
    try {
      if (this.#threadHasScheduledWork(threadId)) {
        return "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。";
      }
      return [
        "已清除当前上下文。",
        await this.#startSessionReply(projectPath),
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
      return "当前会话仍有任务正在执行或排队，请先用 stop 停止或等待任务结束。";
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
      return "当前会话正在被其他任务使用，请稍后再 compact。";
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
        return "压缩请求结果未知，请在 Desktop 查看；确认结束前的新消息会自动排队。";
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
        return "当前任务尚未取得可中断的 Turn ID，请稍后再试。";
      }
      if (lease?.owner === "desktop") {
        return "当前任务由 Desktop 发起，请在电脑端停止。";
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
        return "停止请求结果未知，请在 Desktop 查看当前任务状态。";
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

  async #permissionReply(selectedIndex?: number): Promise<string> {
    if (
      !this.#codex?.resumeThread ||
      !this.#codex.listPermissionProfiles ||
      !this.#codex.updateThreadPermissions ||
      !this.#mainThreadId
    ) {
      throw new Error("permission profiles are not configured");
    }
    const binding = this.#state.getBinding(this.#now());
    const threadId = binding?.threadId ?? this.#mainThreadId;
    const storedPermission = this.#state.getThreadPermissionProfile(threadId)
      ?.profileId;
    const cwd = binding?.projectPath ?? this.#inboxDirectory ?? undefined;
    const listed = await this.#codex.listPermissionProfiles({
      ...(cwd ? { cwd } : {}),
    });
    const profiles = listed.data.filter(isPermissionProfileSummary);

    if (selectedIndex !== undefined) {
      const selected = profiles[selectedIndex - 1];
      if (!selected) return "权限编号无效，请按 perm 当前列表选择。";
      if (!selected.allowed) {
        return `权限 ${selected.id} 受 Codex 配置限制，当前不可切换。`;
      }
      const changed = await this.#codex.updateThreadPermissions(
        threadId,
        selected.id,
      );
      const activeId = activePermissionProfileId(changed);
      if (activeId !== selected.id) {
        throw new Error("Codex did not activate the selected permission profile");
      }
      this.#state.setThreadPermissionProfile({
        profileId: selected.id,
        threadId,
        updatedAtMs: this.#now(),
      });
      return [
        `已切换当前任务权限：${formatPermissionProfile(selectedIndex, selected)}`,
        `审批：${approvalPolicyText(changed)}`,
        `Sandbox：${sandboxTypeText(changed)}`,
      ].join("\n");
    }

    let current: Record<string, unknown> | null = null;
    try {
      current = await this.#resumeThreadForControl(threadId);
    } catch {
      // Keep the native profile list usable so an explicitly selected allowed
      // profile can recover a task whose previously saved profile was disabled.
    }
    const activeId =
      (current ? activePermissionProfileId(current) : undefined) ??
      storedPermission;
    const activeIndex = profiles.findIndex((profile) => profile.id === activeId);
    const active = activeIndex >= 0 ? profiles[activeIndex] : null;
    return [
      `当前权限：${
        active
          ? formatPermissionProfile(activeIndex + 1, active)
          : (activeId ?? "未知")
      }`,
      `审批：${current ? approvalPolicyText(current) : "未知"}`,
      `Sandbox：${current ? sandboxTypeText(current) : "未知"}`,
      ...(current
        ? []
        : ["⚠️ Codex 未能确认当前权限；请选择可用 Profile 或稍后重试。"]),
      "",
      ...profiles.map((profile, index) =>
        `${formatPermissionProfile(index + 1, profile)}${
          profile.allowed ? "" : "（不可用）"
        }`,
      ),
      "使用 perm<n> 直接切换当前任务权限。",
    ].join("\n");
  }

  #exitSessionReply(): string {
    this.#state.clearNavigationRoutes();
    return "已返回微信主会话。当前项目选择保持不变。";
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
    let active: ReturnType<typeof listActiveThreads> = [];
    try {
      active = listActiveThreads(await this.#listThreadPages(false));
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
    const session = binding
      ? `${binding.threadId}（剩余 ${String(Math.max(1, Math.ceil((binding.expiresAtMs - nowMs) / 60_000)))} 分钟）`
      : "微信主会话";
    return [
      `项目：${projectDisplayName(projectPath)}`,
      `会话：${session}`,
      `权限：${
        permissionMetadata && activePermissionProfileId(permissionMetadata)
          ? permissionProfileDisplayName(
              activePermissionProfileId(permissionMetadata) as string,
            )
          : "未知"
      }`,
      `审批：${
        permissionMetadata ? approvalPolicyText(permissionMetadata) : "未知"
      }；Sandbox：${
        permissionMetadata ? sandboxTypeText(permissionMetadata) : "未知"
      }`,
      `活动任务：${String(knownActiveTasks.length)}`,
      ...knownActiveTasks.map(
        (thread) => `- ${thread.title ?? thread.id} (${thread.id})`,
      ),
      `队列：${String(queueCount)}`,
      `通知回复窗口：${String(notificationCount)}`,
      `待审批：${String(pendingApprovals.length)}${
        retryingApprovalCount > 0
          ? `（通知重试中：${String(retryingApprovalCount)}）`
          : ""
      }`,
      `连接：Codex ${codexHealthy ? "正常" : "异常"}；仲裁${arbitrationHealthy ? "正常" : "关闭"}；微信${this.#ilinkHealthy ? "正常" : "异常"}`,
    ].join("\n");
  }

  #touchBinding(): void {
    const nowMs = this.#now();
    const binding = this.#state.getBinding(nowMs);
    if (!binding) return;
    this.#state.setBinding({
      ...binding,
      expiresAtMs: nowMs + 30 * 60 * 1_000,
      updatedAtMs: nowMs,
    });
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
      await this.#send(
        input.contextToken,
        "有多个可回复任务，请先用 p 选择项目，再用 s<n> 进入目标会话。",
      );
      this.#clearInbound(input.messageId);
      await this.#cleanupMedia(this.#dedupeKey(input.messageId));
      return 1;
    }
    if (route.binding) {
      this.#state.setBinding({
        expiresAtMs: route.binding.expiresAtMs,
        projectPath:
          route.route === "binding" ? currentBinding?.projectPath ?? null : null,
        threadId: route.binding.threadId,
        updatedAtMs: nowMs,
      });
    }

    const dedupeKey = `${this.#session.botId}/${this.#session.controllerUserId}/${input.messageId}`;
    if (
      this.#state.countActiveDispatches() >= MAX_ACTIVE_BRIDGE_TURNS ||
      this.#state.hasActiveDispatchForThread(route.threadId) ||
      this.#state.getDesktopTurnObservation(route.threadId) !== null ||
      this.#state.peekQueuedTurn(route.threadId) !== null
    ) {
      const queued = this.#state.enqueueQueuedTurn({
        body: serializedInput,
        contextToken: input.contextToken,
        createdAtMs: nowMs,
        dedupeKey,
        threadId: route.threadId,
      });
      this.#clearInbound(input.messageId);
      await this.#send(input.contextToken, `Queued #${queued.id}`);
      return 1;
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
      const queued = this.#state.enqueueQueuedTurn({
        body: serializedInput,
        contextToken: input.contextToken,
        createdAtMs: nowMs,
        dedupeKey,
        threadId: route.threadId,
      });
      this.#clearInbound(input.messageId);
      await this.#send(input.contextToken, `Queued #${queued.id}`);
      return 1;
    }

    try {
      await this.#ensureThread(route.threadId);
    } catch (error) {
      this.#leases.release({
        instanceId: this.#bridgeInstanceId,
        operationId,
        owner: "bridge",
        threadId: route.threadId,
        turnId: null,
      });
      if (isMissingThreadError(error)) {
        if (currentBinding?.threadId === route.threadId) {
          this.#state.clearNavigationRoutes();
        }
        this.#clearInbound(input.messageId);
        await this.#cleanupMedia(dedupeKey);
        await this.#send(
          input.contextToken,
          MISSING_THREAD_TEXT,
          this.#inboundReplyClientId(input.messageId),
        );
        return 1;
      }
      const queued = this.#state.enqueueQueuedTurn({
        body: serializedInput,
        contextToken: input.contextToken,
        createdAtMs: nowMs,
        dedupeKey,
        threadId: route.threadId,
      });
      this.#clearInbound(input.messageId);
      await this.#send(input.contextToken, `Queued #${queued.id}`);
      return 1;
    }

    try {
      const dispatch = this.#state.tryCreateDispatchIntent({
        body: serializedInput,
        contextToken: input.contextToken,
        createdAtMs: nowMs,
        dedupeKey,
        maxActiveDispatches: MAX_ACTIVE_BRIDGE_TURNS,
        operationId,
        threadId: route.threadId,
      });
      if (!dispatch) {
        this.#leases.release({
          instanceId: this.#bridgeInstanceId,
          operationId,
          owner: "bridge",
          threadId: route.threadId,
          turnId: null,
        });
        const queued = this.#state.enqueueQueuedTurn({
          body: serializedInput,
          contextToken: input.contextToken,
          createdAtMs: nowMs,
          dedupeKey,
          threadId: route.threadId,
        });
        this.#clearInbound(input.messageId);
        await this.#send(input.contextToken, `Queued #${queued.id}`);
        return 1;
      }
    } catch (error) {
      this.#leases.release({
        instanceId: this.#bridgeInstanceId,
        operationId,
        owner: "bridge",
        threadId: route.threadId,
        turnId: null,
      });
      throw error;
    }

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
        this.#clearInbound(input.messageId);
        await this.#drainQueuedTurns();
        return 1;
      }
      this.#state.markDispatchUnknown(operationId, this.#now());
      await this.#persistUnknownDiagnostic(
        input.contextToken,
        operationId,
        CODEX_OUTCOME_UNKNOWN_TEXT,
      );
      this.#clearInbound(input.messageId);
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
      this.#clearInbound(input.messageId);
      return 1;
    }
    this.#state.markDispatchAccepted(operationId, started.turn.id, this.#now());
    this.#beginTyping(started.turn.id, input.contextToken);
    this.#clearInbound(input.messageId);
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
      if (
        leasedOperations.has(dispatch.operationId) ||
        this.#leases.getLease(dispatch.threadId) !== null ||
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

    for (const queued of this.#state.listQueuedTurns()) {
      if (this.#state.countActiveDispatches() >= MAX_ACTIVE_BRIDGE_TURNS) return;
      if (this.#state.hasActiveDispatchForThread(queued.threadId)) continue;
      if (this.#state.getDesktopTurnObservation(queued.threadId)) continue;
      const contextToken =
        queued.contextToken ||
        this.#state.getILinkState(this.#session.botId)?.contextToken;
      if (!contextToken) continue;
      let queuedInput: DurableTurnInput;
      try {
        queuedInput = parseDurableTurnInput(queued.body);
      } catch {
        this.#state.deleteQueuedTurn(queued.id);
        await this.#cleanupMedia(queued.dedupeKey);
        await this.#send(
          contextToken,
          inboundFailureText("invalid-media"),
          `codex-ilink:queued:${String(queued.id)}:invalid-input`,
        );
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
        this.#leases.release({
          instanceId: this.#bridgeInstanceId,
          operationId,
          owner: "bridge",
          threadId: queued.threadId,
          turnId: null,
        });
        if (isMissingThreadError(error)) {
          this.#state.deleteQueuedTurn(queued.id);
          await this.#cleanupMedia(queued.dedupeKey);
          const binding = this.#state.getBinding(this.#now());
          if (binding?.threadId === queued.threadId) {
            this.#state.clearNavigationRoutes();
          }
          await this.#send(
            contextToken,
            MISSING_THREAD_TEXT,
            `codex-ilink:queued:${String(queued.id)}:missing-thread`,
          );
        }
        continue;
      }
      if (this.#closing) {
        this.#leases.release({
          instanceId: this.#bridgeInstanceId,
          operationId,
          owner: "bridge",
          threadId: queued.threadId,
          turnId: null,
        });
        return;
      }

      let dispatch: NonNullable<
        ReturnType<SqliteState["promoteQueuedTurn"]>
      >;
      try {
        const promoted = this.#state.promoteQueuedTurn({
          contextToken,
          createdAtMs: this.#now(),
          maxActiveDispatches: MAX_ACTIVE_BRIDGE_TURNS,
          operationId,
          queuedTurnId: queued.id,
        });
        if (!promoted) {
          this.#leases.release({
            instanceId: this.#bridgeInstanceId,
            operationId,
            owner: "bridge",
            threadId: queued.threadId,
            turnId: null,
          });
          continue;
        }
        dispatch = promoted;
      } catch {
        this.#leases.release({
          instanceId: this.#bridgeInstanceId,
          operationId,
          owner: "bridge",
          threadId: queued.threadId,
          turnId: null,
        });
        continue;
      }

      let started: { turn: { id: string } };
      try {
        started = await this.#codex.startTurn({
          ...(queuedInput.attachments.length > 0
            ? { attachments: queuedInput.attachments }
            : {}),
          clientUserMessageId: dispatch.dedupeKey,
          text: queuedInput.text,
          threadId: queued.threadId,
        });
      } catch (error) {
        if (!(error instanceof CodexOutcomeUnknownError)) {
          await this.#completeRejectedDispatch({
            dedupeKey: dispatch.dedupeKey,
            lease: lease.lease,
            operationId,
            contextToken,
          });
          continue;
        }
        this.#state.markDispatchUnknown(operationId, this.#now());
        await this.#persistUnknownDiagnostic(
          contextToken,
          operationId,
          CODEX_OUTCOME_UNKNOWN_TEXT,
        );
        continue;
      }
      this.#leases.claimBridgeTurn({
        instanceId: this.#bridgeInstanceId,
        threadId: queued.threadId,
        turnId: started.turn.id,
      });
      if (
        !this.#leases.isHeldBy({
          instanceId: this.#bridgeInstanceId,
          operationId,
          owner: "bridge",
          threadId: queued.threadId,
          turnId: started.turn.id,
        })
      ) {
        this.#state.markDispatchUnknown(
          operationId,
          this.#now(),
          started.turn.id,
        );
        await this.#persistUnknownDiagnostic(
          contextToken,
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
      this.#beginTyping(started.turn.id, contextToken);
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
    await this.#sendRejectedOutbox(rejectedOutbox);
  }

  async #sendRejectedOutbox(item: OutboxItem): Promise<void> {
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

  #clearInbound(messageId: string): void {
    this.#state.clearInboundBody(
      this.#session.botId,
      this.#session.controllerUserId,
      messageId,
    );
  }

  async #ensureThread(threadId: string): Promise<void> {
    const storedPermission = this.#state.getThreadPermissionProfile(threadId)
      ?.profileId;
    const options = storedPermission
      ? { permissions: storedPermission }
      : undefined;
    if (this.#codex?.ensureThread) {
      await this.#codex.ensureThread(threadId, options);
      return;
    }
    if (!this.#codex?.resumeThread) {
      throw new Error("Codex thread resume is not configured");
    }
    await this.#codex.resumeThread(threadId, options);
  }

  async #resumeThreadForControl(
    threadId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.#codex?.resumeThread) {
      throw new Error("Codex thread resume is not configured");
    }
    const storedPermission = this.#state.getThreadPermissionProfile(threadId)
      ?.profileId;
    if (!storedPermission) return this.#codex.resumeThread(threadId);
    return this.#codex.resumeThread(threadId, {
      permissions: storedPermission,
    });
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
  const message = error instanceof Error ? error.message : String(error);
  if (message === "E_OUTBOUND_MEDIA_TOO_LARGE") return "文件超过 100 MB";
  if (message === "E_OUTBOUND_MEDIA_NOT_FILE") return "路径不存在或不是文件";
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

function isPermissionProfileSummary(value: unknown): value is {
  allowed: boolean;
  description?: string | null;
  id: string;
} {
  const profile = asObject(value);
  return (
    typeof profile?.allowed === "boolean" &&
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    (profile.description === undefined ||
      profile.description === null ||
      typeof profile.description === "string")
  );
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

function activePermissionProfileId(
  metadata: Record<string, unknown>,
): string | undefined {
  return stringField(objectField(metadata, "activePermissionProfile"), "id");
}

function approvalPolicyText(metadata: Record<string, unknown>): string {
  const policy = metadata.approvalPolicy;
  return typeof policy === "string"
    ? policy
    : asObject(policy)?.granular
      ? "granular"
      : "未知";
}

function sandboxTypeText(metadata: Record<string, unknown>): string {
  return (
    stringField(objectField(metadata, "sandbox"), "type") ??
    stringField(objectField(metadata, "sandboxPolicy"), "type") ??
    "未知"
  );
}

function formatPermissionProfile(
  index: number,
  profile: { description?: string | null; id: string },
): string {
  const builtInLabel = permissionProfileLabel(profile.id);
  return `${String(index)}. ${builtInLabel} (${profile.id})`;
}

function permissionProfileDisplayName(id: string): string {
  return `${permissionProfileLabel(id)} (${id})`;
}

function permissionProfileLabel(id: string): string {
  return id === ":read-only"
    ? "只读"
    : id === ":workspace"
      ? "项目读写"
      : id === ":danger-full-access"
        ? "完全访问"
        : "自定义";
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
