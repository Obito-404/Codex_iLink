import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SqliteTurnLeaseStore } from "../coordination/turn-lease.ts";
import { AppServerClient } from "./app-server-client.ts";

type JsonObject = Record<string, unknown>;

const bridgePrompt =
  "这是租约仲裁 Bridge 回合。不要调用工具，只回复：LEASE_BRIDGE_OK";
const desktopPrompt =
  "这是应被租约 Hook 阻止的 Desktop 回合。不要调用工具，只回复：LEASE_DESKTOP_SHOULD_NOT_RUN";

async function main(): Promise<void> {
  const cwd = resolve(".");
  const codexExecutable = findCodexExecutable();
  const hookScript = resolve(
    "plugins/codex-ilink-probe/scripts/turn-lifecycle-hook.mjs",
  ).replaceAll("\\", "/");
  if (hookScript.includes("'")) {
    throw new Error("hook script path cannot contain a single quote");
  }

  const hookOverride =
    `hooks.UserPromptSubmit=[{hooks=[{type='command',command='node ${hookScript} UserPromptSubmit',timeout=5}]}]`;
  const leaseDirectory = mkdtempSync(
    join(tmpdir(), "codex-ilink-lease-arbitration-"),
  );
  const leaseDatabasePath = join(leaseDirectory, "coordination.sqlite");
  const leaseStore = new SqliteTurnLeaseStore(leaseDatabasePath);
  const bridgeInstanceId = randomUUID();
  const bridgeEnvironment = sanitizedEnvironment({
    CODEX_ILINK_BRIDGE: "1",
    CODEX_ILINK_BRIDGE_INSTANCE: bridgeInstanceId,
    CODEX_ILINK_LEASE_DB: leaseDatabasePath,
  });
  const bridge = spawnClientWithEnvironment(
    [
      codexExecutable,
      "--dangerously-bypass-hook-trust",
      "app-server",
      "-c",
      hookOverride,
    ],
    bridgeEnvironment,
  );

  let threadId: string | undefined;
  let operationId: string | undefined;
  let bridgeTurnId: string | undefined;

  try {
    await bridge.initialize();
    const started = await bridge.request("thread/start", { cwd });
    const thread = objectField(started, "thread");
    threadId = stringField(thread, "id");
    if (!threadId) throw new Error("thread/start did not return thread.id");

    await bridge.request("thread/name/set", {
      name: "Codex iLink 租约仲裁探针",
      threadId,
    });

    operationId = `bridge-${Date.now()}`;
    const acquired = leaseStore.tryAcquire({
      createdAtMs: Date.now(),
      instanceId: bridgeInstanceId,
      operationId,
      owner: "bridge",
      threadId,
      turnId: null,
    });
    if (!acquired.acquired) throw new Error("Bridge could not acquire lease");

    const turnStarted = await bridge.request("turn/start", {
      clientUserMessageId: `lease-gate-bridge-${Date.now()}`,
      input: [{ type: "text", text: bridgePrompt, text_elements: [] }],
      threadId,
    });
    bridgeTurnId = stringField(objectField(turnStarted, "turn"), "id");
    if (!bridgeTurnId) throw new Error("turn/start did not return turn.id");

    const desktopRun = runDesktopTurn({
      codexExecutable,
      hookOverride,
      leaseDatabasePath,
      threadId,
    });
    const [bridgeRead, desktop] = await Promise.all([
      waitForTurn(bridge, threadId, bridgeTurnId),
      desktopRun,
    ]);

    leaseStore.release({
      instanceId: bridgeInstanceId,
      operationId,
      owner: "bridge",
      threadId,
      turnId: bridgeTurnId,
    });
    operationId = undefined;
    bridge.close();

    const reader = new AppServerClient([codexExecutable, "app-server"]);
    let finalRead: JsonObject;
    try {
      await reader.initialize();
      finalRead = await reader.request("thread/read", {
        includeTurns: true,
        threadId,
      });
    } finally {
      reader.close();
    }

    const finalThread = objectField(finalRead, "thread");
    const turns = arrayField(finalThread, "turns");
    const bridgeTurn = turns.find(
      (turn) => stringField(asObject(turn), "id") === bridgeTurnId,
    );
    const bridgeTurnTexts = itemTexts(asObject(bridgeTurn));
    const allTexts = turns.flatMap((turn) => itemTexts(asObject(turn)));
    const desktopEvents = parseJsonLines(desktop.stdout);
    const desktopUsedModel = desktopEvents.some(
      (event) =>
        event.type === "item.completed" &&
        objectField(event, "item")?.type === "agent_message",
    );
    const passed =
      desktop.exitCode === 0 &&
      !desktopUsedModel &&
      bridgeTurnTexts.includes(bridgePrompt) &&
      bridgeTurnTexts.includes("LEASE_BRIDGE_OK") &&
      !allTexts.includes(desktopPrompt) &&
      bridgeRead.status === "completed";

    process.stdout.write(
      `${JSON.stringify(
        {
          passed,
          threadId,
          bridgeTurnId,
          bridgeTurnTexts,
          allTurns: turns.map((turn) => ({
            id: stringField(asObject(turn), "id"),
            status: stringField(asObject(turn), "status"),
            texts: itemTexts(asObject(turn)),
          })),
          desktop: {
            exitCode: desktop.exitCode,
            stderr: desktop.stderr.slice(-4_000),
            stdout: desktop.stdout.slice(-4_000),
            usedModel: desktopUsedModel,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (!passed) process.exitCode = 2;
  } finally {
    if (threadId && operationId) {
      leaseStore.release({
        instanceId: bridgeInstanceId,
        operationId,
        owner: "bridge",
        threadId,
        turnId: bridgeTurnId ?? null,
      });
    }
    bridge.close();
    leaseStore.close();
    rmSync(leaseDirectory, { force: true, recursive: true });
  }
}

async function waitForTurn(
  client: AppServerClient,
  threadId: string,
  turnId: string,
): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const read = await client.request("thread/read", {
      includeTurns: true,
      threadId,
    });
    const thread = objectField(read, "thread");
    const turn = arrayField(thread, "turns").find(
      (candidate) => stringField(asObject(candidate), "id") === turnId,
    );
    const status = stringField(asObject(turn), "status");
    if (status === "completed" || status === "failed" || status === "interrupted") {
      return { status };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Bridge turn did not finish within 60s");
}

function runDesktopTurn(input: {
  codexExecutable: string;
  hookOverride: string;
  leaseDatabasePath: string;
  threadId: string;
}): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      input.codexExecutable,
      [
        "exec",
        "resume",
        "--dangerously-bypass-hook-trust",
        "--skip-git-repo-check",
        "--json",
        "-c",
        input.hookOverride,
        input.threadId,
        desktopPrompt,
      ],
      {
        cwd: resolve("."),
        env: sanitizedEnvironment({
          CODEX_ILINK_LEASE_DB: input.leaseDatabasePath,
        }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", rejectRun);
    child.once("close", (exitCode) => resolveRun({ exitCode, stderr, stdout }));
  });
}

function spawnClientWithEnvironment(
  command: [string, ...string[]],
  environment: NodeJS.ProcessEnv,
): AppServerClient {
  const previous = process.env;
  process.env = environment;
  try {
    return new AppServerClient(command);
  } finally {
    process.env = previous;
  }
}

function sanitizedEnvironment(
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...additions };
  for (const name of Object.keys(environment)) {
    if (
      [
        "CODEX_API_KEY",
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
        "CODEX_THREAD_ID",
        "OPENAI_API_KEY",
      ].includes(name.toUpperCase())
    ) {
      delete environment[name];
    }
  }
  if (!("CODEX_ILINK_BRIDGE" in additions)) {
    delete environment.CODEX_ILINK_BRIDGE;
  }
  return environment;
}

function findCodexExecutable(): string {
  const configured = process.env.CODEX_ILINK_CODEX_EXE;
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not set");
  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(binRoot, entry.name, "codex.exe"))
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const [executable] = candidates;
  if (!executable) throw new Error("Desktop codex.exe was not found");
  return executable;
}

function parseJsonLines(value: string): JsonObject[] {
  return value
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as JsonObject]
          : [];
      } catch {
        return [];
      }
    });
}

function itemTexts(turn: JsonObject | undefined): string[] {
  return arrayField(turn, "items").flatMap((item) => {
    const object = asObject(item);
    if (object?.type === "agentMessage") {
      const text = stringField(object, "text");
      return text ? [text] : [];
    }
    if (object?.type !== "userMessage") return [];
    return arrayField(object, "content").flatMap((content) => {
      const text = stringField(asObject(content), "text");
      return text ? [text] : [];
    });
  });
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function objectField(
  value: JsonObject | undefined,
  name: string,
): JsonObject | undefined {
  return asObject(value?.[name]);
}

function arrayField(
  value: JsonObject | undefined,
  name: string,
): unknown[] {
  const field = value?.[name];
  return Array.isArray(field) ? field : [];
}

function stringField(
  value: JsonObject | undefined,
  name: string,
): string | undefined {
  const field = value?.[name];
  return typeof field === "string" ? field : undefined;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
