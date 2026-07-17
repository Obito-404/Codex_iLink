import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type TurnLeaseOwner = "bridge" | "desktop";

export type TurnLease = {
  createdAtMs: number;
  instanceId: string;
  operationId: string;
  owner: TurnLeaseOwner;
  schemaVersion: 1;
  threadId: string;
  turnId: string | null;
};

export type AcquireTurnLeaseResult =
  | { acquired: true; lease: TurnLease }
  | { acquired: false; heldBy: TurnLease | null };

export type AcquireTurnLeaseInput = Omit<TurnLease, "schemaVersion">;
export type ReleaseTurnLeaseInput = Pick<
  TurnLease,
  "instanceId" | "operationId" | "owner" | "threadId" | "turnId"
>;

export type ClaimBridgeTurnInput = Pick<
  TurnLease,
  "instanceId" | "threadId"
> & { turnId: string };

export type MarkDesktopStopInput = Pick<TurnLease, "threadId"> & {
  stoppedAtMs: number;
  turnId: string;
};

const SAFE_THREAD_ID = /^[A-Za-z0-9-]+$/u;

/**
 * Cross-process lease storage for the Desktop/Bridge turn boundary.
 *
 * Acquisition and release are single SQLite statements. In particular,
 * release must never be implemented as read-then-unlink: a delayed duplicate
 * release could otherwise delete a replacement owner's lease.
 */
export class SqliteTurnLeaseStore {
  readonly #database: DatabaseSync;
  readonly #claimBridgeTurn: StatementSync;
  readonly #deleteLease: StatementSync;
  readonly #insertLease: StatementSync;
  readonly #listLeases: StatementSync;
  readonly #markDesktopStop: StatementSync;
  readonly #matchesLease: StatementSync;
  readonly #readLease: StatementSync;
  readonly #releaseStoppedDesktop: StatementSync;

  constructor(databasePath: string) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#database = new DatabaseSync(absolutePath);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS turn_leases (
        thread_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('bridge', 'desktop')),
        instance_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        turn_id TEXT,
        created_at_ms INTEGER NOT NULL,
        stop_seen_at_ms INTEGER,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1)
      ) STRICT;
    `);
    this.#insertLease = this.#database.prepare(`
      INSERT OR IGNORE INTO turn_leases (
        thread_id,
        owner,
        instance_id,
        operation_id,
        turn_id,
        created_at_ms,
        schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    this.#readLease = this.#database.prepare(`
      SELECT
        thread_id AS threadId,
        owner,
        instance_id AS instanceId,
        operation_id AS operationId,
        turn_id AS turnId,
        created_at_ms AS createdAtMs,
        schema_version AS schemaVersion
      FROM turn_leases
      WHERE thread_id = ?
    `);
    this.#listLeases = this.#database.prepare(`
      SELECT
        thread_id AS threadId,
        owner,
        instance_id AS instanceId,
        operation_id AS operationId,
        turn_id AS turnId,
        created_at_ms AS createdAtMs,
        schema_version AS schemaVersion
      FROM turn_leases
      ORDER BY thread_id
    `);
    this.#deleteLease = this.#database.prepare(`
      DELETE FROM turn_leases
      WHERE thread_id = ?
        AND owner = ?
        AND instance_id = ?
        AND operation_id = ?
        AND turn_id IS ?
    `);
    this.#claimBridgeTurn = this.#database.prepare(`
      UPDATE turn_leases
      SET turn_id = ?
      WHERE thread_id = ?
        AND owner = 'bridge'
        AND instance_id = ?
        AND (turn_id IS NULL OR turn_id = ?)
    `);
    this.#markDesktopStop = this.#database.prepare(`
      UPDATE turn_leases
      SET stop_seen_at_ms = ?
      WHERE thread_id = ?
        AND owner = 'desktop'
        AND operation_id = ?
        AND turn_id = ?
    `);
    this.#matchesLease = this.#database.prepare(`
      SELECT 1 AS held
      FROM turn_leases
      WHERE thread_id = ?
        AND owner = ?
        AND instance_id = ?
        AND operation_id = ?
        AND turn_id IS ?
    `);
    this.#releaseStoppedDesktop = this.#database.prepare(`
      DELETE FROM turn_leases
      WHERE thread_id = ?
        AND owner = 'desktop'
        AND operation_id = ?
        AND turn_id = ?
        AND stop_seen_at_ms IS NOT NULL
    `);
  }

  tryAcquire(input: AcquireTurnLeaseInput): AcquireTurnLeaseResult {
    assertSafeThreadId(input.threadId);
    const lease: TurnLease = { ...input, schemaVersion: 1 };
    const result = this.#insertLease.run(
      lease.threadId,
      lease.owner,
      lease.instanceId,
      lease.operationId,
      lease.turnId,
      lease.createdAtMs,
    );
    if (Number(result.changes) === 1) return { acquired: true, lease };

    return {
      acquired: false,
      heldBy: parseLeaseRow(this.#readLease.get(input.threadId)),
    };
  }

  getLease(threadId: string): TurnLease | null {
    assertSafeThreadId(threadId);
    return parseLeaseRow(this.#readLease.get(threadId));
  }

  listLeases(): TurnLease[] {
    return this.#listLeases
      .all()
      .map(parseLeaseRow)
      .filter((lease): lease is TurnLease => lease !== null);
  }

  release(expected: ReleaseTurnLeaseInput): boolean {
    assertSafeThreadId(expected.threadId);
    const result = this.#deleteLease.run(
      expected.threadId,
      expected.owner,
      expected.instanceId,
      expected.operationId,
      expected.turnId,
    );
    return Number(result.changes) === 1;
  }

  claimBridgeTurn(input: ClaimBridgeTurnInput): boolean {
    assertSafeThreadId(input.threadId);
    const result = this.#claimBridgeTurn.run(
      input.turnId,
      input.threadId,
      input.instanceId,
      input.turnId,
    );
    return Number(result.changes) === 1;
  }

  markDesktopStop(input: MarkDesktopStopInput): boolean {
    assertSafeThreadId(input.threadId);
    const result = this.#markDesktopStop.run(
      input.stoppedAtMs,
      input.threadId,
      input.turnId,
      input.turnId,
    );
    return Number(result.changes) === 1;
  }

  isHeldBy(expected: ReleaseTurnLeaseInput): boolean {
    assertSafeThreadId(expected.threadId);
    const row = this.#matchesLease.get(
      expected.threadId,
      expected.owner,
      expected.instanceId,
      expected.operationId,
      expected.turnId,
    ) as { held: number } | undefined;
    return row?.held === 1;
  }

  /** Caller must first prove this exact Desktop turn is terminal. */
  releaseStoppedDesktop(input: Pick<MarkDesktopStopInput, "threadId" | "turnId">): boolean {
    assertSafeThreadId(input.threadId);
    const result = this.#releaseStoppedDesktop.run(
      input.threadId,
      input.turnId,
      input.turnId,
    );
    return Number(result.changes) === 1;
  }

  close(): void {
    this.#database.close();
  }
}

function assertSafeThreadId(threadId: string): void {
  if (!SAFE_THREAD_ID.test(threadId)) {
    throw new Error("threadId contains unsafe characters");
  }
}

function parseLeaseRow(value: unknown): TurnLease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.threadId !== "string" ||
    (row.owner !== "bridge" && row.owner !== "desktop") ||
    typeof row.instanceId !== "string" ||
    typeof row.operationId !== "string" ||
    (row.turnId !== null && typeof row.turnId !== "string") ||
    typeof row.createdAtMs !== "number" ||
    row.schemaVersion !== 1
  ) {
    return null;
  }
  return {
    createdAtMs: row.createdAtMs,
    instanceId: row.instanceId,
    operationId: row.operationId,
    owner: row.owner,
    schemaVersion: 1,
    threadId: row.threadId,
    turnId: row.turnId,
  };
}
