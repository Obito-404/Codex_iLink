import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: JsonObject) => void;
  timeout: NodeJS.Timeout;
};

export class AppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  #closed = false;
  #nextId = 1;
  #stderr = "";
  #terminalError: Error | undefined;

  constructor(command: readonly [string, ...string[]]) {
    const [executable, ...args] = command;
    const env = { ...process.env };
    const blockedEnvironmentVariables = new Set([
      "CODEX_API_KEY",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
      "CODEX_THREAD_ID",
      "OPENAI_API_KEY",
    ]);
    for (const name of Object.keys(env)) {
      if (blockedEnvironmentVariables.has(name.toUpperCase())) delete env[name];
    }

    this.#child = spawn(executable, args, {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-64_000);
    });
    this.#child.stdin.on("error", (error) => this.#terminate(error));
    this.#child.once("error", (error) => this.#terminate(error));
    this.#child.once("close", (code, signal) => {
      this.#terminate(
        new Error(
          `app-server exited before replying (code=${String(code)}, signal=${String(signal)}): ${this.#stderr.trim()}`,
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex_ilink_probe",
        title: "Codex iLink Probe",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#closed) {
      return Promise.reject(new Error("app-server client is closed"));
    }

    const id = this.#nextId++;

    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `${method} timed out after 20s${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`,
          ),
        );
      }, 20_000);

      this.#pending.set(id, { reject, resolve, timeout });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    this.#write({ method, params });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("app-server client closed"));
    this.#child.stdin.end();
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #write(message: JsonObject): void {
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closed) throw new Error("app-server client is closed");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#terminate(error);
    });
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#terminate(new Error("app-server emitted malformed JSON on stdout"));
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.#terminate(new Error("app-server emitted a non-object JSON message"));
      return;
    }
    const message = parsed as JsonObject;

    // App Server can send requests (for example approvals) using its own ID
    // namespace. Never consume those as responses to our client requests.
    if (typeof message.method === "string") return;

    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);

    if (Object.hasOwn(message, "error") && message.error && typeof message.error === "object") {
      const error = message.error as JsonObject;
      pending.reject(
        new Error(
          `${String(error.message ?? "app-server request failed")} (code=${String(error.code ?? "unknown")})`,
        ),
      );
      return;
    }

    if (!Object.hasOwn(message, "result") || !message.result || typeof message.result !== "object") {
      pending.reject(new Error("app-server response did not contain a result"));
      return;
    }

    pending.resolve(message.result as JsonObject);
  }

  #terminate(error: Error): void {
    if (!this.#terminalError) this.#terminalError = error;
    this.#rejectAll(this.#terminalError);
    if (!this.#closed && this.#child.exitCode === null) this.#child.kill();
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
