import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SPOOL_BYTES = 5 * 1024 * 1024;
const MAX_SPOOL_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export function createHookEvent(input, capturedAtMs = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const eventName = nullableString(input.hook_event_name);
  const sessionId = nullableString(input.session_id);
  if (!eventName || !sessionId) return null;
  return {
    capturedAtMs,
    cwd: nullableString(input.cwd),
    eventName,
    model: nullableString(input.model),
    permissionMode: nullableString(input.permission_mode),
    ...(eventName === "PermissionRequest"
      ? {
          requestId:
            nullableString(input.request_id) ??
            nullableString(input.tool_use_id) ??
            nullableString(input.tool_call_id),
          requestSummary: permissionSummary(input),
        }
      : {}),
    schemaVersion: 1,
    sessionId,
    source: nullableString(input.source),
    toolName: nullableString(input.tool_name),
    turnId: nullableString(input.turn_id),
  };
}

function permissionSummary(input) {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
      ? input.tool_input
      : null;
  const command = toolInput?.command;
  if (typeof command === "string" && command) return truncate(command);
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return truncate(command.join(" "));
  }
  for (const field of ["reason", "path", "file_path"]) {
    const value = toolInput?.[field];
    if (typeof value === "string" && value) return truncate(value);
  }
  return nullableString(input.tool_name) ?? "Codex Desktop permission request";
}

function truncate(value) {
  return [...value].slice(0, 500).join("");
}

export function resolveSpoolDirectory() {
  return (
    process.env.CODEX_ILINK_SPOOL_DIR ??
    join(process.env.LOCALAPPDATA ?? homedir(), "Codex_iLink", "spool")
  );
}

export function spoolHookEvent(input) {
  const event = createHookEvent(input);
  if (!event) return false;
  spoolPayload(resolveSpoolDirectory(), `${JSON.stringify(event)}\n`);
  return true;
}

export function spoolPayload(directory, payload) {
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  let totalBytes = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs > MAX_SPOOL_AGE_MS) {
        unlinkSync(path);
        continue;
      }
      totalBytes += stat.size;
    } catch {
      // A concurrent drain may have removed the file.
    }
  }
  if (totalBytes + Buffer.byteLength(payload, "utf8") > MAX_SPOOL_BYTES) return;

  const stem = `${now}-${randomUUID()}`;
  const temporaryPath = join(directory, `${stem}.tmp`);
  const finalPath = join(directory, `${stem}.json`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, payload, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  renameSync(temporaryPath, finalPath);
}

function nullableString(value) {
  return typeof value === "string" ? value : null;
}
