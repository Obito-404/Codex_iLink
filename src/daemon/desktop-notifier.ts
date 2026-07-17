import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  SqliteState,
  type NotificationRoute,
} from "../bridge/sqlite-state.ts";
import type { HookEvent } from "../hooks/hook-receiver.ts";
import type { ILinkSession } from "../ilink/protocol.ts";
import type { PresenceState } from "../windows/presence.ts";

export type DesktopTerminalStatus = "completed" | "failed" | "interrupted";

export type DesktopNotifierOptions = {
  now: () => number;
  presence: () => Promise<PresenceState>;
  readThread: (input: {
    includeTurns: boolean;
    threadId: string;
  }) => Promise<{ thread: Record<string, unknown> }>;
  session: ILinkSession;
  state: SqliteState;
};

export type DesktopNotificationResult =
  | "already-sent"
  | "present"
  | "queued";

export class DesktopNotifier {
  readonly #inFlight = new Map<string, Promise<DesktopNotificationResult>>();
  readonly #now: () => number;
  readonly #presence: () => Promise<PresenceState>;
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
  ): Promise<DesktopNotificationResult> {
    if (!event.turnId) return Promise.resolve("already-sent");
    const clientId = desktopNotificationClientId(event.sessionId, event.turnId);
    const current = this.#inFlight.get(clientId);
    if (current) return current;
    const notification = this.#notify(event, status, clientId).finally(() => {
      if (this.#inFlight.get(clientId) === notification) {
        this.#inFlight.delete(clientId);
      }
    });
    this.#inFlight.set(clientId, notification);
    return notification;
  }

  notifyPermission(event: HookEvent): Promise<DesktopNotificationResult> {
    if (!event.turnId) return Promise.resolve("already-sent");
    const clientId = desktopPermissionClientId(event);
    const current = this.#inFlight.get(clientId);
    if (current) return current;
    const notification = this.#queuePermission(event, clientId).finally(() => {
      if (this.#inFlight.get(clientId) === notification) {
        this.#inFlight.delete(clientId);
      }
    });
    this.#inFlight.set(clientId, notification);
    return notification;
  }

  async #queuePermission(
    event: HookEvent,
    clientId: string,
  ): Promise<DesktopNotificationResult> {
    if (this.#state.getOutbox(clientId)) return "already-sent";
    let presence: PresenceState;
    try {
      presence = await this.#presence();
    } catch {
      return "present";
    }
    if (presence === "present") return "present";

    let thread: Record<string, unknown> = {};
    try {
      thread = (
        await this.#readThread({
          includeTurns: false,
          threadId: event.sessionId,
        })
      ).thread;
    } catch {
      // The Hook metadata is sufficient for a safe fallback notification.
    }
    this.#state.enqueueOutbox({
      body: formatDesktopPermissionNotification(event, thread),
      clientId,
      contextToken:
        this.#state.getILinkState(this.#session.botId)?.contextToken ?? "",
      createdAtMs: this.#now(),
      targetUserId: this.#session.controllerUserId,
    });
    return "queued";
  }

  async #notify(
    event: HookEvent,
    status: DesktopTerminalStatus,
    clientId: string,
  ): Promise<DesktopNotificationResult> {
    if (this.#state.getOutbox(clientId)) return "already-sent";
    let presence: PresenceState;
    try {
      presence = await this.#presence();
    } catch {
      // Unknown presence must not create noisy duplicate Desktop notifications.
      return "present";
    }
    if (presence === "present") return "present";

    let thread: Record<string, unknown> = {};
    try {
      thread = (
        await this.#readThread({
          includeTurns: false,
          threadId: event.sessionId,
        })
      ).thread;
    } catch {
      // The Hook metadata is sufficient for a safe fallback notification.
    }
    const text = formatDesktopNotification(event, status, thread);
    const nowMs = this.#now();
    this.#state.enqueueOutbox({
      body: text,
      clientId,
      contextToken:
        this.#state.getILinkState(this.#session.botId)?.contextToken ?? "",
      createdAtMs: nowMs,
      targetUserId: this.#session.controllerUserId,
    });
    return "queued";
  }
}

export function desktopNotificationClientId(
  threadId: string,
  turnId: string,
): string {
  return `codex-ilink:desktop:${threadId}:${turnId}:final`;
}

export function desktopPermissionClientId(event: HookEvent): string {
  const identity = `${event.sessionId}\0${event.turnId ?? ""}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `codex-ilink:desktop:${event.sessionId}:permission:${suffix}`;
}

export function parseDesktopNotificationClientId(
  clientId: string,
): { threadId: string; turnId: string } | null {
  const match = /^codex-ilink:desktop:([A-Za-z0-9-]+):([A-Za-z0-9-]+):final$/u.exec(
    clientId,
  );
  return match?.[1] && match[2]
    ? { threadId: match[1], turnId: match[2] }
    : null;
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
): NotificationRoute {
  return {
    deliveredAtMs,
    eventId: `desktop:${turnId}`,
    expiresAtMs: deliveredAtMs + 5 * 60 * 1_000,
    threadId,
  };
}

function formatDesktopNotification(
  event: HookEvent,
  status: DesktopTerminalStatus,
  thread: Record<string, unknown>,
): string {
  const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : "⚠️";
  const label =
    status === "completed" ? "已完成" : status === "failed" ? "失败" : "已中断";
  const title = shortText(
    stringField(thread, "name") ?? stringField(thread, "preview") ?? event.sessionId,
  );
  const cwd = projectName(stringField(thread, "cwd") ?? event.cwd ?? "未知项目");
  return [
    `${icon} Codex Desktop 任务${label}`,
    `项目：${cwd}`,
    `会话：${title}`,
    "5 分钟内直接回复可继续这个会话。",
  ].join("\n");
}

function formatDesktopPermissionNotification(
  event: HookEvent,
  thread: Record<string, unknown>,
): string {
  const title = shortText(
    stringField(thread, "name") ?? event.sessionId,
  );
  const cwd = projectName(stringField(thread, "cwd") ?? event.cwd ?? "未知项目");
  const toolName = shortText(event.toolName ?? "未知工具");
  return [
    "⏳ Codex Desktop 正等待本机批准",
    `项目：${cwd}`,
    `会话：${title}`,
    `工具：${toolName}`,
    "微信不能批准此请求，请回到电脑处理。",
  ].join("\n");
}

function stringField(value: Record<string, unknown>, name: string): string | null {
  const field = value[name];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function shortText(value: string): string {
  return [...value].slice(0, 300).join("");
}

function projectName(value: string): string {
  const normalized = win32.normalize(value);
  return shortText(win32.basename(normalized) || normalized);
}
