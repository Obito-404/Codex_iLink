import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { CodexOutcomeUnknownError } from "./protocol.ts";
import type {
  AppServerCommand,
  AppServerEventListener,
  CodexOutcomeUnknownReason,
  JsonObject,
} from "./protocol.ts";

type PendingRequest = {
  method: string;
  outcomeUnknownOnTimeoutOrEof: boolean;
  reject: (error: Error) => void;
  resolve: (result: JsonObject) => void;
  timeout: NodeJS.Timeout;
};

export type AppServerConnectionOptions = {
  bridgeInstanceId: string;
  command: AppServerCommand;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

export class AppServerConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #eventListeners = new Set<AppServerEventListener>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #requestTimeoutMs: number;
  #closed = false;
  #nextId = 1;
  #terminalError: Error | undefined;

  private constructor(options: AppServerConnectionOptions) {
    const [executable, ...args] = options.command;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.#child = spawn(executable, args, {
      env: controlledEnvironment(
        options.environment ?? process.env,
        options.bridgeInstanceId,
      ),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // App Server diagnostics are not protocol data. Drain them without
    // retaining possible secrets or allowing the pipe to stall the process.
    this.#child.stderr.resume();

    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    lines.once("close", () => {
      if (!this.#closed) {
        this.#terminate(new Error("app-server stdout reached EOF"), "eof");
      }
    });
    this.#child.stdin.on("error", (error) => this.#terminate(error));
    this.#child.once("error", (error) => this.#terminate(error));
    this.#child.once("close", (code, signal) => {
      this.#terminate(
        new Error(
          `app-server exited before replying (code=${String(code)}, signal=${String(signal)})`,
        ),
        "eof",
      );
    });
  }

  static async create(
    options: AppServerConnectionOptions,
  ): Promise<AppServerConnection> {
    const connection = new AppServerConnection(options);
    try {
      await connection.request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "codex_ilink_bridge",
          title: "Codex iLink Bridge",
          version: "0.0.0",
        },
      });
      connection.notify("initialized", {});
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  request(
    method: string,
    params: JsonObject,
    options: { outcomeUnknownOnTimeoutOrEof?: boolean } = {},
  ): Promise<JsonObject> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#closed) {
      return Promise.reject(new Error("app-server connection is closed"));
    }

    const id = this.#nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.reject(
          pending.outcomeUnknownOnTimeoutOrEof
            ? new CodexOutcomeUnknownError(pending.method, "timeout")
            : new Error(
                `${pending.method} timed out after ${this.#requestTimeoutMs}ms`,
              ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        method,
        outcomeUnknownOnTimeoutOrEof:
          options.outcomeUnknownOnTimeoutOrEof ?? false,
        reject,
        resolve,
        timeout,
      });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("app-server connection closed"));
    this.#child.stdin.end();
    if (this.#child.exitCode === null) this.#child.kill();
  }

  isTerminated(): boolean {
    return this.#terminalError !== undefined;
  }

  onEvent(listener: AppServerEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  notify(method: string, params: JsonObject): void {
    this.#write({ method, params });
  }

  respondToServerRequest(id: number | string, result: JsonObject): void {
    this.#write({ id, result });
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#terminate(new Error("app-server emitted malformed JSON on stdout"));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.#terminate(new Error("app-server emitted a non-object JSON message"));
      return;
    }
    const message = parsed as JsonObject;
    if (typeof message.method === "string") {
      const params =
        message.params &&
        typeof message.params === "object" &&
        !Array.isArray(message.params)
          ? (message.params as JsonObject)
          : {};
      const event = {
        ...(typeof message.id === "number" || typeof message.id === "string"
          ? { id: message.id }
          : {}),
        method: message.method,
        params,
      };
      for (const listener of this.#eventListeners) listener(event);
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);

    if (message.error && typeof message.error === "object") {
      const error = message.error as JsonObject;
      pending.reject(
        new Error(
          `${String(error.message ?? "app-server request failed")} (code=${String(error.code ?? "unknown")})`,
        ),
      );
      return;
    }
    if (!message.result || typeof message.result !== "object") {
      pending.reject(new Error("app-server response did not contain a result"));
      return;
    }
    pending.resolve(message.result as JsonObject);
  }

  #notify(message: JsonObject): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#terminate(error);
    });
  }

  #rejectAll(error: Error, reason?: CodexOutcomeUnknownReason): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        reason && pending.outcomeUnknownOnTimeoutOrEof
          ? new CodexOutcomeUnknownError(pending.method, reason)
          : error,
      );
    }
    this.#pending.clear();
  }

  #terminate(error: Error, reason?: CodexOutcomeUnknownReason): void {
    if (!this.#terminalError) this.#terminalError = error;
    this.#rejectAll(this.#terminalError, reason);
    if (!this.#closed && this.#child.exitCode === null) this.#child.kill();
  }

  #write(message: JsonObject): void {
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closed) throw new Error("app-server connection is closed");
    this.#notify(message);
  }
}

function controlledEnvironment(
  source: NodeJS.ProcessEnv,
  bridgeInstanceId: string,
): NodeJS.ProcessEnv {
  const blocked = new Set([
    "CODEX_API_KEY",
    "CODEX_ILINK_BRIDGE",
    "CODEX_ILINK_BRIDGE_INSTANCE",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CODEX_THREAD_ID",
    "OPENAI_API_KEY",
  ]);
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (blocked.has(name.toUpperCase())) delete environment[name];
  }
  environment.CODEX_ILINK_BRIDGE = "1";
  environment.CODEX_ILINK_BRIDGE_INSTANCE = bridgeInstanceId;
  return environment;
}
