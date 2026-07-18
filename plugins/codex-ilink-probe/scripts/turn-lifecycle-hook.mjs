import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spoolHookEvent } from "./hook-spool.mjs";

const SAFE_THREAD_ID = /^[A-Za-z0-9-]+$/u;
const GUARD_OBSERVATION_SOURCE = "codex-ilink-guard";
const UNMANAGED_BUSY_TIMEOUT_MS = 250;
const OBSERVATION_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const BLOCK_OUTPUT = {
  continue: false,
  stopReason: "CODEX_ILINK_THREAD_BUSY",
  systemMessage: "该会话正在执行另一个回合，请稍后重试。",
};

main();

function main() {
  const expectedEvent =
    process.env.CODEX_ILINK_HOOK_EVENT ?? process.argv[2] ?? "";
  const input = readInput();
  const eventName = stringField(input, "hook_event_name");
  const configuredPath = process.env.CODEX_ILINK_LEASE_DB;
  const forceArbitration = configuredPath !== undefined;
  const bridgeTurn = process.env.CODEX_ILINK_BRIDGE === "1";

  if (!input || (expectedEvent && eventName !== expectedEvent)) {
    if (
      expectedEvent === "UserPromptSubmit" &&
      (forceArbitration || bridgeTurn)
    ) {
      block();
    }
    return;
  }
  if (eventName !== "UserPromptSubmit" && eventName !== "Stop") return;

  const threadId = stringField(input, "session_id");
  const turnId = stringField(input, "turn_id");
  if (!threadId || !SAFE_THREAD_ID.test(threadId)) {
    if (
      eventName === "UserPromptSubmit" &&
      (forceArbitration || bridgeTurn)
    ) {
      block();
    }
    return;
  }

  const databasePath = resolve(
    configuredPath ??
      join(process.env.LOCALAPPDATA ?? homedir(), "Codex_iLink", "state.sqlite"),
  );

  if (!forceArbitration && !bridgeTurn && !existsSync(databasePath)) return;

  let database;
  let transactionOpen = false;
  let failClosed = forceArbitration || bridgeTurn;
  let relevantDesktopTurn = forceArbitration || bridgeTurn;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath);
    // Leave enough of the 5 second host budget to emit the fail-closed
    // response if another process keeps SQLite locked.
    database.exec("PRAGMA busy_timeout = 1500");

    // The plugin is global, but the gate is not. Unrelated Desktop turns are
    // returned immediately. Only the selected iLink project is observed so a
    // later /s <n> can be serialized without touching other Desktop projects.
    if (!forceArbitration && !bridgeTurn) {
      const guardedThread =
        isGuardedThread(database, threadId, Date.now()) ||
        hasTurnLease(database, threadId);
      const selectedProjectThread =
        !guardedThread &&
        isSelectedProjectCwd(database, stringField(input, "cwd"));
      const observedStop =
        eventName === "Stop" &&
        hasDesktopObservation(database, threadId, turnId);
      if (!guardedThread && !selectedProjectThread && !observedStop) return;
      relevantDesktopTurn = true;
      if (!guardedThread) {
        if (!turnId) return;
        database.exec(
          `PRAGMA busy_timeout = ${
            eventName === "Stop" ? "1500" : String(UNMANAGED_BUSY_TIMEOUT_MS)
          }`,
        );
        try {
          ensureLeaseSchema(database);
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          if (!isGuardedThread(database, threadId, Date.now())) {
            if (eventName === "UserPromptSubmit") {
              observeDesktopActivity(database, threadId, turnId);
            } else {
              markDesktopStop(database, threadId, turnId);
              clearDesktopActivity(database, threadId, turnId);
            }
            database.exec("COMMIT");
            transactionOpen = false;
            return;
          }
          database.exec("COMMIT");
          transactionOpen = false;
        } catch {
          if (transactionOpen) {
            try {
              database.exec("ROLLBACK");
            } catch {
              // The unrelated Desktop turn remains fail-open.
            }
            transactionOpen = false;
          }
          spoolGuardObservation(input);
          return;
        } finally {
          database.exec("PRAGMA busy_timeout = 1500");
        }
      }
      failClosed = arbitrationEnabled(database);
    }

    if (!turnId) {
      if (eventName === "UserPromptSubmit" && failClosed) block();
      return;
    }

    ensureLeaseSchema(database);
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const arbitrationIsEnabled =
      forceArbitration || arbitrationEnabled(database);
    const guardedThread =
      forceArbitration ||
      isGuardedThread(database, threadId, Date.now()) ||
      hasTurnLease(database, threadId);

    if (eventName === "UserPromptSubmit") {
      let allowed;
      if (bridgeTurn) {
        allowed =
          arbitrationIsEnabled &&
          claimBridgeTurn(database, threadId, turnId);
      } else if (!guardedThread) {
        observeDesktopActivity(database, threadId, turnId);
        allowed = true;
      } else if (arbitrationIsEnabled) {
        allowed = acquireDesktopLease(database, threadId, turnId);
      } else {
        observeDesktopLease(database, threadId, turnId);
        allowed = true;
      }
      database.exec("COMMIT");
      transactionOpen = false;
      if (!allowed) block();
      return;
    }

    if (!bridgeTurn) {
      if (arbitrationIsEnabled) {
        markDesktopStop(database, threadId, turnId);
        markDesktopActivityStop(database, threadId, turnId);
      } else {
        clearObservedDesktopTurn(database, threadId, turnId);
        clearDesktopActivity(database, threadId, turnId);
      }
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // Preserve the original safety decision below.
      }
    }
    // Arbitration is a safety boundary. Once enabled, uncertainty must not
    // allow a possibly concurrent user turn into Codex.
    if (
      eventName === "UserPromptSubmit" &&
      turnId &&
      !failClosed &&
      relevantDesktopTurn
    ) {
      spoolGuardObservation(input);
    }
    if (eventName === "UserPromptSubmit" && failClosed) block();
  } finally {
    database?.close();
  }
}

function isGuardedThread(database, threadId, nowMs) {
  try {
    const row = database
      .prepare(`
        SELECT 1 AS guarded
        WHERE EXISTS (
          SELECT 1 FROM bridge_settings
          WHERE singleton = 1 AND main_thread_id = ?
        ) OR EXISTS (
          SELECT 1 FROM bindings
          WHERE singleton = 1 AND thread_id = ? AND expires_at_ms > ?
        ) OR EXISTS (
          SELECT 1 FROM notification_routes
          WHERE thread_id = ? AND expires_at_ms > ?
        ) OR EXISTS (
          SELECT 1 FROM queued_turns WHERE thread_id = ?
        ) OR EXISTS (
          SELECT 1 FROM dispatch_intents
          WHERE thread_id = ? AND completed_at_ms IS NULL
        )
      `)
      .get(
        threadId,
        threadId,
        nowMs,
        threadId,
        nowMs,
        threadId,
        threadId,
      );
    return row?.guarded === 1;
  } catch (error) {
    if (String(error).includes("no such table")) return false;
    throw error;
  }
}

function hasTurnLease(database, threadId) {
  try {
    const row = database
      .prepare("SELECT 1 AS guarded FROM turn_leases WHERE thread_id = ?")
      .get(threadId);
    return row?.guarded === 1;
  } catch (error) {
    if (String(error).includes("no such table")) return false;
    throw error;
  }
}

function hasDesktopObservation(database, threadId, turnId) {
  if (!turnId) return false;
  try {
    const row = database
      .prepare(`
        SELECT 1 AS observed
        FROM desktop_turn_observations
        WHERE thread_id = ? AND turn_id = ?
      `)
      .get(threadId, turnId);
    return row?.observed === 1;
  } catch (error) {
    if (String(error).includes("no such table")) return false;
    throw error;
  }
}

function isSelectedProjectCwd(database, cwd) {
  if (!cwd) return false;
  try {
    const row = database
      .prepare(`
        SELECT selected_project_path AS projectPath
        FROM bridge_settings
        WHERE singleton = 1
      `)
      .get();
    return (
      typeof row?.projectPath === "string" &&
      windowsPathKey(row.projectPath) === windowsPathKey(cwd)
    );
  } catch (error) {
    if (String(error).includes("no such table")) return false;
    throw error;
  }
}

function windowsPathKey(path) {
  return resolve(path)
    .replaceAll("/", "\\")
    .replace(/\\+$/u, "")
    .toLowerCase();
}

function ensureLeaseSchema(database) {
  database.exec(`
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
    CREATE TABLE IF NOT EXISTS desktop_turn_observations (
      thread_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      stop_seen_at_ms INTEGER,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS desktop_turn_observation_tombstones (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      stopped_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      PRIMARY KEY (thread_id, turn_id)
    ) STRICT;
  `);
}

function arbitrationEnabled(database) {
  try {
    const row = database
      .prepare(`
        SELECT arbitration_enabled AS enabled
        FROM bridge_runtime
        WHERE singleton = 1
      `)
      .get();
    return row?.enabled === 1;
  } catch (error) {
    if (String(error).includes("no such table: bridge_runtime")) return false;
    throw error;
  }
}

function acquireDesktopLease(database, threadId, turnId) {
  const result = database
    .prepare(`
      INSERT OR IGNORE INTO turn_leases (
        thread_id,
        owner,
        instance_id,
        operation_id,
        turn_id,
        created_at_ms,
        schema_version
      ) VALUES (?, 'desktop', 'desktop', ?, ?, ?, 1)
    `)
    .run(threadId, turnId, turnId, Date.now());
  if (Number(result.changes) === 1) return true;

  const current = database
    .prepare(`
      SELECT owner, operation_id AS operationId, turn_id AS turnId
      FROM turn_leases
      WHERE thread_id = ?
    `)
    .get(threadId);
  return (
    current?.owner === "desktop" &&
    current.operationId === turnId &&
    current.turnId === turnId
  );
}

function observeDesktopLease(database, threadId, turnId) {
  database
    .prepare(`
      INSERT INTO turn_leases (
        thread_id,
        owner,
        instance_id,
        operation_id,
        turn_id,
        created_at_ms,
        stop_seen_at_ms,
        schema_version
      ) VALUES (?, 'desktop', 'desktop', ?, ?, ?, NULL, 1)
      ON CONFLICT(thread_id) DO UPDATE SET
        owner = 'desktop',
        instance_id = 'desktop',
        operation_id = excluded.operation_id,
        turn_id = excluded.turn_id,
        created_at_ms = excluded.created_at_ms,
        stop_seen_at_ms = NULL,
        schema_version = 1
    `)
    .run(threadId, turnId, turnId, Date.now());
}

function claimBridgeTurn(database, threadId, turnId) {
  const instanceId = process.env.CODEX_ILINK_BRIDGE_INSTANCE;
  if (!instanceId) return false;
  const result = database
    .prepare(`
      UPDATE turn_leases
      SET turn_id = ?
      WHERE thread_id = ?
        AND owner = 'bridge'
        AND instance_id = ?
        AND (turn_id IS NULL OR turn_id = ?)
    `)
    .run(turnId, threadId, instanceId, turnId);
  return Number(result.changes) === 1;
}

function markDesktopStop(database, threadId, turnId) {
  database
    .prepare(`
      UPDATE turn_leases
      SET stop_seen_at_ms = ?
      WHERE thread_id = ?
        AND owner = 'desktop'
        AND operation_id = ?
        AND turn_id = ?
    `)
    .run(Date.now(), threadId, turnId, turnId);
}

function clearObservedDesktopTurn(database, threadId, turnId) {
  database
    .prepare(`
      DELETE FROM turn_leases
      WHERE thread_id = ?
        AND owner = 'desktop'
        AND instance_id = 'desktop'
        AND operation_id = ?
        AND turn_id = ?
    `)
    .run(threadId, turnId, turnId);
}

function observeDesktopActivity(database, threadId, turnId) {
  const nowMs = Date.now();
  database
    .prepare(`
      DELETE FROM desktop_turn_observation_tombstones
      WHERE expires_at_ms <= ?
    `)
    .run(nowMs);
  database
    .prepare(`
      INSERT INTO desktop_turn_observations (
        thread_id,
        turn_id,
        created_at_ms,
        stop_seen_at_ms,
        schema_version
      )
      SELECT ?, ?, ?, NULL, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM desktop_turn_observation_tombstones
        WHERE thread_id = ? AND turn_id = ? AND expires_at_ms > ?
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        created_at_ms = excluded.created_at_ms,
        stop_seen_at_ms = NULL,
        schema_version = 1
      WHERE desktop_turn_observations.created_at_ms <= excluded.created_at_ms
    `)
    .run(threadId, turnId, nowMs, threadId, turnId, nowMs);
}

function markDesktopActivityStop(database, threadId, turnId) {
  database
    .prepare(`
      UPDATE desktop_turn_observations
      SET stop_seen_at_ms = ?
      WHERE thread_id = ? AND turn_id = ?
    `)
    .run(Date.now(), threadId, turnId);
}

function clearDesktopActivity(database, threadId, turnId) {
  const stoppedAtMs = Date.now();
  database
    .prepare(`
      INSERT INTO desktop_turn_observation_tombstones (
        thread_id,
        turn_id,
        stopped_at_ms,
        expires_at_ms,
        schema_version
      )
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET
        stopped_at_ms = MAX(stopped_at_ms, excluded.stopped_at_ms),
        expires_at_ms = MAX(expires_at_ms, excluded.expires_at_ms),
        schema_version = 1
    `)
    .run(
      threadId,
      turnId,
      stoppedAtMs,
      stoppedAtMs + OBSERVATION_TOMBSTONE_TTL_MS,
    );
  database
    .prepare(`
      DELETE FROM desktop_turn_observations
      WHERE thread_id = ? AND turn_id = ?
    `)
    .run(threadId, turnId);
}

function readInput() {
  try {
    const raw = readFileSync(0, "utf8");
    const value = raw.trim() ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function spoolGuardObservation(input) {
  try {
    spoolHookEvent({
      ...input,
      source: GUARD_OBSERVATION_SOURCE,
    });
  } catch {
    // Fail-open work must not be stopped when both SQLite and telemetry
    // storage are unavailable.
  }
}

function stringField(value, name) {
  return typeof value?.[name] === "string" ? value[name] : null;
}

function block() {
  process.stdout.write(JSON.stringify(BLOCK_OUTPUT));
}
