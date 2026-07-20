import {
  mkdirSync,
  readFileSync,
  readdirSync,
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
  spoolDirectory: string;
};

export type HookDecision = {
  behavior: "allow" | "deny" | "passthrough";
};

const MAX_EVENT_BYTES = 16 * 1024;
const MAX_SPOOL_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export class HookReceiver {
  readonly #onEvent: HookReceiverOptions["onEvent"];
  readonly #pipePath: string;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #spoolDirectory: string;
  #closePromise: Promise<void> | undefined;
  #draining: Promise<number> | undefined;
  #started = false;

  constructor(options: HookReceiverOptions) {
    this.#onEvent = options.onEvent;
    this.#pipePath = options.pipePath;
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
    let drained = 0;
    const names = readdirSync(this.#spoolDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const path = join(this.#spoolDirectory, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > MAX_SPOOL_AGE_MS) {
          unlinkSync(path);
          continue;
        }
        const event = parseHookEvent(readFileSync(path, "utf8"));
        if (event) {
          await this.#onEvent(event, new AbortController().signal);
          drained += 1;
        }
        unlinkSync(path);
      } catch {
        // Keep a valid event when its consumer failed so a later drain can
        // retry. Invalid data is removed because it can never become valid.
        try {
          if (!parseHookEvent(readFileSync(path, "utf8"))) unlinkSync(path);
        } catch {
          // A racing cleanup already removed it.
        }
      }
    }
    return drained;
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

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
