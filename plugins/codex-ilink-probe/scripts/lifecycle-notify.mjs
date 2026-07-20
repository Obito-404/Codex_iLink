import { createHash } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import {
  createHookEvent,
  resolveSpoolDirectory,
  spoolPayload,
} from "./hook-spool.mjs";

await main();

async function main() {
  try {
    const input = await readStdin();
    const event = createHookEvent(input);
    if (!event) return;
    const payload = `${JSON.stringify(event)}\n`;
    const pipePath = process.env.CODEX_ILINK_PIPE_PATH ?? defaultPipePath();
    const response = await sendToPipe(
      pipePath,
      payload,
      event.eventName === "PermissionRequest" ? 30 * 60 * 1_000 + 2_000 : 300,
    );
    if (response) {
      if (
        event.eventName === "PermissionRequest" &&
        (response.behavior === "allow" || response.behavior === "deny")
      ) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              decision: { behavior: response.behavior },
              hookEventName: "PermissionRequest",
            },
          }),
        );
      }
      return;
    }
    if (event.eventName === "PermissionRequest") return;

    spoolPayload(resolveSpoolDirectory(), payload);
  } catch {
    // Lifecycle telemetry is fail-open and must never block Codex Desktop.
  }
}

function sendToPipe(pipePath, payload, timeoutMs) {
  return new Promise((resolveSend) => {
    const socket = connect(pipePath);
    let settled = false;
    let response = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveSend(result);
    };
    let timeout = setTimeout(() => finish(null), 300);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
      while (response.includes("\n")) {
        const newline = response.indexOf("\n");
        const line = response.slice(0, newline);
        response = response.slice(newline + 1);
        try {
          const parsed = JSON.parse(line);
          if (parsed?.status === "accepted") {
            clearTimeout(timeout);
            timeout = setTimeout(() => finish(null), timeoutMs);
            continue;
          }
          finish(
            parsed?.behavior === "allow" ||
              parsed?.behavior === "deny" ||
              parsed?.behavior === "passthrough"
              ? parsed
              : null,
          );
        } catch {
          finish(null);
        }
      }
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });
}

function defaultPipePath() {
  const identity = `${process.env.USERPROFILE ?? homedir()}|${
    process.env.USERNAME ?? "user"
  }`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\codex-ilink-${suffix}`;
}

function readStdin() {
  return new Promise((resolveInput) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      try {
        resolveInput(input.trim() ? JSON.parse(input) : null);
      } catch {
        resolveInput(null);
      }
    });
  });
}
