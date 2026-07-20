import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ReleaseTurnLeaseInput } from "../coordination/turn-lease.ts";
import { outboundMediaPathKey } from "../media/outbound-media.ts";
import {
  AWAY_TIMEOUT_MINUTES_RANGE,
  DEFAULT_AWAY_TIMEOUT_MINUTES,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_APPROVALS_REVIEWER,
  DEFAULT_PERMISSION_PROFILE,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  isInMinuteRange,
  SESSION_TIMEOUT_MINUTES_RANGE,
  type UserTimingSettings,
  type DefaultApprovalPolicy,
  type DefaultApprovalsReviewer,
  type DefaultPermissionProfile,
  type DefaultThreadPermissionSettings,
} from "../domain/user-settings.ts";

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

export type ExpiredBinding = Binding & {
  expiryNotifiedAtMs: number | null;
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
const INBOUND_DEDUPE_QUERY_CHUNK_SIZE = 500;
const TRANSPORT_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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

export type InboundDispatchAdmission =
  | { dispatch: DispatchIntent; kind: "created" }
  | { kind: "queued"; queued: QueuedTurn }
  | { kind: "terminal" };

export type QueuedTurnPromotion =
  | { dispatch: DispatchIntent; kind: "promoted" }
  | { kind: "blocked" }
  | { kind: "stale" };

export type OutboundAttachmentIntent = {
  callId: string;
  createdAtMs: number;
  kind: "file" | "image" | "video";
  name: string;
  operationId: string;
  path: string;
  pathKey: string;
  snapshotProvenance: "legacy" | "staged-v1";
  threadId: string;
  turnId: string;
};

export class OutboundAttachmentIntentError extends Error {
  readonly code: "CALL_ID_COLLISION" | "TOO_MANY_ATTACHMENTS";

  constructor(code: OutboundAttachmentIntentError["code"]) {
    super(`E_OUTBOUND_ATTACHMENT_${code}`);
    this.name = "OutboundAttachmentIntentError";
    this.code = code;
  }
}

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

export type BridgeSettings = UserTimingSettings & {
  mainThreadId: string | null;
  selectedProjectPath: string | null;
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
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
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

  pruneExpiredTransportState(nowMs: number): {
    completedDispatchIntents: number;
    confirmedOutbox: number;
    expiredNotificationRoutes: number;
    terminalInboundMessages: number;
  } {
    const cutoffMs = nowMs - TRANSPORT_METADATA_RETENTION_MS;
    return this.#transaction(() => {
      const expiredNotificationRoutes = this.#database
        .prepare(
          `DELETE FROM notification_routes
           WHERE expires_at_ms <= ?`,
        )
        .run(nowMs);
      const confirmedOutbox = this.#database
        .prepare(
          `DELETE FROM outbox
           WHERE status = 'confirmed' AND confirmed_at_ms <= ?`,
        )
        .run(cutoffMs);
      const completedDispatchIntents = this.#database
        .prepare(
          `DELETE FROM dispatch_intents
           WHERE completed_at_ms <= ?
             AND NOT EXISTS (
               SELECT 1 FROM outbound_attachment_intents
               WHERE outbound_attachment_intents.operation_id =
                 dispatch_intents.operation_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM outbox
               WHERE outbox.client_id IN (
                 'codex-ilink:' || dispatch_intents.turn_id || ':final',
                 'codex-ilink:' || dispatch_intents.turn_id || ':final:part:1',
                 'codex-ilink:' || dispatch_intents.turn_id || ':final:part:2',
                 'codex-ilink:' || dispatch_intents.turn_id || ':final:part:3'
               )
             )`,
        )
        .run(cutoffMs);
      const terminalInboundMessages = this.#database
        .prepare(
          `DELETE FROM inbound_messages
           WHERE body IS NULL AND accepted_at_ms <= ?
             AND NOT EXISTS (
               SELECT 1 FROM queued_turns
               WHERE queued_turns.dedupe_key =
                 inbound_messages.account_id || '/' ||
                 inbound_messages.controller_user_id || '/' ||
                 inbound_messages.message_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM dispatch_intents
               WHERE dispatch_intents.dedupe_key =
                 inbound_messages.account_id || '/' ||
                 inbound_messages.controller_user_id || '/' ||
                 inbound_messages.message_id
             )`,
        )
        .run(cutoffMs);
      return {
        completedDispatchIntents: Number(completedDispatchIntents.changes),
        confirmedOutbox: Number(confirmedOutbox.changes),
        expiredNotificationRoutes: Number(expiredNotificationRoutes.changes),
        terminalInboundMessages: Number(terminalInboundMessages.changes),
      };
    });
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

  replaceILinkBinding(input: {
    controller: Controller;
    session: ILinkSession;
  }): Controller {
    return this.#transaction(() => {
      const current = this.getController();
      if (
        current?.accountId === input.controller.accountId &&
        current.userId === input.controller.userId
      ) {
        this.saveILinkSession(input.session);
        return current;
      }

      if (current) {
        this.#database.exec(`
          DELETE FROM pending_desktop_notifications;
          DELETE FROM outbound_attachment_intents;
          DELETE FROM dispatch_intents;
          DELETE FROM queued_turns;
          DELETE FROM inbound_messages;
          DELETE FROM ilink_state;
          DELETE FROM outbox;
          DELETE FROM notification_routes;
          DELETE FROM bindings;
          DELETE FROM list_snapshots;
          DELETE FROM ilink_session;
          DELETE FROM controller;
        `);
      }

      const controller = this.bindController(input.controller);
      this.saveILinkSession(input.session);
      return controller;
    });
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
          (account_id, controller_user_id, message_id, context_token, body,
           received_at_ms, accepted_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
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
          input.updatedAtMs,
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

  findExistingInboundMessageIds(input: {
    accountId: string;
    candidateMessageIds: readonly string[];
    controllerUserId: string;
  }): Set<string> {
    const candidateMessageIds = [...new Set(input.candidateMessageIds)];
    const existingMessageIds = new Set<string>();
    for (
      let offset = 0;
      offset < candidateMessageIds.length;
      offset += INBOUND_DEDUPE_QUERY_CHUNK_SIZE
    ) {
      const chunk = candidateMessageIds.slice(
        offset,
        offset + INBOUND_DEDUPE_QUERY_CHUNK_SIZE,
      );
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.#database
        .prepare(
          `SELECT message_id FROM inbound_messages
           WHERE account_id = ? AND controller_user_id = ?
             AND message_id IN (${placeholders})`,
        )
        .all(input.accountId, input.controllerUserId, ...chunk) as Array<{
        message_id: string;
      }>;
      for (const { message_id } of rows) existingMessageIds.add(message_id);
    }
    return existingMessageIds;
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

  rejectInboundMessageAndReleaseLeaseWithOutbox(input: {
    accountId: string;
    controllerUserId: string;
    lease: ReleaseTurnLeaseInput;
    messageId: string;
    outbox: PendingOutboxInput;
  }): OutboxItem | null {
    return this.#transaction(() => {
      if (input.lease.owner !== "bridge" || input.lease.turnId !== null) {
        throw new Error("invalid inbound rejection lease identity");
      }
      if (
        !this.#isInboundMessagePending(
          input.accountId,
          input.controllerUserId,
          input.messageId,
        )
      ) {
        // Another process already consumed this inbound. The caller may still
        // hold an obsolete pre-dispatch token, so release only that exact token
        // on a best-effort basis and never disturb its replacement.
        this.#releaseExactTurnLease(input.lease);
        return null;
      }
      if (!this.#releaseExactTurnLease(input.lease)) {
        throw new Error("inbound rejection lost lease ownership");
      }
      if (
        !this.clearInboundBody(
          input.accountId,
          input.controllerUserId,
          input.messageId,
        )
      ) {
        throw new Error("inbound rejection lost ownership");
      }
      return this.enqueueOutbox(input.outbox);
    });
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
           updated_at_ms = excluded.updated_at_ms,
           expiry_notified_at_ms = NULL`,
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
          "UPDATE bridge_settings SET selected_project_path = ? WHERE singleton = 1",
        )
        .run(binding.projectPath);
      this.#database
        .prepare(
          `INSERT INTO bindings
            (singleton, thread_id, project_path, expires_at_ms, updated_at_ms)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (singleton) DO UPDATE SET
             thread_id = excluded.thread_id,
             project_path = excluded.project_path,
             expires_at_ms = excluded.expires_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             expiry_notified_at_ms = NULL`,
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

  getExpiredBindingForReminder(nowMs: number): ExpiredBinding | null {
    const row = this.#database
      .prepare(
        `SELECT thread_id, project_path, expires_at_ms, updated_at_ms,
                expiry_notified_at_ms
         FROM bindings
         WHERE singleton = 1 AND expires_at_ms <= ?
           AND expiry_notified_at_ms IS NULL`,
      )
      .get(nowMs) as
      | {
          expires_at_ms: number;
          expiry_notified_at_ms: number | null;
          project_path: string | null;
          thread_id: string;
          updated_at_ms: number;
        }
      | undefined;
    return row
      ? {
          expiresAtMs: row.expires_at_ms,
          expiryNotifiedAtMs: row.expiry_notified_at_ms,
          projectPath: row.project_path,
          threadId: row.thread_id,
          updatedAtMs: row.updated_at_ms,
        }
      : null;
  }

  markBindingExpiryNotified(
    threadId: string,
    updatedAtMs: number,
    notifiedAtMs: number,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE bindings SET expiry_notified_at_ms = ?
         WHERE singleton = 1 AND thread_id = ? AND updated_at_ms = ?
           AND expiry_notified_at_ms IS NULL AND expires_at_ms <= ?`,
      )
      .run(notifiedAtMs, threadId, updatedAtMs, notifiedAtMs);
    return Number(result.changes) === 1;
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

  enqueueInboundTurn(input: {
    accountId: string;
    body: string;
    contextToken?: string;
    controllerUserId: string;
    createdAtMs: number;
    dedupeKey: string;
    messageId: string;
    threadId: string;
  }): QueuedTurn | null {
    return this.#transaction(() => {
      if (
        !this.#isInboundMessagePending(
          input.accountId,
          input.controllerUserId,
          input.messageId,
        )
      ) {
        return null;
      }
      const queued = this.enqueueQueuedTurn({
        body: input.body,
        ...(input.contextToken === undefined
          ? {}
          : { contextToken: input.contextToken }),
        createdAtMs: input.createdAtMs,
        dedupeKey: input.dedupeKey,
        threadId: input.threadId,
      });
      if (
        !this.clearInboundBody(
          input.accountId,
          input.controllerUserId,
          input.messageId,
        )
      ) {
        throw new Error("inbound queue admission lost ownership");
      }
      return queued;
    });
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

  rejectQueuedTurnWithOutbox(input: {
    dedupeKey: string;
    queuedTurnId: number;
    threadId: string;
    outbox: PendingOutboxInput;
  }): OutboxItem | null {
    return this.#transaction(() => {
      const deleted = this.#database
        .prepare(
          `DELETE FROM queued_turns
           WHERE id = ? AND dedupe_key = ? AND thread_id = ?`,
        )
        .run(input.queuedTurnId, input.dedupeKey, input.threadId);
      if (Number(deleted.changes) !== 1) {
        return null;
      }
      return this.enqueueOutbox(input.outbox);
    });
  }

  rejectQueuedTurnAndReleaseLeaseWithOutbox(input: {
    dedupeKey: string;
    lease: ReleaseTurnLeaseInput;
    outbox: PendingOutboxInput;
    queuedTurnId: number;
    threadId: string;
  }): OutboxItem | null {
    return this.#transaction(() => {
      if (
        input.lease.owner !== "bridge" ||
        input.lease.turnId !== null ||
        input.lease.threadId !== input.threadId
      ) {
        throw new Error("queued rejection has an invalid lease identity");
      }
      const row = this.#database
        .prepare(
          `SELECT 1 AS queued FROM queued_turns
           WHERE id = ? AND dedupe_key = ? AND thread_id = ?`,
        )
        .get(input.queuedTurnId, input.dedupeKey, input.threadId) as
        | { queued: number }
        | undefined;
      const leaseHeld = this.#isExactTurnLeaseHeld(input.lease);
      if (row?.queued !== 1 || !leaseHeld) {
        if (leaseHeld) this.#releaseExactTurnLease(input.lease);
        return null;
      }
      const outbox = this.enqueueOutbox(input.outbox);
      const deleted = this.#database
        .prepare(
          `DELETE FROM queued_turns
           WHERE id = ? AND dedupe_key = ? AND thread_id = ?`,
        )
        .run(input.queuedTurnId, input.dedupeKey, input.threadId);
      if (Number(deleted.changes) !== 1) {
        throw new Error("queued turn rejection lost ownership");
      }
      if (!this.#releaseExactTurnLease(input.lease)) {
        throw new Error("queued turn rejection lost lease ownership");
      }
      return outbox;
    });
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

  promoteQueuedTurnWithLease(input: {
    contextToken?: string;
    createdAtMs: number;
    dedupeKey: string;
    lease: ReleaseTurnLeaseInput;
    maxActiveDispatches?: number;
    operationId: string;
    queuedTurnId: number;
    threadId: string;
  }): QueuedTurnPromotion {
    return this.#transaction(() => {
      if (
        input.lease.owner !== "bridge" ||
        input.lease.turnId !== null ||
        input.lease.threadId !== input.threadId ||
        input.lease.operationId !== input.operationId
      ) {
        throw new Error("queued promotion has an invalid lease identity");
      }
      const row = this.#database
        .prepare(
          `SELECT id, dedupe_key, thread_id, body, created_at_ms, context_token
           FROM queued_turns
           WHERE id = ? AND dedupe_key = ? AND thread_id = ?`,
        )
        .get(input.queuedTurnId, input.dedupeKey, input.threadId) as
        | QueuedTurnRow
        | undefined;
      if (!row) {
        this.#releaseExactTurnLease(input.lease);
        return { kind: "stale" };
      }
      if (!this.#isExactTurnLeaseHeld(input.lease)) {
        return { kind: "stale" };
      }
      const queued = queuedTurnFromRow(row);
      const head = this.peekQueuedTurn(queued.threadId);
      if (
        this.countActiveDispatches() >=
          (input.maxActiveDispatches ?? Number.MAX_SAFE_INTEGER) ||
        this.hasActiveDispatchForThread(queued.threadId) ||
        this.getDesktopTurnObservation(queued.threadId) !== null ||
        head?.id !== queued.id ||
        head.dedupeKey !== queued.dedupeKey
      ) {
        if (!this.#releaseExactTurnLease(input.lease)) {
          throw new Error("blocked queued promotion lost lease ownership");
        }
        return { kind: "blocked" };
      }
      const dispatch = this.createDispatchIntent({
        body: queued.body,
        contextToken: input.contextToken ?? queued.contextToken,
        createdAtMs: input.createdAtMs,
        dedupeKey: queued.dedupeKey,
        operationId: input.operationId,
        threadId: queued.threadId,
      });
      const deleted = this.#database
        .prepare(
          `DELETE FROM queued_turns
           WHERE id = ? AND dedupe_key = ? AND thread_id = ?`,
        )
        .run(queued.id, queued.dedupeKey, queued.threadId);
      if (Number(deleted.changes) !== 1) {
        throw new Error("queued turn promotion lost ownership");
      }
      return { dispatch, kind: "promoted" };
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

  admitInboundDispatchWithLease(
    input: Pick<
      DispatchIntent,
      | "body"
      | "createdAtMs"
      | "dedupeKey"
      | "operationId"
      | "threadId"
    > & {
      accountId: string;
      body: string;
      contextToken?: string;
      controllerUserId: string;
      lease: ReleaseTurnLeaseInput;
      maxActiveDispatches: number;
      messageId: string;
    },
  ): InboundDispatchAdmission {
    return this.#transaction(() => {
      if (
        input.lease.owner !== "bridge" ||
        input.lease.turnId !== null ||
        input.lease.threadId !== input.threadId ||
        input.lease.operationId !== input.operationId
      ) {
        throw new Error("invalid inbound dispatch lease identity");
      }
      if (
        !this.#isInboundMessagePending(
          input.accountId,
          input.controllerUserId,
          input.messageId,
        )
      ) {
        // A stale in-memory worker can arrive after a same-thread replacement
        // has taken over. Exact best-effort release keeps terminal admission a
        // harmless no-op without deleting the replacement lease.
        this.#releaseExactTurnLease(input.lease);
        return { kind: "terminal" };
      }
      if (!this.#isExactTurnLeaseHeld(input.lease)) {
        throw new Error("inbound dispatch admission lost lease ownership");
      }
      if (
        this.countActiveDispatches() >= input.maxActiveDispatches ||
        this.hasActiveDispatchForThread(input.threadId) ||
        this.getDesktopTurnObservation(input.threadId) !== null ||
        this.peekQueuedTurn(input.threadId) !== null
      ) {
        const queued = this.enqueueQueuedTurn({
          body: input.body,
          ...(input.contextToken === undefined
            ? {}
            : { contextToken: input.contextToken }),
          createdAtMs: input.createdAtMs,
          dedupeKey: input.dedupeKey,
          threadId: input.threadId,
        });
        if (
          !this.clearInboundBody(
            input.accountId,
            input.controllerUserId,
            input.messageId,
          )
        ) {
          throw new Error("queued inbound admission lost ownership");
        }
        if (!this.#releaseExactTurnLease(input.lease)) {
          throw new Error("queued inbound admission lost lease ownership");
        }
        return { kind: "queued", queued };
      }
      const dispatch = this.createDispatchIntent(input);
      if (
        !this.clearInboundBody(
          input.accountId,
          input.controllerUserId,
          input.messageId,
        )
      ) {
        throw new Error("inbound dispatch admission lost ownership");
      }
      return { dispatch, kind: "created" };
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
      if (current.completedAtMs !== null) {
        this.#deleteOutboundAttachmentIntents(operationId, turnId);
        return current;
      }
      this.#database
        .prepare(
          `UPDATE dispatch_intents
           SET completed_at_ms = ?, updated_at_ms = ?
           WHERE operation_id = ? AND status = 'accepted'
             AND turn_id = ? AND completed_at_ms IS NULL`,
        )
        .run(completedAtMs, completedAtMs, operationId, turnId);
      this.#deleteOutboundAttachmentIntents(operationId, turnId);
      return this.#requireDispatchIntent(operationId);
    });
  }

  registerOutboundAttachmentIntent(
    input: Omit<OutboundAttachmentIntent, "pathKey" | "snapshotProvenance">,
  ): OutboundAttachmentIntent {
    return this.#transaction(() => {
      const pathKey = outboundMediaPathKey(input.path);
      const dispatch = this.#requireDispatchIntent(input.operationId);
      if (
        dispatch.status !== "accepted" ||
        dispatch.completedAtMs !== null ||
        dispatch.threadId !== input.threadId ||
        dispatch.turnId !== input.turnId
      ) {
        throw new Error("only the accepted turn can register an attachment");
      }
      const existingCall = this.#getOutboundAttachmentIntentByCall(
        input.turnId,
        input.callId,
      );
      if (existingCall) {
        if (
          existingCall.operationId !== input.operationId ||
          existingCall.threadId !== input.threadId ||
          existingCall.pathKey !== pathKey
        ) {
          throw new OutboundAttachmentIntentError("CALL_ID_COLLISION");
        }
        return existingCall;
      }
      const existingPath = this.#getOutboundAttachmentIntentByPath(
        input.turnId,
        pathKey,
      );
      if (existingPath) return existingPath;
      const row = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM outbound_attachment_intents
           WHERE turn_id = ?`,
        )
        .get(input.turnId) as { count: number } | undefined;
      if ((row?.count ?? 0) >= 2) {
        throw new OutboundAttachmentIntentError("TOO_MANY_ATTACHMENTS");
      }
      this.#database
        .prepare(
          `INSERT INTO outbound_attachment_intents
            (operation_id, thread_id, turn_id, call_id, path, path_key,
             name, kind, created_at_ms, snapshot_provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged-v1')`,
        )
        .run(
          input.operationId,
          input.threadId,
          input.turnId,
          input.callId,
          input.path,
          pathKey,
          input.name,
          input.kind,
          input.createdAtMs,
        );
      return this.#getOutboundAttachmentIntentByCall(
        input.turnId,
        input.callId,
      )!;
    });
  }

  listOutboundAttachmentIntents(turnId: string): OutboundAttachmentIntent[] {
    const rows = this.#database
      .prepare(
        `SELECT operation_id, thread_id, turn_id, call_id, path, path_key,
                 name, kind, created_at_ms, snapshot_provenance
         FROM outbound_attachment_intents
         WHERE turn_id = ?
         ORDER BY created_at_ms, call_id`,
      )
      .all(turnId) as OutboundAttachmentIntentRow[];
    return rows.map(outboundAttachmentIntentFromRow);
  }

  listOutboundAttachmentPathKeys(): string[] {
    const rows = this.#database
      .prepare(
        `SELECT path_key FROM outbound_attachment_intents
         UNION
         SELECT path_key FROM protected_legacy_outbound_paths
         ORDER BY path_key`,
      )
      .all() as Array<{ path_key: string }>;
    return rows.map(({ path_key }) => path_key);
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
      this.#deleteOutboundAttachmentIntents(input.operationId, input.turnId);
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
             SET expires_at_ms = ?, updated_at_ms = ?, expiry_notified_at_ms = NULL
             WHERE singleton = 1
               AND bindings.expires_at_ms > ?
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
            confirmedAtMs +
              this.getBridgeSettings().sessionTimeoutMinutes * 60 * 1_000,
            confirmedAtMs,
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
        `SELECT main_thread_id, selected_project_path,
                session_timeout_minutes, away_timeout_minutes
         FROM bridge_settings WHERE singleton = 1`,
      )
      .get() as
      | {
          away_timeout_minutes: number;
          main_thread_id: string | null;
          selected_project_path: string | null;
          session_timeout_minutes: number;
        }
      | undefined;
    if (!row) throw new Error("bridge settings are missing");
    return {
      awayTimeoutMinutes: row.away_timeout_minutes,
      mainThreadId: row.main_thread_id,
      selectedProjectPath: row.selected_project_path,
      sessionTimeoutMinutes: row.session_timeout_minutes,
    };
  }

  getDefaultThreadPermissionSettings(): DefaultThreadPermissionSettings {
    const row = this.#database
      .prepare(
        `SELECT default_permission_profile, default_approval_policy,
                default_approvals_reviewer
         FROM bridge_settings WHERE singleton = 1`,
      )
      .get() as
      | {
          default_approval_policy: DefaultThreadPermissionSettings["approvalPolicy"];
          default_approvals_reviewer: DefaultThreadPermissionSettings["approvalsReviewer"];
          default_permission_profile: DefaultThreadPermissionSettings["permissions"];
        }
      | undefined;
    if (!row) throw new Error("bridge settings are missing");
    return {
      approvalPolicy: row.default_approval_policy,
      approvalsReviewer: row.default_approvals_reviewer,
      permissions: row.default_permission_profile,
    };
  }

  setDefaultPermissionProfile(profile: DefaultPermissionProfile): void {
    this.#database
      .prepare(
        `UPDATE bridge_settings SET default_permission_profile = ?
         WHERE singleton = 1`,
      )
      .run(profile);
  }

  setDefaultApprovalPolicy(policy: DefaultApprovalPolicy): void {
    this.#database
      .prepare(
        `UPDATE bridge_settings SET default_approval_policy = ?
         WHERE singleton = 1`,
      )
      .run(policy);
  }

  setDefaultApprovalsReviewer(reviewer: DefaultApprovalsReviewer): void {
    this.#database
      .prepare(
        `UPDATE bridge_settings SET default_approvals_reviewer = ?
         WHERE singleton = 1`,
      )
      .run(reviewer);
  }

  setSessionTimeoutMinutes(minutes: number, nowMs = Date.now()): void {
    if (!isInMinuteRange(minutes, SESSION_TIMEOUT_MINUTES_RANGE)) {
      throw new Error("session timeout is outside the supported range");
    }
    this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE bridge_settings SET session_timeout_minutes = ?
           WHERE singleton = 1`,
        )
        .run(minutes);
      this.#database
        .prepare(
          `UPDATE bindings
           SET expires_at_ms = updated_at_ms + ?, expiry_notified_at_ms = NULL
           WHERE singleton = 1 AND expires_at_ms > ?`,
        )
        .run(minutes * 60 * 1_000, nowMs);
    });
  }

  setAwayTimeoutMinutes(minutes: number): void {
    if (!isInMinuteRange(minutes, AWAY_TIMEOUT_MINUTES_RANGE)) {
      throw new Error("away timeout is outside the supported range");
    }
    this.#database
      .prepare(
        `UPDATE bridge_settings SET away_timeout_minutes = ?
         WHERE singleton = 1`,
      )
      .run(minutes);
  }

  resetUserTimingSettings(nowMs = Date.now()): void {
    this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE bridge_settings
           SET session_timeout_minutes = ?, away_timeout_minutes = ?
           WHERE singleton = 1`,
        )
        .run(DEFAULT_SESSION_TIMEOUT_MINUTES, DEFAULT_AWAY_TIMEOUT_MINUTES);
      this.#database
        .prepare(
          `UPDATE bindings
           SET expires_at_ms = updated_at_ms + ?, expiry_notified_at_ms = NULL
           WHERE singleton = 1 AND expires_at_ms > ?`,
        )
        .run(DEFAULT_SESSION_TIMEOUT_MINUTES * 60 * 1_000, nowMs);
    });
  }

  resetUserSettings(nowMs = Date.now()): void {
    this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE bridge_settings
           SET session_timeout_minutes = ?, away_timeout_minutes = ?,
               default_permission_profile = ?, default_approval_policy = ?,
               default_approvals_reviewer = ?
           WHERE singleton = 1`,
        )
        .run(
          DEFAULT_SESSION_TIMEOUT_MINUTES,
          DEFAULT_AWAY_TIMEOUT_MINUTES,
          DEFAULT_PERMISSION_PROFILE,
          DEFAULT_APPROVAL_POLICY,
          DEFAULT_APPROVALS_REVIEWER,
        );
      this.#database
        .prepare(
          `UPDATE bindings
           SET expires_at_ms = updated_at_ms + ?, expiry_notified_at_ms = NULL
           WHERE singleton = 1 AND expires_at_ms > ?`,
        )
        .run(DEFAULT_SESSION_TIMEOUT_MINUTES * 60 * 1_000, nowMs);
    });
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

  clearILinkSession(): void {
    this.#database.prepare("DELETE FROM ilink_session WHERE singleton = 1").run();
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

  returnToMainForNavigation(): void {
    this.#transaction(() => {
      this.#database.exec(
        "UPDATE bridge_settings SET selected_project_path = NULL WHERE singleton = 1; DELETE FROM bindings; DELETE FROM notification_routes; DELETE FROM list_snapshots WHERE kind = 'sessions';",
      );
    });
  }

  replaceMainThreadForNavigation(threadId: string): void {
    if (!threadId) throw new Error("main thread id is required");
    this.#transaction(() => {
      this.#database
        .prepare(
          "UPDATE bridge_settings SET main_thread_id = ?, selected_project_path = NULL WHERE singleton = 1",
        )
        .run(threadId);
      this.#database.exec(
        "DELETE FROM bindings; DELETE FROM notification_routes; DELETE FROM list_snapshots WHERE kind = 'sessions';",
      );
    });
  }

  #isInboundMessagePending(
    accountId: string,
    controllerUserId: string,
    messageId: string,
  ): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1 AS pending FROM inbound_messages
         WHERE account_id = ? AND controller_user_id = ? AND message_id = ?
           AND body IS NOT NULL`,
      )
      .get(accountId, controllerUserId, messageId) as
      | { pending: number }
      | undefined;
    return row?.pending === 1;
  }

  #isExactTurnLeaseHeld(expected: ReleaseTurnLeaseInput): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1 AS held FROM turn_leases
         WHERE thread_id = ?
           AND owner = ?
           AND instance_id = ?
           AND operation_id = ?
           AND turn_id IS ?`,
      )
      .get(
        expected.threadId,
        expected.owner,
        expected.instanceId,
        expected.operationId,
        expected.turnId,
      ) as { held: number } | undefined;
    return row?.held === 1;
  }

  #releaseExactTurnLease(expected: ReleaseTurnLeaseInput): boolean {
    const released = this.#database
      .prepare(
        `DELETE FROM turn_leases
         WHERE thread_id = ?
           AND owner = ?
           AND instance_id = ?
           AND operation_id = ?
           AND turn_id IS ?`,
      )
      .run(
        expected.threadId,
        expected.owner,
        expected.instanceId,
        expected.operationId,
        expected.turnId,
      );
    return Number(released.changes) === 1;
  }

  #migrate(): void {
    const migrations = [
      "./migrations/001-initial.sql",
      "./migrations/002-list-snapshots.sql",
      "./migrations/003-turn-scheduler.sql",
      "./migrations/004-desktop-observations.sql",
      "./migrations/005-desktop-observation-tombstones.sql",
      "./migrations/006-durable-turn-input.sql",
      "./migrations/007-thread-permission-profiles.sql",
      "./migrations/008-pending-desktop-notifications.sql",
      "./migrations/009-outbound-attachment-intents.sql",
      "./migrations/010-user-timing-settings.sql",
      "./migrations/011-thread-permission-settings.sql",
      "./migrations/012-outbound-attachment-provenance.sql",
      "./migrations/013-transport-retention-indexes.sql",
      "./migrations/014-drop-thread-permission-profiles.sql",
      "./migrations/015-default-thread-permissions.sql",
    ];
    const observed = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const observedVersion = observed?.user_version ?? 0;
    if (observedVersion < 0 || observedVersion > migrations.length) {
      throw new Error(`unsupported schema version ${String(observedVersion)}`);
    }
    if (observedVersion === migrations.length) return;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      let version = current?.user_version ?? 0;
      if (version < 0 || version > migrations.length) {
        throw new Error(`unsupported schema version ${String(version)}`);
      }
      while (version < migrations.length) {
        const nextVersion = version + 1;
        const resource = migrations[version];
        if (!resource) {
          throw new Error(`missing migration ${String(nextVersion)}`);
        }
        const packageRoot = process.env.CODEX_ILINK_PACKAGE_ROOT;
        const migrationPath = packageRoot
          ? join(
              packageRoot,
              "dist",
              "bridge",
              "migrations",
              basename(resource),
            )
          : new URL(resource, import.meta.url);
        const sql = readFileSync(migrationPath, "utf8");
        this.#database.exec(sql);
        this.#database.exec(`PRAGMA user_version = ${String(nextVersion)}`);
        version = nextVersion;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
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

  #deleteOutboundAttachmentIntents(
    operationId: string,
    turnId: string,
  ): void {
    this.#database
      .prepare(
        `DELETE FROM outbound_attachment_intents
         WHERE operation_id = ? AND turn_id = ?`,
      )
      .run(operationId, turnId);
  }

  #getOutboundAttachmentIntentByCall(
    turnId: string,
    callId: string,
  ): OutboundAttachmentIntent | null {
    const row = this.#database
      .prepare(
        `SELECT operation_id, thread_id, turn_id, call_id, path, path_key,
                 name, kind, created_at_ms, snapshot_provenance
         FROM outbound_attachment_intents
         WHERE turn_id = ? AND call_id = ?`,
      )
      .get(turnId, callId) as OutboundAttachmentIntentRow | undefined;
    return row ? outboundAttachmentIntentFromRow(row) : null;
  }

  #getOutboundAttachmentIntentByPath(
    turnId: string,
    pathKey: string,
  ): OutboundAttachmentIntent | null {
    const row = this.#database
      .prepare(
        `SELECT operation_id, thread_id, turn_id, call_id, path, path_key,
                 name, kind, created_at_ms, snapshot_provenance
         FROM outbound_attachment_intents
         WHERE turn_id = ? AND path_key = ?`,
      )
      .get(turnId, pathKey) as OutboundAttachmentIntentRow | undefined;
    return row ? outboundAttachmentIntentFromRow(row) : null;
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

type OutboundAttachmentIntentRow = {
  call_id: string;
  created_at_ms: number;
  kind: "file" | "image" | "video";
  name: string;
  operation_id: string;
  path: string;
  path_key: string;
  snapshot_provenance: "legacy" | "staged-v1";
  thread_id: string;
  turn_id: string;
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

function outboundAttachmentIntentFromRow(
  row: OutboundAttachmentIntentRow,
): OutboundAttachmentIntent {
  return {
    callId: row.call_id,
    createdAtMs: row.created_at_ms,
    kind: row.kind,
    name: row.name,
    operationId: row.operation_id,
    path: row.path,
    pathKey: row.path_key,
    snapshotProvenance: row.snapshot_provenance,
    threadId: row.thread_id,
    turnId: row.turn_id,
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
