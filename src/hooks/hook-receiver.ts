import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export type HookEvent = {
  capturedAtMs: number;
  cwd: string | null;
  eventName: string;
  model: string | null;
  permissionMode: string | null;
  requestFingerprint?: string | null;
  requestId?: string | null;
  requestSummary?: string | null;
  schemaVersion: 1;
  sessionId: string;
  source: string | null;
  toolName: string | null;
  turnId: string | null;
};

export type HookReceiverOptions = {
  onEvent: (
    event: HookEvent,
    signal: AbortSignal,
  ) => Promise<HookDecision | void> | HookDecision | void;
  pipePath: string;
  spoolDeliveryTimeoutMs?: number;
  spoolDirectory: string;
};

export type HookDecision = {
  behavior: "allow" | "deny" | "passthrough";
};

const MAX_EVENT_BYTES = 16 * 1024;
const MAX_SPOOL_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEAD_LETTER_DIRECTORY = "dead-letter";
const MAX_DEAD_LETTER_FILES = 128;
const MAX_GUARD_PROMPT_DELIVERY_ATTEMPTS = 3;
const DEFAULT_SPOOL_DELIVERY_TIMEOUT_MS = 5_000;

export class HookReceiver {
  readonly #onEvent: HookReceiverOptions["onEvent"];
  readonly #pipePath: string;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #spoolDeliveryTimeoutMs: number;
  readonly #spoolDirectory: string;
  #closePromise: Promise<void> | undefined;
  #draining: Promise<number> | undefined;
  #started = false;

  constructor(options: HookReceiverOptions) {
    this.#onEvent = options.onEvent;
    this.#pipePath = options.pipePath;
    this.#spoolDeliveryTimeoutMs =
      options.spoolDeliveryTimeoutMs ?? DEFAULT_SPOOL_DELIVERY_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#spoolDeliveryTimeoutMs) ||
      this.#spoolDeliveryTimeoutMs <= 0
    ) {
      throw new Error("spoolDeliveryTimeoutMs must be a positive integer");
    }
    this.#spoolDirectory = options.spoolDirectory;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
      this.#accept(socket);
    });
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    return new Promise((resolveStart, rejectStart) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        this.#started = true;
        resolveStart();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#pipePath);
    });
  }

  drainSpool(): Promise<number> {
    if (this.#draining) return this.#draining;
    const draining = this.#drainSpool().finally(() => {
      if (this.#draining === draining) this.#draining = undefined;
    });
    this.#draining = draining;
    return draining;
  }

  async #drainSpool(): Promise<number> {
    mkdirSync(this.#spoolDirectory, { recursive: true });
    this.#pruneDeadLetters();
    let drained = 0;
    const names = readdirSync(this.#spoolDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const path = join(this.#spoolDirectory, name);
      let deliveryFailed = false;
      try {
        if (Date.now() - statSync(path).mtimeMs > MAX_SPOOL_AGE_MS) {
          unlinkSync(path);
          continue;
        }
        const event = parseHookEvent(readFileSync(path, "utf8"));
        if (event) {
          await this.#deliverSpoolEvent(event);
          drained += 1;
        }
        unlinkSync(path);
      } catch {
        // A valid event that repeatedly fails is poison for the serial poll
        // loop. Guarded prompts get three bounded attempts because they carry
        // arbitration state; other lifecycle events are quarantined after one.
        // Invalid data can be deleted because it can never become valid.
        try {
          const event = parseHookEvent(readFileSync(path, "utf8"));
          if (event) {
            const deliveryAttempt = spoolDeliveryAttempt(name) + 1;
            const retryGuardPrompt =
              event.eventName === "UserPromptSubmit" &&
              event.source === "codex-ilink-guard" &&
              deliveryAttempt < MAX_GUARD_PROMPT_DELIVERY_ATTEMPTS;
            try {
              if (retryGuardPrompt) {
                renameSync(
                  path,
                  join(
                    this.#spoolDirectory,
                    retrySpoolName(name, deliveryAttempt),
                  ),
                );
              } else {
                const deadLetterDirectory = join(
                  this.#spoolDirectory,
                  DEAD_LETTER_DIRECTORY,
                );
                mkdirSync(deadLetterDirectory, { recursive: true });
                renameSync(path, join(deadLetterDirectory, name));
                this.#pruneDeadLetters();
              }
            } catch {
              unlinkSync(path);
            }
            deliveryFailed = true;
          } else {
            unlinkSync(path);
          }
        } catch {
          // A racing cleanup already removed it.
        }
      }
      if (deliveryFailed) break;
    }
    return drained;
  }

  #pruneDeadLetters(nowMs = Date.now()): void {
    const directory = join(this.#spoolDirectory, DEAD_LETTER_DIRECTORY);
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      return;
    }
    const retained: Array<{ mtimeMs: number; name: string; path: string }> = [];
    for (const name of names) {
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        if (nowMs - stat.mtimeMs > MAX_SPOOL_AGE_MS) {
          unlinkSync(path);
        } else {
          retained.push({ mtimeMs: stat.mtimeMs, name, path });
        }
      } catch {
        // A concurrent cleanup already removed the file.
      }
    }
    retained.sort(
      (left, right) =>
        left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
    );
    for (
      let index = 0;
      index < retained.length - MAX_DEAD_LETTER_FILES;
      index += 1
    ) {
      const entry = retained[index];
      if (!entry) continue;
      try {
        unlinkSync(entry.path);
      } catch {
        // A concurrent cleanup already removed the file.
      }
    }
  }

  async #deliverSpoolEvent(event: HookEvent): Promise<void> {
    const controller = new AbortController();
    const timeoutError = new Error("E_HOOK_SPOOL_DELIVERY_TIMEOUT");
    const delivery = Promise.resolve().then(() =>
      this.#onEvent(event, controller.signal),
    );
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, this.#spoolDeliveryTimeoutMs);
      timeout.unref();
    });
    try {
      await Promise.race([delivery, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
      void delivery.catch(() => undefined);
    }
  }

  close(): Promise<void> {
    const wasAlreadyStopping = this.#closePromise !== undefined;
    this.stopAccepting();
    const closePromise = this.#closePromise;
    if (!closePromise) return Promise.resolve();
    if (wasAlreadyStopping) {
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        for (const socket of this.#sockets) socket.destroy();
        return closePromise;
      });
    }
    for (const socket of this.#sockets) socket.destroy();
    return closePromise;
  }

  stopAccepting(): void {
    if (!this.#started || this.#closePromise) return;
    this.#closePromise = new Promise((resolveClose, rejectClose) => {
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
    socket.setEncoding("utf8");
    let input = "";
    let finished = false;
    socket.on("data", (chunk: string) => {
      if (finished) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_EVENT_BYTES) {
        finished = true;
        socket.destroy();
      } else if (input.includes("\n")) {
        finished = true;
        void this.#finish(socket, input);
      }
    });
    socket.on("end", () => {
      if (!finished) {
        finished = true;
        void this.#finish(socket, input);
      }
    });
    socket.on("error", () => undefined);
  }

  async #finish(socket: Socket, input: string): Promise<void> {
    const event = parseHookEvent(input.split("\n", 1)[0]?.trim() ?? "");
    if (!event) {
      socket.destroy();
      return;
    }
    try {
      const disconnected = new AbortController();
      const abort = () => disconnected.abort(new Error("E_HOOK_DISCONNECTED"));
      socket.once("close", abort);
      socket.once("error", abort);
      if (event.eventName === "PermissionRequest") {
        socket.write(`${JSON.stringify({ status: "accepted" })}\n`);
      }
      const decision = await this.#onEvent(event, disconnected.signal);
      socket.off("close", abort);
      socket.off("error", abort);
      if (socket.destroyed) return;
      socket.end(
        `${JSON.stringify({ behavior: decision?.behavior ?? "passthrough" })}\n`,
      );
    } catch {
      socket.destroy();
    }
  }
}

function spoolDeliveryAttempt(name: string): number {
  const match = /\.retry-(\d+)\.json$/u.exec(name);
  if (!match) return 0;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
}

function retrySpoolName(name: string, attempt: number): string {
  return `${name.replace(/(?:\.retry-\d+)?\.json$/u, "")}.retry-${String(attempt)}.json`;
}

function parseHookEvent(raw: string): HookEvent | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const event = value as Record<string, unknown>;
    if (
      event.schemaVersion !== 1 ||
      typeof event.capturedAtMs !== "number" ||
      typeof event.eventName !== "string" ||
      typeof event.sessionId !== "string" ||
      !isNullableString(event.turnId) ||
      !isNullableString(event.cwd) ||
      !isNullableString(event.model) ||
      !isNullableString(event.permissionMode) ||
      !isOptionalFingerprint(event.requestFingerprint) ||
      !isOptionalNullableString(event.requestId) ||
      !isOptionalNullableString(event.requestSummary) ||
      !isNullableString(event.toolName) ||
      !isNullableString(event.source)
    ) {
      return null;
    }
    return event as HookEvent;
  } catch {
    return null;
  }
}

function isOptionalFingerprint(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    (typeof value === "string" && /^[a-f\d]{64}$/u.test(value));
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
