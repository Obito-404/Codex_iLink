import { mkdirSync } from "node:fs";

import {
  BridgeEngine,
  type CodexEvent,
  type CodexTurnStarter,
  type BridgeEngineOptions,
  type InboundMediaPort,
  type ILinkSender,
} from "../bridge/bridge.ts";
import { SqliteState } from "../bridge/sqlite-state.ts";
import { OutboxWorker } from "../bridge/outbox-worker.ts";
import { SqliteTurnLeaseStore } from "../coordination/turn-lease.ts";
import {
  DesktopNotifier,
  desktopNotificationRoute,
  parseDesktopNotificationClientId,
  type DesktopTerminalStatus,
} from "./desktop-notifier.ts";
import type { HookEvent } from "../hooks/hook-receiver.ts";
import type {
  GetUpdatesResult,
  ILinkSession,
} from "../ilink/protocol.ts";
import type { PresenceState } from "../windows/presence.ts";

export type DaemonCodexPort = CodexTurnStarter & {
  close(): void;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  readThread(input: {
    includeTurns: boolean;
    threadId: string;
  }): Promise<{ thread: Record<string, unknown> }>;
  resumeThread(threadId: string): Promise<{ thread: { id: string } }>;
  setThreadName(input: { name: string; threadId: string }): Promise<unknown>;
  startThread(cwd: string): Promise<{ thread: { id: string } }>;
};

export type DaemonILinkPort = ILinkSender & {
  getUpdates(input: {
    cursor: string;
    session: ILinkSession;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<GetUpdatesResult>;
  notifyStart?(input: { session: ILinkSession }): Promise<void>;
  notifyStop?(input: { session: ILinkSession }): Promise<void>;
};

export type HookReceiverPort = {
  close(): Promise<void>;
  drainSpool(): Promise<number>;
  start(): Promise<void>;
};

export type ActiveTaskCounterPort = {
  setActiveTaskCount(count: number): Promise<void>;
};

export type DaemonMediaPort = InboundMediaPort & {
  prune(activeDedupeKeys: ReadonlySet<string>): Promise<number>;
};

export type BridgeDaemonOptions = {
  activeTaskCounter?: ActiveTaskCounterPort;
  bridgeInstanceId: string;
  codex: DaemonCodexPort;
  eventQuiesceTimeoutMs?: number;
  hookReceiver: HookReceiverPort;
  ilink: DaemonILinkPort;
  inboxDirectory: string;
  leases: SqliteTurnLeaseStore;
  listProjects?: BridgeEngineOptions["listProjects"];
  media?: DaemonMediaPort;
  newId: () => string;
  now: () => number;
  onLifecycleWarning?: (
    operation: "notifyStart" | "notifyStop",
    error: unknown,
  ) => void;
  presence?: () => Promise<PresenceState>;
  session: ILinkSession;
  state: SqliteState;
};

const DEFAULT_EVENT_QUIESCE_TIMEOUT_MS = 10_000;

export class BridgeDaemon {
  readonly #options: BridgeDaemonOptions;
  #bridge: BridgeEngine | undefined;
  readonly #codexEventTasks = new Set<Promise<unknown>>();
  #desktopNotifier: DesktopNotifier | undefined;
  #outbox: OutboxWorker | undefined;
  #started = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: BridgeDaemonOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    mkdirSync(this.#options.inboxDirectory, { recursive: true });

    let mainThreadId = this.#options.state.getBridgeSettings().mainThreadId;
    if (!mainThreadId) {
      const started = await this.#options.codex.startThread(
        this.#options.inboxDirectory,
      );
      mainThreadId = started.thread.id;
      await this.#options.codex.setThreadName({
        name: "微信主会话",
        threadId: mainThreadId,
      });
      this.#options.state.setMainThreadId(mainThreadId);
    }

    if (this.#options.media) {
      try {
        await this.#options.media.prune(
          new Set(this.#options.state.listActiveTurnDedupeKeys()),
        );
      } catch {
        // Media cleanup is retried on the next start and cannot block the
        // transport from recovering already durable work.
      }
    }

    this.#bridge = new BridgeEngine({
      bridgeInstanceId: this.#options.bridgeInstanceId,
      codex: this.#options.codex,
      ilink: this.#options.ilink,
      inboxDirectory: this.#options.inboxDirectory,
      leases: this.#options.leases,
      mainThreadId,
      newId: this.#options.newId,
      now: this.#options.now,
      ...(this.#options.listProjects
        ? { listProjects: this.#options.listProjects }
        : {}),
      ...(this.#options.media ? { media: this.#options.media } : {}),
      session: this.#options.session,
      state: this.#options.state,
    });
    this.#desktopNotifier = this.#options.presence
      ? new DesktopNotifier({
          now: this.#options.now,
          presence: this.#options.presence,
          readThread: (input) => this.#options.codex.readThread(input),
          session: this.#options.session,
          state: this.#options.state,
        })
      : undefined;
    this.#outbox = new OutboxWorker({
      ilink: this.#options.ilink,
      now: this.#options.now,
      routeOnConfirmed: (item, confirmedAtMs) => {
        const source = parseDesktopNotificationClientId(item.clientId);
        return source
          ? desktopNotificationRoute(
              source.threadId,
              source.turnId,
              confirmedAtMs,
            )
          : null;
      },
      session: this.#options.session,
      state: this.#options.state,
    });
    this.#unsubscribe = this.#options.codex.onEvent((event) => {
      const bridge = this.#bridge;
      if (!bridge) return;
      const task = bridge
        .ingestCodexEvent(event)
        .finally(() => this.#syncActiveTaskCount())
        .catch(() => undefined);
      this.#codexEventTasks.add(task);
      void task.then(() => {
        this.#codexEventTasks.delete(task);
      });
    });
    this.#options.state.enableArbitration(this.#options.bridgeInstanceId);
    this.#options.state.pruneExpiredDesktopObservationTombstones(
      this.#options.now(),
    );
    this.#started = true;
    await this.#notifyILinkLifecycle("notifyStart");
    await this.#options.hookReceiver.start();
    await this.#options.hookReceiver.drainSpool();
    await this.#outbox.drain();
    try {
      await this.#bridge.recoverPendingWork();
    } finally {
      await this.#syncActiveTaskCount();
    }
  }

  async pollOnce(signal?: AbortSignal): Promise<{ accepted: number; sent: number }> {
    if (!this.#started || !this.#bridge) {
      throw new Error("Bridge daemon is not started");
    }
    this.#options.state.pruneExpiredDesktopObservationTombstones(
      this.#options.now(),
    );
    await this.#options.hookReceiver.drainSpool();
    await this.#bridge.reconcilePendingWork();
    await this.#syncActiveTaskCount();
    await this.#outbox?.drain(signal);
    const cursor =
      this.#options.state.getILinkState(this.#options.session.botId)?.cursor ?? "";
    const updates = await this.#options.ilink.getUpdates({
      cursor,
      session: this.#options.session,
      ...(signal ? { signal } : {}),
    });
    // A Desktop prompt can arrive while the iLink long-poll is waiting. Drain
    // it before processing the returned batch so s<n> cannot race that prompt.
    await this.#options.hookReceiver.drainSpool();
    if (updates.kind === "timeout") return { accepted: 0, sent: 0 };
    try {
      return await this.#bridge.ingestBatch({
        beforeAcceptedMessage: async () => {
          await this.#options.hookReceiver.drainSpool();
        },
        cursor: updates.cursor,
        messages: updates.messages,
        onAccepted: async () => {
          this.#outbox?.resetDeferred();
          await this.#outbox?.drain(signal);
        },
      });
    } finally {
      await this.#syncActiveTaskCount();
    }
  }

  async ingestHookEvent(event: HookEvent): Promise<void> {
    if (event.eventName === "UserPromptSubmit") {
      if (!event.turnId || event.source !== "codex-ilink-guard") return;
      const lease = this.#options.leases.getLease(event.sessionId);
      if (
        this.#options.state.getDispatchIntentByTurnId(event.turnId) ||
        lease?.owner === "bridge" ||
        (lease?.owner === "desktop" && lease.turnId !== event.turnId)
      ) {
        return;
      }
      this.#options.state.observeDesktopTurn({
        createdAtMs: event.capturedAtMs,
        threadId: event.sessionId,
        turnId: event.turnId,
      });
      return;
    }
    if (event.eventName === "PermissionRequest") {
      const lease = this.#options.leases.getLease(event.sessionId);
      if (
        event.turnId &&
        (this.#options.state.getDispatchIntentByTurnId(event.turnId) ||
          (lease?.owner === "bridge" && lease.turnId === event.turnId))
      ) {
        return;
      }
      await this.#notifyDesktopPermission(event);
      return;
    }
    if (event.eventName !== "Stop" || !event.turnId) return;
    if (this.#options.state.getDispatchIntentByTurnId(event.turnId)) return;
    const leaseStopped = this.#options.leases.markDesktopStop({
      stoppedAtMs: event.capturedAtMs,
      threadId: event.sessionId,
      turnId: event.turnId,
    });
    const observationStopped =
      this.#options.state.markDesktopTurnObservationStopped({
      stoppedAtMs: event.capturedAtMs,
      threadId: event.sessionId,
      turnId: event.turnId,
    });
    if (!leaseStopped && !observationStopped) {
      this.#options.state.recordDesktopTurnStopTombstone({
        stoppedAtMs: event.capturedAtMs,
        threadId: event.sessionId,
        turnId: event.turnId,
      });
      return;
    }
    await this.#reconcileDesktopStop({ ...event, turnId: event.turnId }, 0);
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => Promise<unknown> | unknown) => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    await attempt(() => this.#options.hookReceiver.close());
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    await attempt(() => unsubscribe?.());
    await attempt(() => this.#bridge?.beginShutdown());
    const quiesceTimeoutMs =
      this.#options.eventQuiesceTimeoutMs ?? DEFAULT_EVENT_QUIESCE_TIMEOUT_MS;
    let bridgeClosed = false;
    let codexClosed = false;
    const quiesced = await this.#waitForCodexEvents(quiesceTimeoutMs);
    if (!quiesced) {
      await attempt(() => this.#bridge?.close());
      bridgeClosed = true;
      await attempt(() => this.#options.codex.close());
      codexClosed = true;
      if (!(await this.#waitForCodexEvents(quiesceTimeoutMs))) {
        cleanupErrors.push(new Error("E_CODEX_EVENT_QUIESCE_TIMEOUT"));
      }
    }
    if (!bridgeClosed) await attempt(() => this.#bridge?.close());
    if (!codexClosed) await attempt(() => this.#options.codex.close());
    await attempt(() => this.#notifyILinkLifecycle("notifyStop"));
    await attempt(() =>
      this.#options.state.disableArbitration(this.#options.bridgeInstanceId),
    );
    this.#bridge = undefined;
    this.#desktopNotifier = undefined;
    this.#outbox = undefined;
    this.#started = false;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "E_DAEMON_STOP");
    }
  }

  async #waitForCodexEvents(timeoutMs: number): Promise<boolean> {
    if (this.#codexEventTasks.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...this.#codexEventTasks]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #notifyILinkLifecycle(
    operation: "notifyStart" | "notifyStop",
  ): Promise<void> {
    const notify = this.#options.ilink[operation];
    if (!notify) return;
    try {
      await notify.call(this.#options.ilink, { session: this.#options.session });
    } catch (error) {
      try {
        this.#options.onLifecycleWarning?.(operation, error);
      } catch {
        // Lifecycle notifications and their warning sink are both best-effort.
      }
    }
  }

  async #reconcileDesktopStop(
    event: HookEvent & { turnId: string },
    attempt: number,
  ): Promise<void> {
    const threadId = event.sessionId;
    const turnId = event.turnId;
    let lastError: unknown;
    for (let currentAttempt = attempt; currentAttempt <= 20; currentAttempt += 1) {
      if (!this.#started) return;
      try {
        await this.#options.codex.ensureThread?.(threadId);
        const read = await this.#options.codex.readThread({
          includeTurns: true,
          threadId,
        });
        const turns = Array.isArray(read.thread.turns) ? read.thread.turns : [];
        const turn = turns
          .filter(
            (value): value is Record<string, unknown> =>
              Boolean(value) &&
              typeof value === "object" &&
              !Array.isArray(value),
          )
          .find((value) => value.id === turnId);
        const status = desktopTerminalStatus(turn?.status);
        if (status) {
          await this.#notifyDesktopTerminalOnce(event, status);
          const releasedLease = this.#options.leases.releaseStoppedDesktop({
            threadId,
            turnId,
          });
          const releasedObservation =
            this.#options.state.releaseStoppedDesktopTurnObservation({
              threadId,
              turnId,
            });
          if (releasedLease || releasedObservation) {
            try {
              await this.#bridge?.scheduleQueuedTurns();
            } finally {
              await this.#syncActiveTaskCount();
            }
            return;
          }
          const currentLease = this.#options.leases.getLease(threadId);
          const currentObservation =
            this.#options.state.getDesktopTurnObservation(threadId);
          if (
            (!currentLease ||
              currentLease.owner !== "desktop" ||
              currentLease.turnId !== turnId ||
              currentLease.operationId !== turnId) &&
            currentObservation?.turnId !== turnId
          ) {
            return;
          }
        }
      } catch (error) {
        lastError = error;
      }
      if (currentAttempt < 20) await delay(250);
    }
    throw new Error("E_DESKTOP_STOP_NOT_DURABLE", { cause: lastError });
  }

  async #notifyDesktopTerminalOnce(
    event: HookEvent & { turnId: string },
    status: DesktopTerminalStatus,
  ): Promise<void> {
    const notifier = this.#desktopNotifier;
    if (!notifier) return;
    const result = await notifier.notifyTerminal(event, status);
    if (result !== "present") void this.#outbox?.drain().catch(() => undefined);
  }

  async #notifyDesktopPermission(event: HookEvent): Promise<void> {
    const notifier = this.#desktopNotifier;
    if (!notifier) return;
    const result = await notifier.notifyPermission(event);
    if (result !== "present") void this.#outbox?.drain().catch(() => undefined);
  }

  async #syncActiveTaskCount(): Promise<void> {
    const guardedThreadIds = new Set(
      this.#options.state.listGuardedThreadIds(this.#options.now()),
    );
    await this.#options.activeTaskCounter?.setActiveTaskCount(
      Math.max(
        this.#options.state.countActiveDispatches(),
        this.#options.leases
          .listLeases()
          .filter(
            ({ owner, threadId }) =>
              owner === "bridge" || guardedThreadIds.has(threadId),
          ).length,
      ),
    );
  }
}

function desktopTerminalStatus(value: unknown): DesktopTerminalStatus | null {
  return value === "completed" || value === "failed" || value === "interrupted"
    ? value
    : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
