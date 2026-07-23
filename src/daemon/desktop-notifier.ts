import { win32 } from "node:path";

import {
  SqliteState,
  type NotificationRoute,
} from "../bridge/sqlite-state.ts";
import {
  desktopNotificationCandidateClientIds,
  desktopNotificationMessageClientIds,
  terminalNotificationClientId,
  type TerminalNotificationOrigin,
} from "../bridge/desktop-notification-identity.ts";
import {
  extractWechatLocalFileReferences,
  formatWechatFinalReply,
} from "../bridge/wechat-output.ts";
import type { HookEvent } from "../hooks/hook-receiver.ts";
import type { ILinkSession } from "../ilink/protocol.ts";
import type { PresenceState } from "../windows/presence.ts";

export type DesktopTerminalStatus = "completed" | "failed" | "interrupted";

export type DesktopNotifierOptions = {
  now: () => number;
  presence?: () => Promise<PresenceState>;
  readThread: (input: {
    includeTurns: boolean;
    threadId: string;
  }) => Promise<{ thread: Record<string, unknown> }>;
  session: ILinkSession;
  state: SqliteState;
};

export type DesktopNotificationResult =
  | "already-sent"
  | "cancelled"
  | "present"
  | "queued";

export type DesktopNotificationContext = {
  origin?: TerminalNotificationOrigin;
  presence?: PresenceState;
  signal?: AbortSignal;
  thread?: Record<string, unknown>;
};

export function terminalNotificationOrigin(
  value: unknown,
): TerminalNotificationOrigin | null {
  if (value === "automation") return "automation";
  if (value === "vscode") return "desktop";
  return null;
}

export class DesktopNotifier {
  readonly #inFlight = new Map<string, Promise<DesktopNotificationResult>>();
  readonly #now: () => number;
  readonly #presence: DesktopNotifierOptions["presence"];
  readonly #readThread: DesktopNotifierOptions["readThread"];
  readonly #session: ILinkSession;
  readonly #state: SqliteState;

  constructor(options: DesktopNotifierOptions) {
    this.#now = options.now;
    this.#presence = options.presence;
    this.#readThread = options.readThread;
    this.#session = options.session;
    this.#state = options.state;
  }

  notifyTerminal(
    event: HookEvent,
    status: DesktopTerminalStatus,
    context: DesktopNotificationContext = {},
  ): Promise<DesktopNotificationResult> {
    if (!event.turnId) return Promise.resolve("already-sent");
    const origin = context.origin ?? "desktop";
    const clientId = terminalNotificationClientId(
      origin,
      event.sessionId,
      event.turnId,
      status !== "interrupted",
    );
    const current = this.#inFlight.get(clientId);
    if (current) {
      return current.then((result) =>
        result === "cancelled" && !context.signal?.aborted
          ? this.notifyTerminal(event, status, context)
          : result,
      );
    }
    const notification = this.#notify(
      event,
      status,
      origin,
      clientId,
      context,
    ).finally(() => {
      if (this.#inFlight.get(clientId) === notification) {
        this.#inFlight.delete(clientId);
      }
    });
    this.#inFlight.set(clientId, notification);
    return notification;
  }

  async #notify(
    event: HookEvent,
    status: DesktopTerminalStatus,
    origin: TerminalNotificationOrigin,
    clientId: string,
    context: DesktopNotificationContext,
  ): Promise<DesktopNotificationResult> {
    if (context.signal?.aborted) return "cancelled";
    if (hasDesktopNotification(this.#state, clientId)) return "already-sent";
    if (origin === "desktop") {
      let presence = context.presence;
      if (!presence) {
        const observePresence = this.#presence;
        if (!observePresence) return "present";
        try {
          presence = await observePresence();
        } catch {
          // Unknown presence must not create noisy duplicate Desktop notifications.
          return "present";
        }
      }
      if (context.signal?.aborted) return "cancelled";
      if (presence === "present") return "present";
    }

    let thread = context.thread ?? {};
    if (!context.thread) {
      try {
        thread = (
          await this.#readThread({
            includeTurns: true,
            threadId: event.sessionId,
          })
        ).thread;
      } catch {
        // The Hook metadata is sufficient for a safe fallback notification.
      }
    }
    if (context.signal?.aborted) return "cancelled";
    const text = formatDesktopNotification(event, status, origin, thread);
    const extracted = extractWechatLocalFileReferences(text);
    const safeText = [
      extracted.text,
      ...(extracted.references.length > 0
        ? ["⚠️ 最终回答包含本机附件，请在 Codex Desktop 查看。"]
        : []),
    ].join("\n\n");
    const nowMs = this.#now();
    const messages = formatWechatFinalReply(safeText);
    const contextToken =
      this.#state.getILinkState(this.#session.botId)?.contextToken ?? "";
    const clientIds = desktopNotificationMessageClientIds(
      clientId,
      messages.length,
    );
    if (context.signal?.aborted) return "cancelled";
    this.#state.enqueueOutboxBatch(
      messages.map((body, index) => ({
        body,
        clientId: clientIds[index] ?? clientId,
        contextToken,
        createdAtMs: nowMs,
        targetUserId: this.#session.controllerUserId,
      })),
    );
    return "queued";
  }
}

function hasDesktopNotification(state: SqliteState, baseClientId: string): boolean {
  return desktopNotificationCandidateClientIds(baseClientId).some((clientId) =>
    Boolean(state.getOutbox(clientId)),
  );
}

export function markDesktopNotificationDelivered(
  state: SqliteState,
  threadId: string,
  turnId: string,
  deliveredAtMs: number,
): void {
  state.putNotificationRoute(desktopNotificationRoute(threadId, turnId, deliveredAtMs));
}

export function desktopNotificationRoute(
  threadId: string,
  turnId: string,
  deliveredAtMs: number,
  origin: TerminalNotificationOrigin = "desktop",
): NotificationRoute {
  return {
    deliveredAtMs,
    eventId: `${origin}:${turnId}`,
    expiresAtMs: deliveredAtMs + 30 * 60 * 1_000,
    threadId,
  };
}

function formatDesktopNotification(
  event: HookEvent,
  status: DesktopTerminalStatus,
  origin: TerminalNotificationOrigin,
  thread: Record<string, unknown>,
): string {
  const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : "⚠️";
  const label =
    status === "completed" ? "已完成" : status === "failed" ? "失败" : "已中断";
  const title = shortText(
    stringField(thread, "name") ?? stringField(thread, "preview") ?? event.sessionId,
  );
  const cwd = projectName(stringField(thread, "cwd") ?? event.cwd ?? "未知项目");
  const conversation =
    status === "completed" && event.turnId
      ? desktopTurnConversation(thread, event.turnId)
      : null;
  const result = [
    `${icon} Codex ${origin === "automation" ? "已安排" : "Desktop "}任务${label}`,
    `项目：${cwd}`,
    `会话：${title}`,
  ];
  if (conversation) {
    result.push(
      "",
      ...(conversation.userSummary
        ? [`你问：${conversation.userSummary}`]
        : []),
      `Codex：${conversation.finalAnswer}`,
    );
  }
  if (status === "interrupted") {
    result.push("", "如需继续，请在 Codex Desktop 打开这个会话。");
  } else {
    result.push(
      "",
      "只有一条新通知时，直接回复即可继续这个会话；多条通知请先选择。",
      "⚠️ 通过微信继续的新对话，需要重启 Codex App 后才能在桌面端看到。",
    );
  }
  return result.join("\n");
}

function desktopTurnConversation(
  thread: Record<string, unknown>,
  turnId: string,
): { finalAnswer: string; userSummary: string | null } | null {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns
    .map(asObject)
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null)
    .find((candidate) => stringField(candidate, "id") === turnId);
  if (!turn || !Array.isArray(turn.items)) return null;

  let finalAnswer: string | null = null;
  let userText: string | null = null;
  for (const rawItem of turn.items) {
    const item = asObject(rawItem);
    if (!item) continue;
    if (item.type === "userMessage") {
      userText = userMessageText(item) ?? userText;
    } else if (item.type === "agentMessage" && item.phase === "final_answer") {
      finalAnswer = stringField(item, "text") ?? finalAnswer;
    }
  }
  return finalAnswer
    ? {
        finalAnswer,
        userSummary: userText ? summarizeUserText(userText) : null,
      }
    : null;
}

function userMessageText(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.content)) return null;
  const blocks = item.content
    .map(asObject)
    .filter((block): block is Record<string, unknown> => block?.type === "text")
    .map((block) => stringField(block, "text"))
    .filter((text): text is string => text !== null);
  return blocks.length > 0 ? blocks.join("\n") : null;
}

function summarizeUserText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= 160
    ? normalized
    : `${characters.slice(0, 159).join("")}…`;
}

function stringField(value: Record<string, unknown>, name: string): string | null {
  const field = value[name];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shortText(value: string): string {
  return [...value].slice(0, 300).join("");
}

function projectName(value: string): string {
  const normalized = win32.normalize(value);
  return shortText(win32.basename(normalized) || normalized);
}
