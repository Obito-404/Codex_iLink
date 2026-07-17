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
    if (await sendToPipe(pipePath, payload)) return;

    spoolPayload(resolveSpoolDirectory(), payload);
  } catch {
    // Lifecycle telemetry is fail-open and must never block Codex Desktop.
  }
}

function sendToPipe(pipePath, payload) {
  return new Promise((resolveSend) => {
    const socket = connect(pipePath);
    let settled = false;
    const finish = (sent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveSend(sent);
    };
    const timeout = setTimeout(() => finish(false), 300);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      if (chunk.includes("ok")) finish(true);
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
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
