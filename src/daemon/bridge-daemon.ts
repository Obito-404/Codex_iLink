import { mkdirSync } from "node:fs";

import {
  BridgeEngine,
  type CodexEvent,
  type CodexTurnStarter,
  type BridgeEngineOptions,
  type InboundMediaPort,
  type ILinkSender,
} from "../bridge/bridge.ts";
import {
  SqliteState,
  type TerminalNotificationJob,
} from "../bridge/sqlite-state.ts";
import { OutboxWorker } from "../bridge/outbox-worker.ts";
import { SqliteTurnLeaseStore } from "../coordination/turn-lease.ts";
import {
  DesktopNotifier,
  desktopNotificationRoute,
  terminalNotificationOrigin,
  type DesktopTerminalStatus,
} from "./desktop-notifier.ts";
import {
  isFinalDesktopNotificationPart,
  parseDesktopNotificationClientId,
  type TerminalNotificationOrigin,
} from "../bridge/desktop-notification-identity.ts";
import type { HookDecision, HookEvent } from "../hooks/hook-receiver.ts";
import type { ThreadPermissionSettings } from "../codex/protocol.ts";
import {
  ILinkError,
  type GetUpdatesResult,
  type ILinkSession,
} from "../ilink/protocol.ts";
import type {
  PresenceObservation,
  PresenceState,
} from "../windows/presence.ts";
import {
  outboundMediaDirectory,
  outboundMediaPathKey,
  parseOutboundPayload,
  pruneOutboundMediaSnapshots,
} from "../media/outbound-media.ts";

export type DaemonCodexPort = CodexTurnStarter & {
  close(): void;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  readThread(input: {
    includeTurns: boolean;
    threadId: string;
  }): Promise<{ thread: Record<string, unknown> }>;
  resumeThread(
    threadId: string,
  ): Promise<Record<string, unknown> & { thread: { id: string } }>;
  setThreadName(input: { name: string; threadId: string }): Promise<unknown>;
  startThread(
    cwd: string,
    permissions?: ThreadPermissionSettings,
  ): Promise<{ thread: { id: string } }>;
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
  stopAccepting?(): Promise<void> | void;
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
  newThreadPermissions?: () => ThreadPermissionSettings;
  newId: () => string;
  now: () => number;
  onLifecycleWarning?: (
    operation: "notifyStart" | "notifyStop",
    error: unknown,
  ) => void;
  presence?: () => Promise<PresenceState>;
  presenceObservation?: () => Promise<PresenceObservation>;
  session: ILinkSession;
  state: SqliteState;
};

const DEFAULT_EVENT_QUIESCE_TIMEOUT_MS = 10_000;
const TRANSPORT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const TERMINAL_NOTIFICATION_RECONCILE_BATCH_SIZE = 4;
type TerminalNotificationEvidence = TerminalNotificationJob["evidence"];

export class BridgeDaemon {
  readonly #options: BridgeDaemonOptions;
  #bridge: BridgeEngine | undefined;
  readonly #codexEventTasks = new Set<Promise<unknown>>();
  #terminalNotifier: DesktopNotifier | undefined;
  #outbox: OutboxWorker | undefined;
  #nextTransportMaintenanceAtMs = 0;
  #started = false;
  #terminalNotificationJobOffset = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(options: BridgeDaemonOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    mkdirSync(this.#options.inboxDirectory, { recursive: true });
    const outboundDirectory = outboundMediaDirectory(
      this.#options.inboxDirectory,
    );
    const startupNowMs = this.#options.now();
    this.#maintainTransportState(startupNowMs);

    try {
      const retainedPathKeys = new Set(
        this.#options.state.listOutboundAttachmentPathKeys(),
      );
      for (const item of this.#options.state.listPendingOutbox()) {
        if (!item.body) continue;
        try {
          const payload = parseOutboundPayload(item.body);
          if (payload.type === "local-media" && payload.staged === true) {
            retainedPathKeys.add(outboundMediaPathKey(payload.path));
          }
        } catch {
          // A malformed outbox item is not a reference to a trusted snapshot.
        }
      }
      pruneOutboundMediaSnapshots({
        exportRoot: outboundDirectory,
        retainedPathKeys,
      });
    } catch {
      // Only trusted UUID snapshots are pruned; startup retries any cleanup.
    }

    let mainThreadId = this.#options.state.getBridgeSettings().mainThreadId;
    if (!mainThreadId) {
      if (!this.#options.newThreadPermissions) {
        throw new Error("Desktop permission source is not configured");
      }
      const started = await this.#options.codex.startThread(
        this.#options.inboxDirectory,
        this.#options.newThreadPermissions(),
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
      ...(this.#options.newThreadPermissions
        ? { newThreadPermissions: this.#options.newThreadPermissions }
        : {}),
      now: this.#options.now,
      ...(this.#options.listProjects
        ? { listProjects: this.#options.listProjects }
        : {}),
      ...(this.#options.media ? { media: this.#options.media } : {}),
      session: this.#options.session,
      state: this.#options.state,
    });
    this.#terminalNotifier = new DesktopNotifier({
      now: this.#options.now,
      ...(this.#options.presence ? { presence: this.#options.presence } : {}),
      readThread: (input) => this.#options.codex.readThread(input),
      session: this.#options.session,
      state: this.#options.state,
    });
    this.#outbox = new OutboxWorker({
      ilink: this.#options.ilink,
      now: this.#options.now,
      outboundDirectory,
      routeOnConfirmed: (item, confirmedAtMs) => {
        const source = parseDesktopNotificationClientId(item.clientId);
        return source?.replyable &&
          isFinalDesktopNotificationPart(item.clientId, (clientId) =>
            Boolean(this.#options.state.getOutbox(clientId)),
          )
          ? desktopNotificationRoute(
              source.threadId,
              source.turnId,
              confirmedAtMs,
              source.origin,
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
      startupNowMs,
    );
    this.#started = true;
    await this.#notifyILinkLifecycle("notifyStart");
    await this.#options.hookReceiver.start();
    await this.#options.hookReceiver.drainSpool();
    await this.#reconcileTerminalNotificationJobs();
    await this.#allowStartupAuthPause(() => this.#outbox?.drain());
    await this.#reconcilePendingDesktopNotifications();
    await this.#allowStartupAuthPause(() => this.#outbox?.drain());
    try {
      await this.#allowStartupAuthPause(() => this.#bridge?.recoverPendingWork());
    } finally {
      await this.#syncActiveTaskCount();
    }
  }

  async #allowStartupAuthPause(
    operation: () => Promise<unknown> | undefined,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof ILinkError) || error.kind !== "auth-expired") {
        throw error;
      }
    }
  }

  async pollOnce(signal?: AbortSignal): Promise<{ accepted: number; sent: number }> {
    if (!this.#started || !this.#bridge) {
      throw new Error("Bridge daemon is not started");
    }
    const pollNowMs = this.#options.now();
    this.#maintainTransportState(pollNowMs);
    this.#options.state.pruneExpiredDesktopObservationTombstones(
      pollNowMs,
    );
    await this.#options.hookReceiver.drainSpool();
    await this.#reconcileTerminalNotificationJobs(signal);
    await this.#bridge.reconcilePendingWork();
    await this.#reconcilePendingDesktopNotifications();
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

  async ingestHookEvent(
    event: HookEvent,
    signal = new AbortController().signal,
  ): Promise<HookDecision | void> {
    const controller = this.#options.state.getController();
    if (controller && event.capturedAtMs <= controller.boundAtMs) {
      return event.eventName === "PermissionRequest"
        ? { behavior: "passthrough" }
        : undefined;
    }
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
      const bridge = this.#bridge;
      const lease = this.#options.leases.getLease(event.sessionId);
      if (
        event.turnId &&
        (this.#options.state.getDispatchIntentByTurnId(event.turnId) ||
          (lease?.owner === "bridge" && lease.turnId === event.turnId))
      ) {
        return { behavior: "passthrough" };
      }
      if (
        !event.turnId ||
        !event.requestId ||
        !event.requestFingerprint ||
        !event.requestSummary ||
        !bridge
      ) {
        return { behavior: "passthrough" };
      }
      if (
        !this.#options.state.getILinkState(this.#options.session.botId)
          ?.contextToken
      ) {
        return { behavior: "passthrough" };
      }
      let permissions: Record<string, unknown>;
      try {
        permissions = await this.#options.codex.resumeThread(event.sessionId);
      } catch {
        return { behavior: "passthrough" };
      }
      if (
        permissions.approvalsReviewer !== "user" ||
        permissions.approvalPolicy !== "on-request"
      ) {
        return { behavior: "passthrough" };
      }
      const behavior = await bridge.requestDesktopApproval({
        requestId: event.requestId,
        requestFingerprint: event.requestFingerprint,
        signal,
        summary: event.requestSummary,
        threadId: event.sessionId,
        toolName: event.toolName,
        turnId: event.turnId,
      });
      return { behavior };
    }
    if (event.eventName !== "Stop" || !event.turnId) return;
    if (signal.aborted) return;
    if (this.#options.state.getDispatchIntentByTurnId(event.turnId)) return;
    const existingLease = this.#options.leases.getLease(event.sessionId);
    const existingObservation =
      this.#options.state.getDesktopTurnObservation(event.sessionId);
    let evidence: TerminalNotificationEvidence =
      (existingLease?.owner === "desktop" &&
        existingLease.turnId === event.turnId &&
        existingLease.operationId === event.turnId) ||
      existingObservation?.turnId === event.turnId
        ? "managed-desktop"
        : "unmatched";
    const jobInput = {
      capturedAtMs: event.capturedAtMs,
      cwd: event.cwd,
      threadId: event.sessionId,
      turnId: event.turnId,
    };
    // Persist before touching arbitration state; a second upsert below can
    // only promote evidence after the exact lease/observation Stop succeeds.
    this.#options.state.putTerminalNotificationJob({ ...jobInput, evidence });
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
    if (leaseStopped || observationStopped) evidence = "managed-desktop";
    if (evidence === "managed-desktop") {
      this.#options.state.putTerminalNotificationJob({ ...jobInput, evidence });
    }
    if (evidence === "unmatched") {
      this.#options.state.recordDesktopTurnStopTombstone({
        stoppedAtMs: event.capturedAtMs,
        threadId: event.sessionId,
        turnId: event.turnId,
      });
      await this.#reconcileTerminalStop(
        { ...event, turnId: event.turnId },
        0,
        signal,
      );
      return;
    }
    await this.#reconcileTerminalStop(
      { ...event, turnId: event.turnId },
      0,
      signal,
    );
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

    await attempt(() => this.#options.hookReceiver.stopAccepting?.());
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
    await attempt(() => this.#options.hookReceiver.close());
    await attempt(() => this.#notifyILinkLifecycle("notifyStop"));
    await attempt(() =>
      this.#options.state.disableArbitration(this.#options.bridgeInstanceId),
    );
    this.#bridge = undefined;
    this.#terminalNotifier = undefined;
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

  async #reconcileTerminalStop(
    event: HookEvent & { turnId: string },
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const threadId = event.sessionId;
    const turnId = event.turnId;
    let lastError: unknown;
    for (let currentAttempt = attempt; currentAttempt <= 20; currentAttempt += 1) {
      if (!this.#started || signal?.aborted) return;
      try {
        await this.#options.codex.ensureThread?.(threadId);
        if (signal?.aborted) return;
        const read = await this.#options.codex.readThread({
          includeTurns: true,
          threadId,
        });
        if (signal?.aborted) return;
        const turns = Array.isArray(read.thread.turns) ? read.thread.turns : [];
        const turn = turns
          .filter(
            (value): value is Record<string, unknown> =>
              Boolean(value) &&
              typeof value === "object" &&
              !Array.isArray(value),
          )
          .find((value) => value.id === turnId);
        const status = terminalNotificationStatus(turn?.status);
        if (status) {
          const controller = this.#options.state.getController();
          const startedAtMs = terminalTurnStartedAtMs(turn?.startedAt);
          const origin =
            controller &&
            startedAtMs !== null &&
            startedAtMs > controller.boundAtMs
              ? terminalNotificationOrigin(read.thread.source)
              : null;
          if (origin) {
            await this.#notifyTerminalOnce(
              event,
              status,
              origin,
              read.thread,
              signal,
            );
          }
          if (signal?.aborted) return;
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
            this.#options.state.deleteTerminalNotificationJob(threadId, turnId);
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
            this.#options.state.deleteTerminalNotificationJob(threadId, turnId);
            return;
          }
        }
      } catch (error) {
        lastError = error;
      }
      if (currentAttempt < 20) {
        await delay(250);
        if (signal?.aborted) return;
      }
    }
    throw new Error("E_DESKTOP_STOP_NOT_DURABLE", { cause: lastError });
  }

  async #notifyTerminalOnce(
    event: HookEvent & { turnId: string },
    status: DesktopTerminalStatus,
    origin: TerminalNotificationOrigin,
    thread: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const notifier = this.#terminalNotifier;
    if (!notifier) return;
    const observePresence =
      origin === "desktop" ? this.#options.presenceObservation : undefined;
    let confirmedAway = false;
    if (observePresence) {
      let observation: PresenceObservation;
      try {
        observation = await observePresence();
      } catch {
        if (signal?.aborted) return;
        this.#deferDesktopNotification(event, status);
        return;
      }
      if (signal?.aborted) return;
      const lastInputAtMs = this.#options.now() - observation.idleMilliseconds;
      if (lastInputAtMs > event.capturedAtMs) return;
      if (observation.state === "present") {
        this.#deferDesktopNotification(event, status);
        return;
      }
      confirmedAway = true;
    }
    const result = await notifier.notifyTerminal(event, status, {
      ...(confirmedAway ? { presence: "away" as const } : {}),
      origin,
      ...(signal ? { signal } : {}),
      thread,
    });
    if (signal?.aborted) return;
    if (result !== "present" && result !== "cancelled") {
      void this.#outbox?.drain().catch(() => undefined);
    }
  }

  #deferDesktopNotification(
    event: HookEvent & { turnId: string },
    status: DesktopTerminalStatus,
  ): void {
    this.#options.state.putPendingDesktopNotification({
      completedAtMs: event.capturedAtMs,
      cwd: event.cwd,
      status,
      threadId: event.sessionId,
      turnId: event.turnId,
    });
  }

  async #reconcileTerminalNotificationJobs(signal?: AbortSignal): Promise<void> {
    const jobs = this.#options.state.listTerminalNotificationJobs(
      this.#options.now(),
    );
    if (jobs.length === 0) {
      this.#terminalNotificationJobOffset = 0;
      return;
    }
    const start = this.#terminalNotificationJobOffset % jobs.length;
    const batchSize = Math.min(
      TERMINAL_NOTIFICATION_RECONCILE_BATCH_SIZE,
      jobs.length,
    );
    const batch = Array.from(
      { length: batchSize },
      (_, index) => jobs[(start + index) % jobs.length],
    ).filter((job): job is TerminalNotificationJob => Boolean(job));
    this.#terminalNotificationJobOffset = (start + batchSize) % jobs.length;
    await Promise.all(
      batch.map((job) => this.#reconcileTerminalNotificationJob(job, signal)),
    );
  }

  async #reconcileTerminalNotificationJob(
    job: TerminalNotificationJob,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    try {
      if (job.evidence === "managed-desktop") {
        this.#options.leases.markDesktopStop({
          stoppedAtMs: job.capturedAtMs,
          threadId: job.threadId,
          turnId: job.turnId,
        });
        this.#options.state.markDesktopTurnObservationStopped({
          stoppedAtMs: job.capturedAtMs,
          threadId: job.threadId,
          turnId: job.turnId,
        });
      } else {
        this.#options.state.recordDesktopTurnStopTombstone({
          stoppedAtMs: job.capturedAtMs,
          threadId: job.threadId,
          turnId: job.turnId,
        });
      }
      await this.#reconcileTerminalStop(
        {
          capturedAtMs: job.capturedAtMs,
          cwd: job.cwd,
          eventName: "Stop",
          model: null,
          permissionMode: null,
          schemaVersion: 1,
          sessionId: job.threadId,
          source: null,
          toolName: null,
          turnId: job.turnId,
        },
        20,
        signal,
      );
    } catch {
      // The durable job remains for the next startup or polling pass.
    }
  }

  async #reconcilePendingDesktopNotifications(): Promise<void> {
    const notifier = this.#terminalNotifier;
    const observePresence = this.#options.presenceObservation;
    const pending = this.#options.state.listPendingDesktopNotifications();
    if (!notifier || !observePresence || pending.length === 0) return;

    let observation: PresenceObservation;
    try {
      observation = await observePresence();
    } catch {
      return;
    }
    const lastInputAtMs = this.#options.now() - observation.idleMilliseconds;
    for (const candidate of pending) {
      if (lastInputAtMs > candidate.completedAtMs) {
        this.#options.state.deletePendingDesktopNotification(
          candidate.threadId,
          candidate.turnId,
        );
        continue;
      }
      if (observation.state !== "away") continue;
      try {
        await this.#options.codex.ensureThread?.(candidate.threadId);
        const read = await this.#options.codex.readThread({
          includeTurns: true,
          threadId: candidate.threadId,
        });
        const result = await notifier.notifyTerminal(
          {
            capturedAtMs: candidate.completedAtMs,
            cwd: candidate.cwd,
            eventName: "Stop",
            model: null,
            permissionMode: null,
            schemaVersion: 1,
            sessionId: candidate.threadId,
            source: null,
            toolName: null,
            turnId: candidate.turnId,
          },
          candidate.status,
          { presence: "away", thread: read.thread },
        );
        if (result !== "present") {
          this.#options.state.deletePendingDesktopNotification(
            candidate.threadId,
            candidate.turnId,
          );
        }
      } catch {
        // Keep the durable candidate for the next poll.
      }
    }
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

  #maintainTransportState(nowMs: number): void {
    if (nowMs < this.#nextTransportMaintenanceAtMs) return;
    this.#nextTransportMaintenanceAtMs =
      nowMs + TRANSPORT_MAINTENANCE_INTERVAL_MS;
    try {
      this.#options.state.pruneExpiredTransportState(nowMs);
      this.#options.state.pruneExpiredTerminalNotificationJobs(nowMs);
    } catch {
      // Retention is retried on the next bounded maintenance interval and
      // cannot block durable transport recovery.
    }
  }
}

function terminalNotificationStatus(value: unknown): DesktopTerminalStatus | null {
  return value === "completed" || value === "failed" || value === "interrupted"
    ? value
    : null;
}

function terminalTurnStartedAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const milliseconds = value * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
