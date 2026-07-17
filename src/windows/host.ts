import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { join, resolve } from "node:path";

import { SqliteState } from "../bridge/sqlite-state.ts";
import { CodexRuntime } from "../codex/codex-runtime.ts";
import type { AppServerCommand } from "../codex/protocol.ts";
import { SqliteTurnLeaseStore } from "../coordination/turn-lease.ts";
import { BridgeDaemon } from "../daemon/bridge-daemon.ts";
import { HookReceiver } from "../hooks/hook-receiver.ts";
import { ILinkClient } from "../ilink/ilink-client.ts";
import type { ILinkSession } from "../ilink/protocol.ts";
import { InboundMediaStore } from "../media/inbound-media.ts";
import { unprotectForCurrentUser } from "./dpapi.ts";
import {
  desktopProjectStatePath,
  readDesktopProjects,
} from "./desktop-projects.ts";
import {
  createPowerRequestCommand,
  PowerRequestController,
} from "./power-request.ts";
import { getPresence, getPresenceObservation } from "./presence.ts";
import { runtimePaths, userPipePath } from "./runtime-paths.ts";

const CONTROL_REQUEST_LIMIT_BYTES = 4 * 1024;
const DEFAULT_POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export type HostPhase = "running" | "starting" | "stopping";

export type HostStatus = {
  phase: HostPhase;
  pid: number;
  startedAtMs: number;
};

export type HostControlCommand = "status" | "stop";

export type HostControlResponse =
  | { ok: true; status: HostStatus }
  | { error: string; ok: false };

export type HostControlServerOptions = {
  onStatus: () => HostStatus;
  onStop: () => void;
  pipePath: string;
};

/**
 * The control pipe is also the per-user singleton. Windows owns its lifetime,
 * so a crashed process cannot leave a stale lock that blocks the next start.
 */
export class HostControlServer {
  readonly #options: HostControlServerOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #started = false;

  private constructor(options: HostControlServerOptions) {
    this.#options = options;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  static start(options: HostControlServerOptions): Promise<HostControlServer> {
    const control = new HostControlServer(options);
    return new Promise((resolveStart, rejectStart) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        control.#server.off("listening", onListening);
        if (error.code === "EADDRINUSE") {
          rejectStart(new Error("E_HOST_ALREADY_RUNNING", { cause: error }));
          return;
        }
        rejectStart(error);
      };
      const onListening = (): void => {
        control.#server.off("error", onError);
        control.#started = true;
        resolveStart(control);
      };
      control.#server.once("error", onError);
      control.#server.once("listening", onListening);
      control.#server.listen(options.pipePath);
    });
  }

  close(): Promise<void> {
    if (!this.#started) return Promise.resolve();
    for (const socket of this.#sockets) socket.destroy();
    return new Promise((resolveClose, rejectClose) => {
      this.#server.close((error) => {
        if (error) rejectClose(error);
        else {
          this.#started = false;
          resolveClose();
        }
      });
    });
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.setTimeout(2_000, () => socket.destroy());
    socket.setEncoding("utf8");
    let input = "";
    let handled = false;
    const reject = (error: string): void => {
      if (handled) return;
      handled = true;
      socket.end(`${JSON.stringify({ error, ok: false })}\n`);
    };
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > CONTROL_REQUEST_LIMIT_BYTES) {
        reject("E_HOST_CONTROL_REQUEST_TOO_LARGE");
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      this.#handle(socket, input.slice(0, newline));
    });
    socket.on("end", () => {
      if (!handled) reject("E_HOST_CONTROL_INVALID_REQUEST");
    });
    socket.on("error", () => undefined);
  }

  #handle(socket: Socket, line: string): void {
    let command: unknown;
    try {
      command = (JSON.parse(line) as { command?: unknown }).command;
    } catch {
      socket.end(
        `${JSON.stringify({ error: "E_HOST_CONTROL_INVALID_REQUEST", ok: false })}\n`,
      );
      return;
    }
    if (command !== "status" && command !== "stop") {
      socket.end(
        `${JSON.stringify({ error: "E_HOST_CONTROL_UNKNOWN_COMMAND", ok: false })}\n`,
      );
      return;
    }

    const response = `${JSON.stringify({ ok: true, status: this.#options.onStatus() })}\n`;
    if (command !== "stop") {
      socket.end(response);
      return;
    }

    // Flush the acknowledgement before shutdown closes every control socket.
    // Keep a short fallback so a client disconnect cannot suppress the stop.
    let stopRequested = false;
    const requestStop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      this.#options.onStop();
    };
    const fallback = setTimeout(requestStop, 100);
    fallback.unref();
    socket.end(response, () => {
      clearTimeout(fallback);
      const afterFlush = setTimeout(requestStop, 25);
      afterFlush.unref();
    });
  }
}

export function hostControlPipePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return `${userPipePath(environment)}-control`;
}

export function requestHostControl(
  pipePath: string,
  command: HostControlCommand,
  timeoutMs = 2_000,
): Promise<HostControlResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(pipePath);
    socket.setEncoding("utf8");
    let input = "";
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("E_HOST_CONTROL_TIMEOUT")),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
    };
    const finish = (error?: Error, response?: HostControlResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectRequest(error);
      else if (response) resolveRequest(response);
      else rejectRequest(new Error("E_HOST_CONTROL_INVALID_RESPONSE"));
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > CONTROL_REQUEST_LIMIT_BYTES) {
        finish(new Error("E_HOST_CONTROL_INVALID_RESPONSE"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(input.slice(0, newline)) as HostControlResponse;
        if (!isHostControlResponse(response)) {
          finish(new Error("E_HOST_CONTROL_INVALID_RESPONSE"));
          return;
        }
        finish(undefined, response);
      } catch {
        finish(new Error("E_HOST_CONTROL_INVALID_RESPONSE"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("E_HOST_CONTROL_EOF")));
  });
}

export function findDesktopCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_ILINK_CODEX_EXE?.trim();
  if (configured) {
    const executable = resolve(configured);
    if (!isFile(executable)) {
      throw new Error("E_DESKTOP_CODEX_NOT_FOUND");
    }
    return executable;
  }

  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData) throw new Error("E_LOCALAPPDATA_REQUIRED");
  const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
  let candidates: string[];
  try {
    candidates = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(binRoot, entry.name, "codex.exe"))
      .filter(isFile)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  } catch (error) {
    throw new Error("E_DESKTOP_CODEX_NOT_FOUND", { cause: error });
  }
  const executable = candidates[0];
  if (!executable) throw new Error("E_DESKTOP_CODEX_NOT_FOUND");
  return executable;
}

export function desktopCodexAppServerCommand(
  environment: NodeJS.ProcessEnv = process.env,
): AppServerCommand {
  return [findDesktopCodexExecutable(environment), "app-server"];
}

export type SerialPollingLoopOptions = {
  backoffMs?: readonly number[];
  onRetry?: (error: unknown, delayMs: number, failureCount: number) => void;
  poll: (signal: AbortSignal) => Promise<unknown>;
  signal: AbortSignal;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

export async function runSerialPollingLoop(
  options: SerialPollingLoopOptions,
): Promise<void> {
  const backoffMs = options.backoffMs ?? DEFAULT_POLL_BACKOFF_MS;
  if (backoffMs.length === 0 || backoffMs.some((value) => value < 0)) {
    throw new Error("E_HOST_INVALID_BACKOFF");
  }
  const sleep = options.sleep ?? abortableDelay;
  let failureCount = 0;
  while (!options.signal.aborted) {
    try {
      await options.poll(options.signal);
      failureCount = 0;
    } catch (error) {
      if (options.signal.aborted) return;
      failureCount += 1;
      const index = Math.min(failureCount - 1, backoffMs.length - 1);
      const delayMs = backoffMs[index];
      if (delayMs === undefined) throw new Error("E_HOST_INVALID_BACKOFF");
      options.onRetry?.(error, delayMs, failureCount);
      try {
        await sleep(delayMs, options.signal);
      } catch (sleepError) {
        if (options.signal.aborted) return;
        throw sleepError;
      }
    }
  }
}

export type HostLifecycleResources = {
  daemon: {
    pollOnce(signal?: AbortSignal): Promise<unknown>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  leases: { close(): void };
  power: { close(): Promise<void> };
  state: { close(): void };
};

export async function runHostLifecycle(
  resources: HostLifecycleResources,
  options: {
    onStarted?: () => void;
    onRetry?: SerialPollingLoopOptions["onRetry"];
    signal: AbortSignal;
  },
): Promise<void> {
  let failed = false;
  let primaryError: unknown;
  try {
    await resources.daemon.start();
    options.onStarted?.();
    await runSerialPollingLoop({
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
      poll: (signal) => resources.daemon.pollOnce(signal),
      signal: options.signal,
    });
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await resources.daemon.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await resources.power.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      resources.leases.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      resources.state.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (failed && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "E_HOST_RUNTIME_AND_SHUTDOWN",
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "E_HOST_SHUTDOWN");
    }
  }
  if (failed) throw primaryError;
}

export type RunWindowsHostOptions = {
  environment?: NodeJS.ProcessEnv;
  onRetry?: SerialPollingLoopOptions["onRetry"];
  signal?: AbortSignal;
};

/** Production composition root for the background bridge process. */
export async function runWindowsHost(
  options: RunWindowsHostOptions = {},
): Promise<void> {
  if (process.platform !== "win32") throw new Error("E_HOST_WINDOWS_ONLY");
  const environment = options.environment ?? process.env;
  if (!environment.LOCALAPPDATA) throw new Error("E_LOCALAPPDATA_REQUIRED");
  const paths = runtimePaths(environment);
  mkdirSync(paths.dataDirectory, { recursive: true });
  mkdirSync(paths.logDirectory, { recursive: true });

  const startedAtMs = Date.now();
  let phase: HostPhase = "starting";
  const localAbort = new AbortController();
  const forwardAbort = (): void => {
    phase = "stopping";
    localAbort.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  const control = await HostControlServer.start({
    onStatus: () => ({ phase, pid: process.pid, startedAtMs }),
    onStop: () => {
      phase = "stopping";
      localAbort.abort(new Error("E_HOST_STOP_REQUESTED"));
    },
    pipePath: hostControlPipePath(environment),
  });

  let state: SqliteState | undefined;
  let leases: SqliteTurnLeaseStore | undefined;
  let power: PowerRequestController | undefined;
  let hookReceiver: HookReceiver | undefined;
  let codex: CodexRuntime | undefined;
  let failed = false;
  let primaryError: unknown;
  try {
    state = new SqliteState(paths.stateDatabasePath);
    const storedSession = state.getILinkSession();
    if (!storedSession) throw new Error("E_ILINK_LOGIN_REQUIRED");
    const session: ILinkSession = {
      baseUrl: storedSession.baseUrl,
      botId: storedSession.botId,
      botToken: unprotectForCurrentUser(storedSession.protectedToken),
      controllerUserId: storedSession.controllerUserId,
    };

    const bridgeInstanceId = randomUUID();
    leases = new SqliteTurnLeaseStore(paths.stateDatabasePath);
    codex = await CodexRuntime.create({
      bridgeInstanceId,
      command: desktopCodexAppServerCommand(environment),
      environment,
    });
    const ilink = new ILinkClient();
    const media = new InboundMediaStore({
      rootDirectory: paths.mediaDirectory,
    });
    power = new PowerRequestController(createPowerRequestCommand());
    let daemon: BridgeDaemon | undefined;
    hookReceiver = new HookReceiver({
      onEvent: (event) => daemon?.ingestHookEvent(event),
      pipePath: paths.pipePath,
      spoolDirectory: paths.spoolDirectory,
    });
    daemon = new BridgeDaemon({
      activeTaskCounter: power,
      bridgeInstanceId,
      codex,
      hookReceiver,
      ilink,
      inboxDirectory: paths.inboxDirectory,
      leases,
      listProjects: () =>
        readDesktopProjects(desktopProjectStatePath(environment)),
      media,
      newId: randomUUID,
      now: Date.now,
      onLifecycleWarning: (operation, error) => {
        console.error(`[ilink] ${operation} failed:`, safeErrorMessage(error));
      },
      presence: getPresence,
      presenceObservation: getPresenceObservation,
      session,
      state,
    });
    try {
      await runHostLifecycle(
        { daemon, leases, power, state },
        {
          onRetry:
            options.onRetry ??
            ((error, delayMs, failureCount) => {
              console.error(
                `[ilink] poll failed (${failureCount}); retry in ${delayMs}ms:`,
                safeErrorMessage(error),
              );
            }),
          onStarted: () => {
            phase = "running";
          },
          signal: localAbort.signal,
        },
      );
    } finally {
      // runHostLifecycle owns these resources as soon as it is invoked.
      state = undefined;
      leases = undefined;
      power = undefined;
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    phase = "stopping";
    options.signal?.removeEventListener("abort", forwardAbort);
    // These are only populated when composition failed before lifecycle took
    // ownership. Every close operation is idempotent at this boundary.
    const cleanupErrors: unknown[] = [];
    try {
      await hookReceiver?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      codex?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await power?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      leases?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      state?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await control.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (failed && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "E_HOST_COMPOSITION_AND_SHUTDOWN",
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "E_HOST_COMPOSITION_SHUTDOWN");
    }
  }
  if (failed) throw primaryError;
}

function isHostControlResponse(value: unknown): value is HostControlResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (response.ok === false) return typeof response.error === "string";
  if (response.ok !== true || !response.status || typeof response.status !== "object") {
    return false;
  }
  const status = response.status as Record<string, unknown>;
  return (
    (status.phase === "starting" ||
      status.phase === "running" ||
      status.phase === "stopping") &&
    Number.isSafeInteger(status.pid) &&
    Number.isSafeInteger(status.startedAtMs)
  );
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      rejectDelay(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
