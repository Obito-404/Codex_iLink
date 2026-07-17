import {
  AppServerConnection,
  type AppServerConnectionOptions,
} from "./app-server-connection.ts";
import type { DurableTurnAttachment } from "../bridge/turn-input.ts";
import { CodexOutcomeUnknownError } from "./protocol.ts";
import type {
  AppServerEvent,
  AppServerEventListener,
  JsonObject,
  ThreadListResult,
  ThreadReadResult,
  ThreadResumeResult,
  ThreadStartResult,
  ThreadUnarchiveResult,
  TurnStartResult,
} from "./protocol.ts";

export { CodexOutcomeUnknownError };

export type CodexRuntimeOptions = AppServerConnectionOptions;

type ServerRequestOwner = {
  connection: AppServerConnection;
  serverId: number | string;
};

export class CodexRuntime {
  #connection: AppServerConnection;
  #detachConnectionEvents: (() => void) | undefined;
  readonly #eventListeners = new Set<AppServerEventListener>();
  readonly #loadedThreadIds = new Set<string>();
  readonly #options: CodexRuntimeOptions;
  readonly #serverRequestOwners = new Map<
    number | string,
    ServerRequestOwner
  >();
  #closed = false;
  #nextServerRequestToken = 1;
  #reconnectRequired: AppServerConnection | undefined;
  #reconnectPromise: Promise<AppServerConnection> | undefined;

  private constructor(
    options: CodexRuntimeOptions,
    connection: AppServerConnection,
  ) {
    this.#options = options;
    this.#connection = connection;
    this.#attachConnectionEvents(connection);
  }

  static async create(options: CodexRuntimeOptions): Promise<CodexRuntime> {
    return new CodexRuntime(
      options,
      await AppServerConnection.create(options),
    );
  }

  async listThreads(
    input: { archived?: boolean; cursor?: string | null } = {},
  ): Promise<ThreadListResult> {
    const params: JsonObject = {};
    if (input.archived !== undefined) params.archived = input.archived;
    if (input.cursor !== undefined) params.cursor = input.cursor;
    return (await this.#requestSafely(
      "thread/list",
      params,
    )) as ThreadListResult;
  }

  async readThread(input: {
    includeTurns: boolean;
    threadId: string;
  }): Promise<ThreadReadResult> {
    return (await this.#requestSafely("thread/read", {
      includeTurns: input.includeTurns,
      threadId: input.threadId,
    })) as ThreadReadResult;
  }

  async unarchiveThread(threadId: string): Promise<ThreadUnarchiveResult> {
    return (await this.#requestSafely("thread/unarchive", {
      threadId,
    })) as ThreadUnarchiveResult;
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResult> {
    const result = (await this.#requestSafely("thread/resume", {
      threadId,
    })) as ThreadResumeResult;
    this.#loadedThreadIds.add(threadId);
    return result;
  }

  async startThread(cwd: string): Promise<ThreadStartResult> {
    const result = (await this.#requestOnceWithUnknownOutcome("thread/start", {
      cwd,
    })) as ThreadStartResult;
    this.#loadedThreadIds.add(result.thread.id);
    return result;
  }

  async ensureThread(threadId: string): Promise<void> {
    if (
      this.#connection.isTerminated() ||
      this.#reconnectRequired === this.#connection
    ) {
      await this.#reconnect(this.#connection);
    }
    if (this.#loadedThreadIds.has(threadId)) return;
    await this.resumeThread(threadId);
  }

  async startTurn(input: {
    attachments?: readonly DurableTurnAttachment[];
    clientUserMessageId: string;
    text: string;
    threadId: string;
  }): Promise<TurnStartResult> {
    const turnInput: Array<Record<string, unknown>> = [];
    if (input.text.length > 0) {
      turnInput.push({
        text: input.text,
        text_elements: [],
        type: "text",
      });
    }
    for (const attachment of input.attachments ?? []) {
      turnInput.push(
        attachment.kind === "image"
          ? { path: attachment.path, type: "localImage" }
          : {
              name: attachment.name,
              path: attachment.path,
              type: "mention",
            },
      );
    }
    if (turnInput.length === 0) throw new Error("E_CODEX_TURN_INPUT_EMPTY");
    return (await this.#requestOnceWithUnknownOutcome("turn/start", {
      clientUserMessageId: input.clientUserMessageId,
      input: turnInput,
      threadId: input.threadId,
    })) as TurnStartResult;
  }

  setThreadName(input: {
    name: string;
    threadId: string;
  }): Promise<JsonObject> {
    return this.#requestSafely("thread/name/set", {
      name: input.name,
      threadId: input.threadId,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachConnectionEvents?.();
    this.#detachConnectionEvents = undefined;
    this.#invalidateServerRequests(this.#connection);
    this.#connection.close();
  }

  onEvent(listener: AppServerEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  isServerRequestLive(id: number | string): boolean {
    const owner = this.#serverRequestOwners.get(id);
    return owner !== undefined && this.#isServerRequestOwnerLive(owner);
  }

  respondToServerRequest(id: number | string, result: JsonObject): boolean {
    const owner = this.#serverRequestOwners.get(id);
    if (!owner) return false;
    this.#serverRequestOwners.delete(id);
    if (!this.#isServerRequestOwnerLive(owner)) return false;
    try {
      owner.connection.respondToServerRequest(owner.serverId, result);
      return true;
    } catch {
      return false;
    }
  }

  async #requestSafely(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#closed) throw new Error("Codex runtime is closed");

    let connection = this.#connection;
    let reconnected = false;
    if (
      connection.isTerminated() ||
      this.#reconnectRequired === connection
    ) {
      connection = await this.#reconnect(connection);
      reconnected = true;
    }

    try {
      return await connection.request(method, params);
    } catch (error) {
      if (this.#closed || reconnected) throw error;
      if (this.#connection !== connection) {
        connection = this.#connection;
      } else if (
        connection.isTerminated() ||
        this.#reconnectRequired === connection
      ) {
        connection = await this.#reconnect(connection);
      } else {
        throw error;
      }
      return connection.request(method, params);
    }
  }

  async #requestOnceWithUnknownOutcome(
    method: string,
    params: JsonObject,
  ): Promise<JsonObject> {
    if (this.#closed) throw new Error("Codex runtime is closed");
    let connection = this.#connection;
    if (
      connection.isTerminated() ||
      this.#reconnectRequired === connection
    ) {
      connection = await this.#reconnect(connection);
    }

    try {
      return await connection.request(method, params, {
        outcomeUnknownOnTimeoutOrEof: true,
      });
    } catch (error) {
      if (
        error instanceof CodexOutcomeUnknownError &&
        connection.isTerminated()
      ) {
        this.#reconnectRequired = connection;
      }
      throw error;
    }
  }

  async #reconnect(
    unavailable: AppServerConnection,
  ): Promise<AppServerConnection> {
    if (this.#closed) throw new Error("Codex runtime is closed");
    if (this.#connection !== unavailable) return this.#connection;
    if (this.#reconnectPromise) return this.#reconnectPromise;

    const reconnect = (async () => {
      const connection = await AppServerConnection.create(this.#options);
      if (this.#closed) {
        connection.close();
        throw new Error("Codex runtime is closed");
      }
      if (this.#connection !== unavailable) {
        connection.close();
        return this.#connection;
      }
      this.#detachConnectionEvents?.();
      this.#invalidateServerRequests(unavailable);
      unavailable.close();
      this.#connection = connection;
      this.#loadedThreadIds.clear();
      if (this.#reconnectRequired === unavailable) {
        this.#reconnectRequired = undefined;
      }
      this.#attachConnectionEvents(connection);
      return connection;
    })();
    this.#reconnectPromise = reconnect;
    try {
      return await reconnect;
    } finally {
      if (this.#reconnectPromise === reconnect) {
        this.#reconnectPromise = undefined;
      }
    }
  }

  #attachConnectionEvents(connection: AppServerConnection): void {
    this.#detachConnectionEvents = connection.onEvent((event) => {
      if (this.#connection !== connection || this.#closed) return;
      const forwarded = this.#ownServerRequest(connection, event);
      for (const listener of this.#eventListeners) listener(forwarded);
    });
  }

  #ownServerRequest(
    connection: AppServerConnection,
    event: AppServerEvent,
  ): AppServerEvent {
    if (event.id === undefined) return event;
    const token = `codex-runtime-request:${this.#nextServerRequestToken++}`;
    this.#serverRequestOwners.set(token, {
      connection,
      serverId: event.id,
    });
    return { ...event, id: token };
  }

  #invalidateServerRequests(connection: AppServerConnection): void {
    for (const [token, owner] of this.#serverRequestOwners) {
      if (owner.connection === connection) {
        this.#serverRequestOwners.delete(token);
      }
    }
  }

  #isServerRequestOwnerLive(owner: ServerRequestOwner): boolean {
    return (
      !this.#closed &&
      owner.connection === this.#connection &&
      !owner.connection.isTerminated() &&
      this.#reconnectRequired !== owner.connection
    );
  }
}
