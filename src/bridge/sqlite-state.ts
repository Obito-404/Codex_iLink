import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Controller = {
  accountId: string;
  boundAtMs: number;
  userId: string;
};

export type InboundMessageInput = {
  body: string;
  contextToken: string;
  messageId: string;
  receivedAtMs: number;
};

export type InboundMessage = Omit<InboundMessageInput, "body"> & {
  accountId: string;
  body: string | null;
  controllerUserId: string;
  id: number;
};

export type Binding = {
  expiresAtMs: number;
  projectPath: string | null;
  threadId: string;
  updatedAtMs: number;
};

export type NotificationRoute = {
  deliveredAtMs: number;
  eventId: string;
  expiresAtMs: number;
  threadId: string;
};

export type DesktopTurnObservation = {
  createdAtMs: number;
  stopSeenAtMs: number | null;
  threadId: string;
  turnId: string;
};

export type PendingDesktopNotification = {
  completedAtMs: number;
  cwd: string | null;
  status: "completed" | "failed" | "interrupted";
  threadId: string;
  turnId: string;
};

const DESKTOP_OBSERVATION_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type QueuedTurn = {
  body: string;
  contextToken: string;
  createdAtMs: number;
  dedupeKey: string;
  id: number;
  threadId: string;
};

export type DispatchIntent = {
  body: string | null;
  completedAtMs: number | null;
  contextToken: string;
  createdAtMs: number;
  dedupeKey: string;
  operationId: string;
  status: "accepted" | "pending" | "unknown";
  threadId: string;
  turnId: string | null;
  updatedAtMs: number;
};

export type OutboxItem = {
  body: string | null;
  clientId: string;
  confirmedAtMs: number | null;
  contextToken: string;
  createdAtMs: number;
  status: "confirmed" | "pending";
  targetUserId: string;
};

export type PendingOutboxInput = Pick<
  OutboxItem,
  "body" | "clientId" | "contextToken" | "createdAtMs" | "targetUserId"
>;

export type BridgeRuntime = {
  arbitrationEnabled: boolean;
  instanceId: string;
};

export type BridgeSettings = {
  mainThreadId: string | null;
  selectedProjectPath: string | null;
};

export type ThreadPermissionProfile = {
  profileId: string;
  threadId: string;
  updatedAtMs: number;
};

export type ProjectListSnapshot = {
  createdAtMs: number;
  expiresAtMs: number;
  projects: string[];
};

export type SessionListSnapshot = {
  archived: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  hasNext: boolean;
  page: number;
  projectPath: string | null;
  threads: Array<{
    archived: boolean;
    projectPath: string | null;
    threadId: string;
  }>;
};

export type ILinkSession = {
  baseUrl: string;
  botId: string;
  controllerUserId: string;
  protectedToken: string;
};

export class SqliteState {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  storageDiagnostics(): {
    journalMode: string;
    schemaVersion: number;
    synchronous: string;
  } {
    const journal = this.#database.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    const synchronous = this.#database.prepare("PRAGMA synchronous").get() as
      | { synchronous: number }
      | undefined;
    const version = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    return {
      journalMode: journal?.journal_mode ?? "unknown",
      schemaVersion: version?.user_version ?? 0,
      synchronous: synchronous?.synchronous === 2 ? "full" : "unknown",
    };
  }

  bindController(controller: Controller): Controller {
    const current = this.getController();
    if (current) {
      if (
        current.accountId !== controller.accountId ||
        current.userId !== controller.userId
      ) {
        throw new Error("controller mismatch");
      }
      return current;
    }

    this.#database
      .prepare(
        "INSERT INTO controller (singleton, account_id, user_id, bound_at_ms) VALUES (1, ?, ?, ?)",
      )
      .run(controller.accountId, controller.userId, controller.boundAtMs);
    return controller;
  }

  getController(): Controller | null {
    const row = this.#database
      .prepare(
        "SELECT account_id, user_id, bound_at_ms FROM controller WHERE singleton = 1",
      )
      .get() as
      | { account_id: string; bound_at_ms: number; user_id: string }
      | undefined;
    return row
      ? {
          accountId: row.account_id,
          boundAtMs: row.bound_at_ms,
          userId: row.user_id,
        }
      : null;
  }

  isController(accountId: string, userId: string): boolean {
    const controller = this.getController();
    return controller?.accountId === accountId && controller.userId === userId;
  }

  acceptInboundBatch(input: {
    accountId: string;
    controllerUserId: string;
    messages: readonly InboundMessageInput[];
    nextCursor: string;
    updatedAtMs: number;
  }): { acceptedMessageIds: string[]; duplicateCount: number } {
    return this.#transaction(() => {
      if (!this.isController(input.accountId, input.controllerUserId)) {
        throw new Error("controller mismatch");
      }

      const insert = this.#database.prepare(
        `INSERT INTO inbound_messages
          (account_id, controller_user_id, message_id, context_token, body, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, controller_user_id, message_id) DO NOTHING`,
      );
      const acceptedMessageIds: string[] = [];
      for (const message of input.messages) {
        const result = insert.run(
          input.accountId,
          input.controllerUserId,
          message.messageId,
          message.contextToken,
          message.body,
          message.receivedAtMs,
        );
        if (Number(result.changes) === 1) acceptedMessageIds.push(message.messageId);
      }

      const latestContextToken = input.messages.at(-1)?.contextToken ?? null;
      this.#database
        .prepare(
          `INSERT INTO ilink_state (account_id, cursor, context_token, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET
             cursor = excluded.cursor,
             context_token = COALESCE(excluded.context_token, ilink_state.context_token),
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.accountId,
          input.nextCursor,
          latestContextToken,
          input.updatedAtMs,
        );
      return {
        acceptedMessageIds,
        duplicateCount: input.messages.length - acceptedMessageIds.length,
      };
    });
  }

  getILinkState(accountId: string): {
    contextToken: string | null;
    cursor: string;
    updatedAtMs: number;
  } | null {
    const row = this.#database
      .prepare(
        "SELECT cursor, context_token, updated_at_ms FROM ilink_state WHERE account_id = ?",
      )
      .get(accountId) as
      | { context_token: string | null; cursor: string; updated_at_ms: number }
      | undefined;
    return row
      ? {
          contextToken: row.context_token,
          cursor: row.cursor,
          updatedAtMs: row.updated_at_ms,
        }
      : null;
  }

  listInboundMessages(): InboundMessage[] {
    const rows = this.#database
      .prepare(
        `SELECT id, account_id, controller_user_id, message_id,
                context_token, body, received_at_ms
         FROM inbound_messages ORDER BY id`,
      )
      .all() as Array<{
      account_id: string;
      body: string | null;
      context_token: string;
      controller_user_id: string;
      id: number;
      message_id: string;
      received_at_ms: number;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      body: row.body,
      contextToken: row.context_token,
      controllerUserId: row.controller_user_id,
      id: row.id,
      messageId: row.message_id,
      receivedAtMs: row.received_at_ms,
    }));
  }

  clearInboundBody(
    accountId: string,
    controllerUserId: string,
    messageId: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE inbound_messages SET body = NULL
         WHERE account_id = ? AND controller_user_id = ? AND message_id = ?
           AND body IS NOT NULL`,
      )
      .run(accountId, controllerUserId, messageId);
    return Number(result.changes) === 1;
  }

  setBinding(binding: Binding): void {
    this.#database
      .prepare(
        `INSERT INTO bindings
          (singleton, thread_id, project_path, expires_at_ms, updated_at_ms)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           thread_id = excluded.thread_id,
           project_path = excluded.project_path,
           expires_at_ms = excluded.expires_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        binding.threadId,
        binding.projectPath,
        binding.expiresAtMs,
        binding.updatedAtMs,
      );
  }

  setBindingForNavigation(binding: Binding): void {
    this.#transaction(() => {
      this.#database.exec("DELETE FROM notification_routes");
      this.#database
        .prepare(
          `INSERT INTO bindings
            (singleton, thread_id, project_path, expires_at_ms, updated_at_ms)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (singleton) DO UPDATE SET
             thread_id = excluded.thread_id,
             project_path = excluded.project_path,
             expires_at_ms = excluded.expires_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          binding.threadId,
          binding.projectPath,
          binding.expiresAtMs,
          binding.updatedAtMs,
        );
    });
  }

  getBinding(nowMs: number): Binding | null {
    const row = this.#database
      .prepare(
        `SELECT thread_id, project_path, expires_at_ms, updated_at_ms
         FROM bindings WHERE singleton = 1 AND expires_at_ms > ?`,
      )
      .get(nowMs) as
      | {
          expires_at_ms: number;
          project_path: string | null;
          thread_id: string;
          updated_at_ms: number;
        }
      | undefined;
    return row
      ? {
          expiresAtMs: row.expires_at_ms,
          projectPath: row.project_path,
          threadId: row.thread_id,
          updatedAtMs: row.updated_at_ms,
        }
      : null;
  }

  putNotificationRoute(route: NotificationRoute): void {
    this.#database
      .prepare(
        `INSERT INTO notification_routes
          (event_id, thread_id, delivered_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           delivered_at_ms = excluded.delivered_at_ms,
           expires_at_ms = excluded.expires_at_ms`,
      )
      .run(
        route.eventId,
        route.threadId,
        route.deliveredAtMs,
        route.expiresAtMs,
      );
  }

  listLiveNotificationRoutes(nowMs: number): NotificationRoute[] {
    const rows = this.#database
      .prepare(
        `SELECT event_id, thread_id, delivered_at_ms, expires_at_ms
         FROM notification_routes
         WHERE expires_at_ms > ?
         ORDER BY delivered_at_ms, event_id`,
      )
      .all(nowMs) as Array<{
      delivered_at_ms: number;
      event_id: string;
      expires_at_ms: number;
      thread_id: string;
    }>;
    return rows.map((row) => ({
      deliveredAtMs: row.delivered_at_ms,
      eventId: row.event_id,
      expiresAtMs: row.expires_at_ms,
      threadId: row.thread_id,
    }));
  }

  observeDesktopTurn(input: Omit<DesktopTurnObservation, "stopSeenAtMs">): boolean {
    return this.#transaction(() => {
      this.#database
        .prepare(
          `DELETE FROM desktop_turn_observation_tombstones
           WHERE expires_at_ms <= ?`,
        )
        .run(input.createdAtMs);
      const result = this.#database
        .prepare(
          `INSERT INTO desktop_turn_observations
            (thread_id, turn_id, created_at_ms, stop_seen_at_ms, schema_version)
           SELECT ?, ?, ?, NULL, 1
           WHERE NOT EXISTS (
             SELECT 1 FROM desktop_turn_observation_tombstones
             WHERE thread_id = ? AND turn_id = ? AND expires_at_ms > ?
           )
           ON CONFLICT (thread_id) DO UPDATE SET
             turn_id = excluded.turn_id,
             created_at_ms = excluded.created_at_ms,
             stop_seen_at_ms = NULL,
             schema_version = 1
           WHERE desktop_turn_observations.created_at_ms <= excluded.created_at_ms`,
        )
        .run(
          input.threadId,
          input.turnId,
          input.createdAtMs,
          input.threadId,
          input.turnId,
          input.createdAtMs,
        );
      return Number(result.changes) === 1;
    });
  }

  getDesktopTurnObservation(threadId: string): DesktopTurnObservation | null {
    const row = this.#database
      .prepare(
        `SELECT thread_id, turn_id, created_at_ms, stop_seen_at_ms
         FROM desktop_turn_observations WHERE thread_id = ?`,
      )
      .get(threadId) as DesktopTurnObservationRow | undefined;
    return row ? desktopTurnObservationFromRow(row) : null;
  }

  markDesktopTurnObservationStopped(input: {
    stoppedAtMs: number;
    threadId: string;
    turnId: string;
  }): boolean {
    const result = this.#database
      .prepare(
        `UPDATE desktop_turn_observations
         SET stop_seen_at_ms = ?
         WHERE thread_id = ? AND turn_id = ?`,
      )
      .run(input.stoppedAtMs, input.threadId, input.turnId);
    return Number(result.changes) === 1;
  }

  listStoppedDesktopTurnObservations(): DesktopTurnObservation[] {
    const rows = this.#database
      .prepare(
        `SELECT thread_id, turn_id, created_at_ms, stop_seen_at_ms
         FROM desktop_turn_observations
         WHERE stop_seen_at_ms IS NOT NULL
         ORDER BY created_at_ms, thread_id`,
      )
      .all() as DesktopTurnObservationRow[];
    return rows.map(desktopTurnObservationFromRow);
  }

  releaseStoppedDesktopTurnObservation(input: {
    threadId: string;
    turnId: string;
  }): boolean {
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT stop_seen_at_ms AS stoppedAtMs
           FROM desktop_turn_observations
           WHERE thread_id = ? AND turn_id = ? AND stop_seen_at_ms IS NOT NULL`,
        )
        .get(input.threadId, input.turnId) as
        | { stoppedAtMs: number }
        | undefined;
      if (!row) return false;
      this.recordDesktopTurnStopTombstone({
        stoppedAtMs: row.stoppedAtMs,
        threadId: input.threadId,
        turnId: input.turnId,
      });
      const result = this.#database
        .prepare(
          `DELETE FROM desktop_turn_observations
           WHERE thread_id = ? AND turn_id = ? AND stop_seen_at_ms IS NOT NULL`,
        )
        .run(input.threadId, input.turnId);
      return Number(result.changes) === 1;
    });
  }

  putPendingDesktopNotification(input: PendingDesktopNotification): void {
    this.#database
      .prepare(
        `INSERT INTO pending_desktop_notifications
          (thread_id, turn_id, completed_at_ms, cwd, terminal_status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, turn_id) DO UPDATE SET
           completed_at_ms = excluded.completed_at_ms,
           cwd = excluded.cwd,
           terminal_status = excluded.terminal_status`,
      )
      .run(
        input.threadId,
        input.turnId,
        input.completedAtMs,
        input.cwd,
        input.status,
      );
  }

  listPendingDesktopNotifications(): PendingDesktopNotification[] {
    const rows = this.#database
      .prepare(
        `SELECT thread_id, turn_id, completed_at_ms, cwd, terminal_status
         FROM pending_desktop_notifications
         ORDER BY completed_at_ms, thread_id, turn_id`,
      )
      .all() as Array<{
        completed_at_ms: number;
        cwd: string | null;
        terminal_status: PendingDesktopNotification["status"];
        thread_id: string;
        turn_id: string;
      }>;
    return rows.map((row) => ({
      completedAtMs: row.completed_at_ms,
      cwd: row.cwd,
      status: row.terminal_status,
      threadId: row.thread_id,
      turnId: row.turn_id,
    }));
  }

  deletePendingDesktopNotification(threadId: string, turnId: string): boolean {
    const result = this.#database
      .prepare(
        `DELETE FROM pending_desktop_notifications
         WHERE thread_id = ? AND turn_id = ?`,
      )
      .run(threadId, turnId);
    return Number(result.changes) === 1;
  }

  recordDesktopTurnStopTombstone(input: {
    stoppedAtMs: number;
    threadId: string;
    turnId: string;
  }): void {
    this.#database
      .prepare(
        `DELETE FROM desktop_turn_observation_tombstones
         WHERE expires_at_ms <= ?`,
      )
      .run(input.stoppedAtMs);
    this.#database
      .prepare(
        `INSERT INTO desktop_turn_observation_tombstones
          (thread_id, turn_id, stopped_at_ms, expires_at_ms, schema_version)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (thread_id, turn_id) DO UPDATE SET
           stopped_at_ms = MAX(stopped_at_ms, excluded.stopped_at_ms),
           expires_at_ms = MAX(expires_at_ms, excluded.expires_at_ms),
           schema_version = 1`,
      )
      .run(
        input.threadId,
        input.turnId,
        input.stoppedAtMs,
        input.stoppedAtMs + DESKTOP_OBSERVATION_TOMBSTONE_TTL_MS,
      );
  }

  pruneExpiredDesktopObservationTombstones(nowMs: number): number {
    const result = this.#database
      .prepare(
        `DELETE FROM desktop_turn_observation_tombstones
         WHERE expires_at_ms <= ?`,
      )
      .run(nowMs);
    return Number(result.changes);
  }

  enqueueQueuedTurn(
    input: Omit<QueuedTurn, "contextToken" | "id"> & {
      contextToken?: string;
    },
  ): QueuedTurn {
    const contextToken = input.contextToken ?? "";
    const result = this.#database
      .prepare(
        `INSERT INTO queued_turns
          (dedupe_key, thread_id, body, created_at_ms, context_token)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(
        input.dedupeKey,
        input.threadId,
        input.body,
        input.createdAtMs,
        contextToken,
      );
    if (Number(result.changes) !== 1) {
      throw new Error("queued turn already exists");
    }
    return { ...input, contextToken, id: Number(result.lastInsertRowid) };
  }

  peekQueuedTurn(threadId: string): QueuedTurn | null {
    const row = this.#database
      .prepare(
        `SELECT id, dedupe_key, thread_id, body, created_at_ms, context_token
         FROM queued_turns WHERE thread_id = ? ORDER BY id LIMIT 1`,
      )
      .get(threadId) as
      | {
          body: string;
          created_at_ms: number;
          context_token: string;
          dedupe_key: string;
          id: number;
          thread_id: string;
        }
      | undefined;
    return row
      ? {
          body: row.body,
          contextToken: row.context_token,
          createdAtMs: row.created_at_ms,
          dedupeKey: row.dedupe_key,
          id: row.id,
          threadId: row.thread_id,
        }
      : null;
  }

  listQueuedTurns(): QueuedTurn[] {
    const rows = this.#database
      .prepare(
        `SELECT id, dedupe_key, thread_id, body, created_at_ms, context_token
         FROM queued_turns ORDER BY id`,
      )
      .all() as QueuedTurnRow[];
    return rows.map(queuedTurnFromRow);
  }

  deleteQueuedTurn(id: number): boolean {
    const result = this.#database
      .prepare("DELETE FROM queued_turns WHERE id = ?")
      .run(id);
    return Number(result.changes) === 1;
  }

  countQueuedTurns(): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM queued_turns")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listActiveTurnDedupeKeys(): string[] {
    const keys = new Set<string>();
    for (const inbound of this.listInboundMessages()) {
      if (inbound.body === null) continue;
      keys.add(
        `${inbound.accountId}/${inbound.controllerUserId}/${inbound.messageId}`,
      );
    }
    for (const queued of this.listQueuedTurns()) keys.add(queued.dedupeKey);
    for (const dispatch of this.listUnresolvedDispatchIntents()) {
      keys.add(dispatch.dedupeKey);
    }
    return [...keys].sort();
  }

  hasScheduledDedupeKey(dedupeKey: string): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1 AS scheduled
         WHERE EXISTS (
           SELECT 1 FROM queued_turns WHERE dedupe_key = ?
         ) OR EXISTS (
           SELECT 1 FROM dispatch_intents WHERE dedupe_key = ?
         )`,
      )
      .get(dedupeKey, dedupeKey) as { scheduled: number } | undefined;
    return row?.scheduled === 1;
  }

  countActiveDispatches(): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM dispatch_intents
         WHERE status IN ('pending', 'accepted', 'unknown')
           AND completed_at_ms IS NULL`,
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  hasActiveDispatchForThread(threadId: string): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1 AS active FROM dispatch_intents
          WHERE thread_id = ?
            AND status IN ('pending', 'accepted', 'unknown')
            AND completed_at_ms IS NULL
         LIMIT 1`,
      )
      .get(threadId) as { active: number } | undefined;
    return row?.active === 1;
  }

  promoteQueuedTurn(input: {
    contextToken?: string;
    createdAtMs: number;
    maxActiveDispatches?: number;
    operationId: string;
    queuedTurnId: number;
  }): DispatchIntent | null {
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT id, dedupe_key, thread_id, body, created_at_ms, context_token
           FROM queued_turns WHERE id = ?`,
        )
        .get(input.queuedTurnId) as QueuedTurnRow | undefined;
      if (!row) return null;
      const queued = queuedTurnFromRow(row);
      if (
        this.countActiveDispatches() >=
          (input.maxActiveDispatches ?? Number.MAX_SAFE_INTEGER) ||
        this.hasActiveDispatchForThread(queued.threadId) ||
        this.peekQueuedTurn(queued.threadId)?.id !== queued.id
      ) {
        return null;
      }
      const dispatch = this.createDispatchIntent({
        body: queued.body,
        contextToken: input.contextToken ?? queued.contextToken,
        createdAtMs: input.createdAtMs,
        dedupeKey: queued.dedupeKey,
        operationId: input.operationId,
        threadId: queued.threadId,
      });
      const deleted = this.deleteQueuedTurn(queued.id);
      if (!deleted) throw new Error("queued turn promotion lost ownership");
      return dispatch;
    });
  }

  createDispatchIntent(
    input: Pick<
      DispatchIntent,
      | "body"
      | "createdAtMs"
      | "dedupeKey"
      | "operationId"
      | "threadId"
    > & { contextToken?: string },
  ): DispatchIntent {
    if (input.body === null) throw new Error("pending dispatch requires a body");
    this.#database
      .prepare(
        `INSERT INTO dispatch_intents
          (operation_id, dedupe_key, thread_id, body, status, turn_id,
           created_at_ms, updated_at_ms, context_token, completed_at_ms)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL)`,
      )
      .run(
        input.operationId,
        input.dedupeKey,
        input.threadId,
        input.body,
        input.createdAtMs,
        input.createdAtMs,
        input.contextToken ?? "",
      );
    return this.#requireDispatchIntent(input.operationId);
  }

  tryCreateDispatchIntent(
    input: Pick<
      DispatchIntent,
      | "body"
      | "createdAtMs"
      | "dedupeKey"
      | "operationId"
      | "threadId"
    > & { contextToken?: string; maxActiveDispatches: number },
  ): DispatchIntent | null {
    return this.#transaction(() => {
      if (
        this.countActiveDispatches() >= input.maxActiveDispatches ||
        this.hasActiveDispatchForThread(input.threadId) ||
        this.peekQueuedTurn(input.threadId) !== null
      ) {
        return null;
      }
      return this.createDispatchIntent(input);
    });
  }

  rejectPendingDispatchWithOutbox(input: {
    operationId: string;
    outbox: PendingOutboxInput;
  }): OutboxItem {
    return this.#transaction(() => {
      const current = this.#requireDispatchIntent(input.operationId);
      if (current.status !== "pending" || current.completedAtMs !== null) {
        throw new Error("only a pending dispatch can be rejected");
      }
      const outbox = this.enqueueOutbox(input.outbox);
      const deleted = this.#database
        .prepare(
          `DELETE FROM dispatch_intents
           WHERE operation_id = ? AND status = 'pending'
             AND completed_at_ms IS NULL`,
        )
        .run(input.operationId);
      if (Number(deleted.changes) !== 1) {
        throw new Error("pending dispatch rejection lost ownership");
      }
      return outbox;
    });
  }

  getDispatchIntent(operationId: string): DispatchIntent | null {
    const row = this.#database
      .prepare(
        `SELECT operation_id, dedupe_key, thread_id, body, status, turn_id,
                created_at_ms, updated_at_ms, context_token, completed_at_ms
         FROM dispatch_intents WHERE operation_id = ?`,
      )
      .get(operationId) as DispatchIntentRow | undefined;
    return row ? dispatchIntentFromRow(row) : null;
  }

  getDispatchIntentByTurnId(turnId: string): DispatchIntent | null {
    const row = this.#database
      .prepare(
        `SELECT operation_id, dedupe_key, thread_id, body, status, turn_id,
                created_at_ms, updated_at_ms, context_token, completed_at_ms
         FROM dispatch_intents WHERE turn_id = ?`,
      )
      .get(turnId) as DispatchIntentRow | undefined;
    return row ? dispatchIntentFromRow(row) : null;
  }

  getDispatchIntentByDedupeKey(dedupeKey: string): DispatchIntent | null {
    const row = this.#database
      .prepare(
        `SELECT operation_id, dedupe_key, thread_id, body, status, turn_id,
                created_at_ms, updated_at_ms, context_token, completed_at_ms
         FROM dispatch_intents WHERE dedupe_key = ?`,
      )
      .get(dedupeKey) as DispatchIntentRow | undefined;
    return row ? dispatchIntentFromRow(row) : null;
  }

  listUnresolvedDispatchIntents(): DispatchIntent[] {
    const rows = this.#database
      .prepare(
        `SELECT operation_id, dedupe_key, thread_id, body, status, turn_id,
                created_at_ms, updated_at_ms, context_token, completed_at_ms
         FROM dispatch_intents
         WHERE completed_at_ms IS NULL
         ORDER BY created_at_ms, operation_id`,
      )
      .all() as DispatchIntentRow[];
    return rows.map(dispatchIntentFromRow);
  }

  markDispatchAccepted(
    operationId: string,
    turnId: string,
    updatedAtMs: number,
  ): DispatchIntent {
    return this.#transaction(() => {
      const current = this.#requireDispatchIntent(operationId);
      if (current.status === "accepted") {
        if (current.turnId !== turnId) {
          throw new Error("dispatch is already accepted by another turn");
        }
        return current;
      }
      if (current.status === "unknown") {
        throw new Error("dispatch outcome is already unknown");
      }
      this.#database
        .prepare(
          `UPDATE dispatch_intents
           SET status = 'accepted', turn_id = ?, body = NULL, updated_at_ms = ?
           WHERE operation_id = ? AND status = 'pending'`,
        )
        .run(turnId, updatedAtMs, operationId);
      return this.#requireDispatchIntent(operationId);
    });
  }

  markDispatchUnknown(
    operationId: string,
    updatedAtMs: number,
    turnId?: string,
  ): DispatchIntent {
    return this.#transaction(() => {
      const current = this.#requireDispatchIntent(operationId);
      if (current.status === "accepted") {
        throw new Error("dispatch is already accepted");
      }
      if (current.status === "unknown") {
        if (turnId && current.turnId && current.turnId !== turnId) {
          throw new Error("dispatch outcome is linked to another turn");
        }
        if (turnId && current.turnId === null) {
          this.#database
            .prepare(
              `UPDATE dispatch_intents
               SET turn_id = ?, updated_at_ms = ?
               WHERE operation_id = ? AND status = 'unknown' AND turn_id IS NULL`,
            )
            .run(turnId, Math.max(updatedAtMs, current.updatedAtMs), operationId);
        }
        return this.#requireDispatchIntent(operationId);
      }
      this.#database
        .prepare(
          `UPDATE dispatch_intents
           SET status = 'unknown', body = NULL, turn_id = ?, updated_at_ms = ?
           WHERE operation_id = ? AND status = 'pending'`,
        )
        .run(turnId ?? null, updatedAtMs, operationId);
      return this.#requireDispatchIntent(operationId);
    });
  }

  resolveUnknownDispatch(
    operationId: string,
    resolvedAtMs: number,
  ): DispatchIntent {
    return this.#transaction(() => {
      const current = this.#requireDispatchIntent(operationId);
      if (current.status !== "unknown") {
        throw new Error("only an unknown dispatch can be resolved");
      }
      if (current.completedAtMs !== null) return current;
      this.#database
        .prepare(
          `UPDATE dispatch_intents
           SET completed_at_ms = ?, updated_at_ms = ?
           WHERE operation_id = ? AND status = 'unknown'
             AND completed_at_ms IS NULL`,
        )
        .run(resolvedAtMs, resolvedAtMs, operationId);
      return this.#requireDispatchIntent(operationId);
    });
  }

  markPendingDispatchesUnknown(updatedAtMs: number): number {
    const result = this.#database
      .prepare(
        `UPDATE dispatch_intents
         SET status = 'unknown', body = NULL, updated_at_ms = ?
         WHERE status = 'pending'`,
      )
      .run(updatedAtMs);
    return Number(result.changes);
  }

  markDispatchCompleted(
    operationId: string,
    turnId: string,
    completedAtMs: number,
  ): DispatchIntent {
    return this.#transaction(() => {
      const current = this.#requireDispatchIntent(operationId);
      if (current.status !== "accepted" || current.turnId !== turnId) {
        throw new Error("only the accepted turn can complete a dispatch");
      }
      if (current.completedAtMs !== null) return current;
      this.#database
        .prepare(
          `UPDATE dispatch_intents
           SET completed_at_ms = ?, updated_at_ms = ?
           WHERE operation_id = ? AND status = 'accepted'
             AND turn_id = ? AND completed_at_ms IS NULL`,
        )
        .run(completedAtMs, completedAtMs, operationId, turnId);
      return this.#requireDispatchIntent(operationId);
    });
  }

  completeDispatchWithOutbox(input: {
    completedAtMs: number;
    operationId: string;
    outbox: readonly PendingOutboxInput[];
    turnId: string;
  }): { dispatch: DispatchIntent; outbox: OutboxItem[] } {
    if (input.outbox.length === 0 || input.outbox.length > 3) {
      throw new Error("final reply requires one to three outbox items");
    }
    return this.#transaction(() => {
      const current = this.#requireDispatchIntent(input.operationId);
      if (current.status !== "accepted" || current.turnId !== input.turnId) {
        throw new Error("only the accepted turn can complete a dispatch");
      }
      const outbox = input.outbox.map((item) => this.enqueueOutbox(item));
      if (current.completedAtMs === null) {
        this.#database
          .prepare(
            `UPDATE dispatch_intents
             SET completed_at_ms = ?, updated_at_ms = ?
             WHERE operation_id = ? AND status = 'accepted'
               AND turn_id = ? AND completed_at_ms IS NULL`,
          )
          .run(
            input.completedAtMs,
            input.completedAtMs,
            input.operationId,
            input.turnId,
          );
      }
      return {
        dispatch: this.#requireDispatchIntent(input.operationId),
        outbox,
      };
    });
  }

  enqueueOutbox(
    input: PendingOutboxInput,
  ): OutboxItem {
    if (input.body === null) throw new Error("pending outbox item requires a body");
    const bodyHash = sha256(input.body);
    const current = this.#getOutboxRow(input.clientId);
    if (current) {
      if (
        current.body_sha256 !== bodyHash ||
        current.target_user_id !== input.targetUserId ||
        current.context_token !== input.contextToken
      ) {
        throw new Error("client id collision");
      }
      return outboxItemFromRow(current);
    }

    this.#database
      .prepare(
        `INSERT INTO outbox
          (client_id, target_user_id, context_token, body, body_sha256,
           status, created_at_ms, confirmed_at_ms)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(
        input.clientId,
        input.targetUserId,
        input.contextToken,
        input.body,
        bodyHash,
        input.createdAtMs,
      );
    return this.#requireOutbox(input.clientId);
  }

  enqueueOutboxBatch(inputs: readonly PendingOutboxInput[]): OutboxItem[] {
    return this.#transaction(() =>
      inputs.map((input) => this.enqueueOutbox(input)),
    );
  }

  replacePendingOutboxBody(clientId: string, body: string): OutboxItem {
    if (body.length === 0) throw new Error("pending outbox item requires a body");
    const current = this.#requireOutbox(clientId);
    if (current.status !== "pending") {
      throw new Error("only pending outbox body can be replaced");
    }
    this.#database
      .prepare(
        `UPDATE outbox SET body = ?, body_sha256 = ?
         WHERE client_id = ? AND status = 'pending'`,
      )
      .run(body, sha256(body), clientId);
    return this.#requireOutbox(clientId);
  }

  getOutbox(clientId: string): OutboxItem | null {
    const row = this.#getOutboxRow(clientId);
    return row ? outboxItemFromRow(row) : null;
  }

  listPendingOutbox(): OutboxItem[] {
    const rows = this.#database
      .prepare(
        `SELECT client_id, target_user_id, context_token, body, body_sha256,
                status, created_at_ms, confirmed_at_ms
         FROM outbox WHERE status = 'pending'
         ORDER BY created_at_ms, client_id`,
      )
      .all() as OutboxRow[];
    return rows.map(outboxItemFromRow);
  }

  confirmOutbox(
    clientId: string,
    confirmedAtMs: number,
    notificationRoute?: NotificationRoute,
  ): OutboxItem {
    return this.#transaction(() => {
      const current = this.#requireOutbox(clientId);
      if (current.status === "confirmed") return current;
      this.#database
        .prepare(
          `UPDATE outbox
           SET status = 'confirmed', body = NULL, confirmed_at_ms = ?
           WHERE client_id = ? AND status = 'pending'`,
        )
        .run(confirmedAtMs, clientId);
      if (notificationRoute) this.putNotificationRoute(notificationRoute);
      const bridgeTurnId = bridgeFinalTurnId(clientId);
      if (bridgeTurnId) {
        this.#database
          .prepare(
            `UPDATE bindings
             SET expires_at_ms = ?, updated_at_ms = ?
             WHERE singleton = 1
               AND EXISTS (
                 SELECT 1
                 FROM dispatch_intents
                 WHERE turn_id = ?
                   AND thread_id = bindings.thread_id
                   AND status = 'accepted'
                   AND completed_at_ms IS NOT NULL
               )`,
          )
          .run(
            confirmedAtMs + 30 * 60 * 1_000,
            confirmedAtMs,
            bridgeTurnId,
          );
      }
      return this.#requireOutbox(clientId);
    });
  }

  deletePendingOutbox(clientId: string): boolean {
    const result = this.#database
      .prepare("DELETE FROM outbox WHERE client_id = ? AND status = 'pending'")
      .run(clientId);
    return Number(result.changes) === 1;
  }

  enableArbitration(instanceId: string): BridgeRuntime {
    if (!instanceId) throw new Error("instance id is required");
    return this.#transaction(() => {
      const current = this.getBridgeRuntime();
      if (current?.arbitrationEnabled && current.instanceId === instanceId) return current;
      this.#database
        .prepare(
          `INSERT INTO bridge_runtime
            (singleton, arbitration_enabled, instance_id)
           VALUES (1, 1, ?)
           ON CONFLICT (singleton) DO UPDATE SET
             arbitration_enabled = 1,
             instance_id = excluded.instance_id`,
        )
        .run(instanceId);
      return this.#requireBridgeRuntime();
    });
  }

  disableArbitration(instanceId: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE bridge_runtime SET arbitration_enabled = 0
         WHERE singleton = 1 AND arbitration_enabled = 1 AND instance_id = ?`,
      )
      .run(instanceId);
    return Number(result.changes) === 1;
  }

  getBridgeRuntime(): BridgeRuntime | null {
    const row = this.#database
      .prepare(
        `SELECT arbitration_enabled, instance_id
         FROM bridge_runtime WHERE singleton = 1`,
      )
      .get() as
      | { arbitration_enabled: number; instance_id: string }
      | undefined;
    return row
      ? {
          arbitrationEnabled: row.arbitration_enabled === 1,
          instanceId: row.instance_id,
        }
      : null;
  }

  getBridgeSettings(): BridgeSettings {
    const row = this.#database
      .prepare(
        `SELECT main_thread_id, selected_project_path
         FROM bridge_settings WHERE singleton = 1`,
      )
      .get() as
      | { main_thread_id: string | null; selected_project_path: string | null }
      | undefined;
    if (!row) throw new Error("bridge settings are missing");
    return {
      mainThreadId: row.main_thread_id,
      selectedProjectPath: row.selected_project_path,
    };
  }

  listGuardedThreadIds(nowMs: number): string[] {
    return (
      this.#database
        .prepare(
          `SELECT thread_id FROM (
             SELECT main_thread_id AS thread_id
             FROM bridge_settings
             WHERE singleton = 1 AND main_thread_id IS NOT NULL
             UNION
             SELECT thread_id FROM bindings WHERE expires_at_ms > ?
             UNION
             SELECT thread_id FROM notification_routes WHERE expires_at_ms > ?
             UNION
             SELECT thread_id FROM queued_turns
             UNION
             SELECT thread_id FROM dispatch_intents
             WHERE completed_at_ms IS NULL
           )
           ORDER BY thread_id`,
        )
        .all(nowMs, nowMs) as Array<{ thread_id: string }>
    ).map(({ thread_id }) => thread_id);
  }

  setMainThreadId(threadId: string): void {
    if (!threadId) throw new Error("main thread id is required");
    this.#database
      .prepare(
        `UPDATE bridge_settings SET main_thread_id = ? WHERE singleton = 1`,
      )
      .run(threadId);
  }

  setSelectedProjectPath(projectPath: string | null): void {
    this.#database
      .prepare(
        `UPDATE bridge_settings SET selected_project_path = ? WHERE singleton = 1`,
      )
      .run(projectPath);
  }

  setThreadPermissionProfile(profile: ThreadPermissionProfile): void {
    if (!profile.threadId) throw new Error("thread id is required");
    if (!profile.profileId) throw new Error("permission profile id is required");
    this.#database
      .prepare(
        `INSERT INTO thread_permission_profiles
          (thread_id, profile_id, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           profile_id = excluded.profile_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(profile.threadId, profile.profileId, profile.updatedAtMs);
  }

  getThreadPermissionProfile(threadId: string): ThreadPermissionProfile | null {
    const row = this.#database
      .prepare(
        `SELECT thread_id, profile_id, updated_at_ms
         FROM thread_permission_profiles WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { profile_id: string; thread_id: string; updated_at_ms: number }
      | undefined;
    return row
      ? {
          profileId: row.profile_id,
          threadId: row.thread_id,
          updatedAtMs: row.updated_at_ms,
        }
      : null;
  }

  selectProjectForNavigation(projectPath: string): void {
    if (!projectPath) throw new Error("project path is required");
    this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE bridge_settings SET selected_project_path = ? WHERE singleton = 1`,
        )
        .run(projectPath);
      this.#database.exec(
        "DELETE FROM bindings; DELETE FROM notification_routes; DELETE FROM list_snapshots WHERE kind = 'sessions';",
      );
    });
  }

  clearNavigationRoutes(): void {
    this.#transaction(() => {
      this.#database.exec("DELETE FROM bindings; DELETE FROM notification_routes;");
    });
  }

  replaceProjectSnapshot(snapshot: ProjectListSnapshot): void {
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM list_snapshots WHERE kind = 'projects'").run();
      this.#database
        .prepare(
          `INSERT INTO list_snapshots
            (kind, created_at_ms, expires_at_ms, project_path, page, archived, has_next)
           VALUES ('projects', ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(snapshot.createdAtMs, snapshot.expiresAtMs);
      const insert = this.#database.prepare(
        `INSERT INTO list_snapshot_items
          (kind, item_index, project_path, thread_id, archived)
         VALUES ('projects', ?, ?, NULL, NULL)`,
      );
      snapshot.projects.forEach((projectPath, index) => {
        insert.run(index + 1, projectPath);
      });
    });
  }

  getProjectSnapshot(nowMs: number): ProjectListSnapshot | null {
    const row = this.#database
      .prepare(
        `SELECT created_at_ms, expires_at_ms
         FROM list_snapshots
         WHERE kind = 'projects' AND expires_at_ms > ?`,
      )
      .get(nowMs) as
      | { created_at_ms: number; expires_at_ms: number }
      | undefined;
    if (!row) return null;
    const items = this.#database
      .prepare(
        `SELECT project_path FROM list_snapshot_items
         WHERE kind = 'projects' ORDER BY item_index`,
      )
      .all() as Array<{ project_path: string }>;
    return {
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      projects: items.map(({ project_path }) => project_path),
    };
  }

  replaceSessionSnapshot(snapshot: SessionListSnapshot): void {
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM list_snapshots WHERE kind = 'sessions'").run();
      this.#database
        .prepare(
          `INSERT INTO list_snapshots
            (kind, created_at_ms, expires_at_ms, project_path, page, archived, has_next)
           VALUES ('sessions', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.createdAtMs,
          snapshot.expiresAtMs,
          snapshot.projectPath,
          snapshot.page,
          snapshot.archived ? 1 : 0,
          snapshot.hasNext ? 1 : 0,
        );
      const insert = this.#database.prepare(
        `INSERT INTO list_snapshot_items
          (kind, item_index, project_path, thread_id, archived)
         VALUES ('sessions', ?, ?, ?, ?)`,
      );
      snapshot.threads.forEach((thread, index) => {
        insert.run(
          index + 1,
          thread.projectPath,
          thread.threadId,
          thread.archived ? 1 : 0,
        );
      });
    });
  }

  getSessionSnapshot(nowMs: number): SessionListSnapshot | null {
    const row = this.#database
      .prepare(
        `SELECT created_at_ms, expires_at_ms, project_path, page, archived, has_next
         FROM list_snapshots
         WHERE kind = 'sessions' AND expires_at_ms > ?`,
      )
      .get(nowMs) as
      | {
          archived: number;
          created_at_ms: number;
          expires_at_ms: number;
          has_next: number;
          page: number;
          project_path: string | null;
        }
      | undefined;
    if (!row) return null;
    const items = this.#database
      .prepare(
        `SELECT project_path, thread_id, archived
         FROM list_snapshot_items
         WHERE kind = 'sessions' ORDER BY item_index`,
      )
      .all() as Array<{
      archived: number;
      project_path: string | null;
      thread_id: string;
    }>;
    return {
      archived: row.archived === 1,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      hasNext: row.has_next === 1,
      page: row.page,
      projectPath: row.project_path,
      threads: items.map((item) => ({
        archived: item.archived === 1,
        projectPath: item.project_path,
        threadId: item.thread_id,
      })),
    };
  }

  clearSessionSnapshot(): void {
    this.#database.prepare("DELETE FROM list_snapshots WHERE kind = 'sessions'").run();
  }

  saveILinkSession(session: ILinkSession): void {
    if (!this.isController(session.botId, session.controllerUserId)) {
      throw new Error("controller mismatch");
    }
    if (session.protectedToken.length === 0) {
      throw new Error("protected token is required");
    }
    this.#database
      .prepare(
        `INSERT INTO ilink_session
          (singleton, bot_id, controller_user_id, base_url, protected_token)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           bot_id = excluded.bot_id,
           controller_user_id = excluded.controller_user_id,
           base_url = excluded.base_url,
           protected_token = excluded.protected_token`,
      )
      .run(
        session.botId,
        session.controllerUserId,
        session.baseUrl,
        session.protectedToken,
      );
  }

  getILinkSession(): ILinkSession | null {
    const row = this.#database
      .prepare(
        `SELECT bot_id, controller_user_id, base_url, protected_token
         FROM ilink_session WHERE singleton = 1`,
      )
      .get() as
      | {
          base_url: string;
          bot_id: string;
          controller_user_id: string;
          protected_token: string;
        }
      | undefined;
    return row
      ? {
          baseUrl: row.base_url,
          botId: row.bot_id,
          controllerUserId: row.controller_user_id,
          protectedToken: row.protected_token,
        }
      : null;
  }

  #migrate(): void {
    const current = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    let version = current?.user_version ?? 0;
    if (version < 0 || version > 8) {
      throw new Error(`unsupported schema version ${String(version)}`);
    }
    const migrations = [
      "./migrations/001-initial.sql",
      "./migrations/002-list-snapshots.sql",
      "./migrations/003-turn-scheduler.sql",
      "./migrations/004-desktop-observations.sql",
      "./migrations/005-desktop-observation-tombstones.sql",
      "./migrations/006-durable-turn-input.sql",
      "./migrations/007-thread-permission-profiles.sql",
      "./migrations/008-pending-desktop-notifications.sql",
    ];
    while (version < migrations.length) {
      const nextVersion = version + 1;
      const resource = migrations[version];
      if (!resource) throw new Error(`missing migration ${String(nextVersion)}`);
      const sql = readFileSync(new URL(resource, import.meta.url), "utf8");
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(sql);
        this.#database.exec(`PRAGMA user_version = ${String(nextVersion)}`);
        this.#database.exec("COMMIT");
        version = nextVersion;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #requireDispatchIntent(operationId: string): DispatchIntent {
    const intent = this.getDispatchIntent(operationId);
    if (!intent) throw new Error("dispatch intent not found");
    return intent;
  }

  #getOutboxRow(clientId: string): OutboxRow | undefined {
    return this.#database
      .prepare(
        `SELECT client_id, target_user_id, context_token, body, body_sha256,
                status, created_at_ms, confirmed_at_ms
         FROM outbox WHERE client_id = ?`,
      )
      .get(clientId) as OutboxRow | undefined;
  }

  #requireOutbox(clientId: string): OutboxItem {
    const item = this.getOutbox(clientId);
    if (!item) throw new Error("outbox item not found");
    return item;
  }

  #requireBridgeRuntime(): BridgeRuntime {
    const runtime = this.getBridgeRuntime();
    if (!runtime) throw new Error("Bridge runtime not found");
    return runtime;
  }
}

type DispatchIntentRow = {
  body: string | null;
  completed_at_ms: number | null;
  context_token: string;
  created_at_ms: number;
  dedupe_key: string;
  operation_id: string;
  status: "accepted" | "pending" | "unknown";
  thread_id: string;
  turn_id: string | null;
  updated_at_ms: number;
};

type DesktopTurnObservationRow = {
  created_at_ms: number;
  stop_seen_at_ms: number | null;
  thread_id: string;
  turn_id: string;
};

function desktopTurnObservationFromRow(
  row: DesktopTurnObservationRow,
): DesktopTurnObservation {
  return {
    createdAtMs: row.created_at_ms,
    stopSeenAtMs: row.stop_seen_at_ms,
    threadId: row.thread_id,
    turnId: row.turn_id,
  };
}

type QueuedTurnRow = {
  body: string;
  context_token: string;
  created_at_ms: number;
  dedupe_key: string;
  id: number;
  thread_id: string;
};

function queuedTurnFromRow(row: QueuedTurnRow): QueuedTurn {
  return {
    body: row.body,
    contextToken: row.context_token,
    createdAtMs: row.created_at_ms,
    dedupeKey: row.dedupe_key,
    id: row.id,
    threadId: row.thread_id,
  };
}

function dispatchIntentFromRow(row: DispatchIntentRow): DispatchIntent {
  return {
    body: row.body,
    completedAtMs: row.completed_at_ms,
    contextToken: row.context_token,
    createdAtMs: row.created_at_ms,
    dedupeKey: row.dedupe_key,
    operationId: row.operation_id,
    status: row.status,
    threadId: row.thread_id,
    turnId: row.turn_id,
    updatedAtMs: row.updated_at_ms,
  };
}

type OutboxRow = {
  body: string | null;
  body_sha256: string;
  client_id: string;
  confirmed_at_ms: number | null;
  context_token: string;
  created_at_ms: number;
  status: "confirmed" | "pending";
  target_user_id: string;
};

function outboxItemFromRow(row: OutboxRow): OutboxItem {
  return {
    body: row.body,
    clientId: row.client_id,
    confirmedAtMs: row.confirmed_at_ms,
    contextToken: row.context_token,
    createdAtMs: row.created_at_ms,
    status: row.status,
    targetUserId: row.target_user_id,
  };
}

function bridgeFinalTurnId(clientId: string): string | null {
  const match = /^codex-ilink:([^:]+):final(?:$|:part:[1-3]$)/u.exec(clientId);
  return match?.[1] ?? null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
