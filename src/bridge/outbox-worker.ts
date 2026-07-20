import {
  SqliteState,
  type NotificationRoute,
  type OutboxItem,
} from "./sqlite-state.ts";
import type { ILinkSender } from "./bridge.ts";
import { ILinkError, type ILinkSession } from "../ilink/protocol.ts";
import { parseDesktopNotificationClientId } from "./desktop-notification-identity.ts";
import { dispatchOutboxItem } from "./outbox-delivery.ts";
import { WECHAT_FINAL_MAX_MESSAGES } from "./wechat-output.ts";

export type OutboxDrainResult = {
  confirmed: number;
  deferred: number;
  failed: number;
};

export type OutboxWorkerOptions = {
  ilink: ILinkSender;
  maxAttempts?: number;
  now: () => number;
  outboundDirectory?: string;
  onConfirmed?: (
    item: Pick<
      OutboxItem,
      "body" | "clientId" | "contextToken" | "targetUserId"
    >,
    confirmedAtMs: number,
  ) => void;
  routeOnConfirmed?: (
    item: Pick<OutboxItem, "clientId">,
    confirmedAtMs: number,
  ) => NotificationRoute | null;
  session: ILinkSession;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  state: SqliteState;
};

/** Replays durable pending sends with one stable iLink client_id. */
export class OutboxWorker {
  readonly #failedForRun = new Set<string>();
  readonly #ilink: ILinkSender;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #outboundDirectory: string | undefined;
  readonly #onConfirmed: OutboxWorkerOptions["onConfirmed"];
  readonly #routeOnConfirmed: OutboxWorkerOptions["routeOnConfirmed"];
  readonly #session: ILinkSession;
  readonly #sleep: NonNullable<OutboxWorkerOptions["sleep"]>;
  readonly #state: SqliteState;
  #draining: Promise<OutboxDrainResult> | undefined;

  constructor(options: OutboxWorkerOptions) {
    this.#ilink = options.ilink;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#now = options.now;
    this.#outboundDirectory = options.outboundDirectory;
    this.#onConfirmed = options.onConfirmed;
    this.#routeOnConfirmed = options.routeOnConfirmed;
    this.#session = options.session;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#state = options.state;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new Error("E_OUTBOX_ATTEMPTS");
    }
  }

  drain(signal?: AbortSignal): Promise<OutboxDrainResult> {
    if (this.#draining) return this.#draining;
    const draining = this.#drain(signal).finally(() => {
      if (this.#draining === draining) this.#draining = undefined;
    });
    this.#draining = draining;
    return draining;
  }

  /** Allows one new bounded retry cycle after genuine controller activity. */
  resetDeferred(): number {
    const count = this.#failedForRun.size;
    this.#failedForRun.clear();
    return count;
  }

  async #drain(signal?: AbortSignal): Promise<OutboxDrainResult> {
    const result: OutboxDrainResult = { confirmed: 0, deferred: 0, failed: 0 };
    const blockedFinalReplies = new Set<string>();
    for (const item of this.#state.listPendingOutbox()) {
      if (signal?.aborted) throw signal.reason;
      const finalReply = finalReplyGroup(item.clientId);
      const contextToken =
        item.contextToken ||
        this.#state.getILinkState(this.#session.botId)?.contextToken;
      if (
        item.body === null ||
        !contextToken ||
        this.#failedForRun.has(item.clientId) ||
        (finalReply !== null && blockedFinalReplies.has(finalReply))
      ) {
        if (finalReply !== null) blockedFinalReplies.add(finalReply);
        result.deferred += 1;
        continue;
      }

      let confirmed = false;
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
        try {
          const current = this.#state.getOutbox(item.clientId) ?? item;
          const dispatched = await dispatchOutboxItem({
            contextToken,
            ilink: this.#ilink,
            item: current,
            ...(this.#outboundDirectory
              ? { outboundDirectory: this.#outboundDirectory }
              : {}),
            session: this.#session,
            ...(signal ? { signal } : {}),
            state: this.#state,
          });
          const confirmedAtMs = this.#now();
          const route =
            this.#routeOnConfirmed?.(dispatched, confirmedAtMs) ?? undefined;
          this.#state.confirmOutbox(item.clientId, confirmedAtMs, route);
          try {
            this.#onConfirmed?.(dispatched, confirmedAtMs);
          } catch {
            // Delivery is already accepted and must never be retried merely
            // because an optional local post-confirmation hook failed.
          }
          result.confirmed += 1;
          confirmed = true;
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ILinkError && error.kind === "auth-expired") {
            throw error;
          }
          if (attempt < this.#maxAttempts) {
            await this.#sleep(250 * 2 ** (attempt - 1), signal);
          }
        }
      }
      if (!confirmed) {
        this.#failedForRun.add(item.clientId);
        if (finalReply !== null) blockedFinalReplies.add(finalReply);
        result.failed += 1;
      }
    }
    return result;
  }
}

function finalReplyGroup(clientId: string): string | null {
  const bridge = /^(codex-ilink:[^:]+:final)(?::part:(\d+))?$/u.exec(clientId);
  const baseClientId = bridge?.[1];
  const part = bridge?.[2];
  const partNumber = part === undefined ? null : Number(part);
  if (
    baseClientId &&
    (partNumber === null ||
      (Number.isSafeInteger(partNumber) &&
        partNumber >= 1 &&
        partNumber <= WECHAT_FINAL_MAX_MESSAGES))
  ) {
    return baseClientId;
  }
  return parseDesktopNotificationClientId(clientId)?.baseClientId ?? null;
}

function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    // A later caller can join drain(), so the retry must keep the process alive
    // until the shared promise settles on every supported Node version.
  });
}
