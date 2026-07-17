import { randomBytes } from "node:crypto";

import {
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_BOT_AGENT,
  ILINK_BOT_TYPE,
  ILINK_CHANNEL_VERSION,
  ILINK_LOGIN_BASE_URL,
  ILinkError,
  type GetUpdatesResult,
  type ILinkSession,
  type QrChallenge,
  type QrPollResult,
  type SendTextResult,
  type WireWeixinMessage,
} from "./protocol.ts";

export type ILinkFetch = typeof fetch;

export type ILinkClientOptions = {
  fetch?: ILinkFetch;
};

type SendTextInput = {
  clientId: string;
  contextToken: string;
  session: ILinkSession;
  signal?: AbortSignal;
  text: string;
  timeoutMs?: number;
};

type LifecycleInput = {
  session: ILinkSession;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type SendTextIdentity = {
  contextToken: string;
  targetUserId: string;
  text: string;
};

type SendTextFlight = {
  identity: SendTextIdentity;
  promise: Promise<SendTextResult>;
};

export class ILinkClientIdCollisionError extends Error {
  readonly clientId: string;
  readonly code = "ILINK_CLIENT_ID_COLLISION" as const;

  constructor(clientId: string) {
    super(`sendText clientId collision for clientId=${clientId}`);
    this.name = "ILinkClientIdCollisionError";
    this.clientId = clientId;
  }
}

export class ILinkClient {
  readonly #fetch: ILinkFetch;
  readonly #sendTextFlights = new Map<string, SendTextFlight>();

  constructor(options: ILinkClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async createQr(input: {
    localTokenList: readonly string[];
    signal?: AbortSignal;
  }): Promise<QrChallenge> {
    const url = new URL("ilink/bot/get_bot_qrcode", `${ILINK_LOGIN_BASE_URL}/`);
    url.searchParams.set("bot_type", ILINK_BOT_TYPE);
    const response = await this.#fetch(url, {
      body: JSON.stringify({ local_token_list: input.localTokenList }),
      headers: buildPostHeaders(),
      method: "POST",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    assertHttpSuccess("createQr", response);
    const body = await readResponseObject("createQr", response);
    if (
      typeof body.qrcode !== "string" ||
      body.qrcode.length === 0 ||
      typeof body.qrcode_img_content !== "string" ||
      body.qrcode_img_content.length === 0
    ) {
      throw invalidResponse("createQr");
    }
    return {
      qrcode: body.qrcode,
      qrcodeUrl: body.qrcode_img_content,
    };
  }

  async pollQr(input: {
    baseUrl?: string;
    qrcode: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    verifyCode?: string;
  }): Promise<QrPollResult> {
    const url = endpointUrl(
      input.baseUrl ?? ILINK_LOGIN_BASE_URL,
      "ilink/bot/get_qrcode_status",
    );
    url.searchParams.set("qrcode", input.qrcode);
    if (input.verifyCode) url.searchParams.set("verify_code", input.verifyCode);
    const requestSignal = createRequestSignal(input.signal, input.timeoutMs ?? 35_000);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: buildCommonHeaders(),
        method: "GET",
        signal: requestSignal.signal,
      });
    } catch (error) {
      if (requestSignal.didTimeout()) return { kind: "waiting" };
      if (input.signal?.aborted) {
        throw new ILinkError({
          cause: error,
          kind: "cancelled",
          message: "pollQr cancelled",
        });
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }
    assertHttpSuccess("pollQr", response);
    const body = await readResponseObject("pollQr", response);
    const status = body.status;
    if (
      status === "scaned_but_redirect" &&
      typeof body.redirect_host === "string" &&
      body.redirect_host.length > 0
    ) {
      return {
        baseUrl: `https://${body.redirect_host}`,
        kind: "redirect",
      };
    }
    if (
      status === "confirmed" &&
      typeof body.bot_token === "string" &&
      body.bot_token.length > 0 &&
      typeof body.ilink_bot_id === "string" &&
      body.ilink_bot_id.length > 0 &&
      typeof body.ilink_user_id === "string" &&
      body.ilink_user_id.length > 0 &&
      (body.baseurl === undefined || typeof body.baseurl === "string")
    ) {
      return {
        kind: "confirmed",
        session: {
          baseUrl: body.baseurl || ILINK_LOGIN_BASE_URL,
          botId: body.ilink_bot_id,
          botToken: body.bot_token,
          controllerUserId: body.ilink_user_id,
        },
      };
    }
    const simpleStatusKinds = {
      binded_redirect: "already-bound",
      expired: "expired",
      need_verifycode: "verify-required",
      scaned: "scanned",
      verify_code_blocked: "verify-blocked",
      wait: "waiting",
    } as const;
    if (typeof status === "string" && status in simpleStatusKinds) {
      const status = body.status as keyof typeof simpleStatusKinds;
      return { kind: simpleStatusKinds[status] };
    }
    throw invalidResponse("pollQr");
  }

  async getUpdates(input: {
    cursor: string;
    session: ILinkSession;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<GetUpdatesResult> {
    const requestSignal = createRequestSignal(input.signal, input.timeoutMs ?? 35_000);
    let response: Response;
    try {
      response = await this.#fetch(
        endpointUrl(input.session.baseUrl, "ilink/bot/getupdates"),
        {
          body: JSON.stringify({
            get_updates_buf: input.cursor,
            base_info: buildBaseInfo(),
          }),
          headers: buildPostHeaders(input.session.botToken),
          method: "POST",
          signal: requestSignal.signal,
        },
      );
    } catch (error) {
      if (requestSignal.didTimeout()) {
        return { cursor: input.cursor, kind: "timeout" };
      }
      if (input.signal?.aborted) {
        throw new ILinkError({
          cause: error,
          kind: "cancelled",
          message: "getUpdates cancelled",
        });
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }
    assertHttpSuccess("getUpdates", response);
    const body = (await readGetUpdatesResponse(response)) as {
      errcode?: number;
      errmsg?: string;
      get_updates_buf?: string;
      longpolling_timeout_ms?: number;
      msgs?: WireWeixinMessage[];
      ret?: number;
    };
    assertApiSuccess("getUpdates", body);
    return {
      cursor: body.get_updates_buf || input.cursor,
      kind: "updates",
      messages: body.msgs ?? [],
      ...(body.longpolling_timeout_ms !== undefined &&
      body.longpolling_timeout_ms > 0
        ? { nextPollTimeoutMs: body.longpolling_timeout_ms }
        : {}),
    };
  }

  notifyStart(input: LifecycleInput): Promise<void> {
    return this.#notifyLifecycle("notifyStart", "notifystart", input);
  }

  notifyStop(input: LifecycleInput): Promise<void> {
    return this.#notifyLifecycle("notifyStop", "notifystop", input);
  }

  async #notifyLifecycle(
    operation: "notifyStart" | "notifyStop",
    endpoint: "notifystart" | "notifystop",
    input: LifecycleInput,
  ): Promise<void> {
    const requestSignal = createRequestSignal(input.signal, input.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.#fetch(
        endpointUrl(input.session.baseUrl, `ilink/bot/msg/${endpoint}`),
        {
          body: JSON.stringify({ base_info: buildBaseInfo() }),
          headers: buildPostHeaders(input.session.botToken),
          method: "POST",
          signal: requestSignal.signal,
        },
      );
    } finally {
      requestSignal.cleanup();
    }
    assertHttpSuccess(operation, response);
    const body = await readResponseObject(operation, response);
    assertApiSuccess(operation, body);
  }

  sendText(input: SendTextInput): Promise<SendTextResult> {
    const identity: SendTextIdentity = {
      contextToken: input.contextToken,
      targetUserId: input.session.controllerUserId,
      text: input.text,
    };
    const existing = this.#sendTextFlights.get(input.clientId);
    if (existing) {
      if (!sameSendTextIdentity(existing.identity, identity)) {
        return Promise.reject(sendTextClientIdCollision(input.clientId));
      }
      return existing.promise;
    }

    const promise = this.#dispatchText(input);
    this.#sendTextFlights.set(input.clientId, { identity, promise });
    const clearFlight = () => {
      if (this.#sendTextFlights.get(input.clientId)?.promise === promise) {
        this.#sendTextFlights.delete(input.clientId);
      }
    };
    void promise.then(clearFlight, clearFlight);
    return promise;
  }

  async #dispatchText(input: SendTextInput): Promise<SendTextResult> {
    if (input.signal?.aborted) {
      throw new ILinkError({
        kind: "cancelled",
        message: "sendText cancelled before dispatch",
      });
    }
    const requestSignal = createRequestSignal(input.signal, input.timeoutMs ?? 15_000);
    let response: Response;
    try {
      response = await this.#fetch(
        endpointUrl(input.session.baseUrl, "ilink/bot/sendmessage"),
        {
          body: JSON.stringify({
            msg: {
              from_user_id: "",
              to_user_id: input.session.controllerUserId,
              client_id: input.clientId,
              message_type: 2,
              message_state: 2,
              item_list: [
                {
                  type: 1,
                  text_item: { text: input.text.replace(/\r?\n/gu, "\r\n") },
                },
              ],
              context_token: input.contextToken,
            },
            base_info: buildBaseInfo(),
          }),
          headers: buildPostHeaders(input.session.botToken),
          method: "POST",
          signal: requestSignal.signal,
        },
      );
    } catch (error) {
      throw deliveryUnknown(input.clientId, error);
    } finally {
      requestSignal.cleanup();
    }
    assertHttpSuccess("sendText", response);
    let body: { errcode?: number; errmsg?: string; ret?: number };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw deliveryUnknown(input.clientId, error);
    }
    assertApiSuccess("sendText", body);
    return { accepted: true, clientId: input.clientId };
  }
}

function sameSendTextIdentity(
  left: SendTextIdentity,
  right: SendTextIdentity,
): boolean {
  return (
    left.targetUserId === right.targetUserId &&
    left.contextToken === right.contextToken &&
    left.text === right.text
  );
}

function sendTextClientIdCollision(clientId: string): Error {
  return new ILinkClientIdCollisionError(clientId);
}

function buildBaseInfo(): { bot_agent: string; channel_version: string } {
  return {
    bot_agent: ILINK_BOT_AGENT,
    channel_version: ILINK_CHANNEL_VERSION,
  };
}

function assertApiSuccess(
  operation: string,
  body: { errcode?: number; errmsg?: string; ret?: number },
): void {
  if ((body.ret ?? 0) === 0 && (body.errcode ?? 0) === 0) return;
  const kind = body.ret === -14 || body.errcode === -14 ? "auth-expired" : "api";
  throw new ILinkError({
    ...(body.errcode !== undefined ? { errcode: body.errcode } : {}),
    kind,
    message: `${operation} ret=${body.ret ?? "none"} errcode=${body.errcode ?? "none"}: ${body.errmsg ?? "unknown error"}`,
    ...(body.ret !== undefined ? { ret: body.ret } : {}),
  });
}

function assertHttpSuccess(operation: string, response: Response): void {
  if (response.ok) return;
  throw new ILinkError({
    httpStatus: response.status,
    kind: "http",
    message: `${operation} HTTP ${response.status}`,
  });
}

function invalidResponse(operation: string): ILinkError {
  return new ILinkError({
    kind: "invalid-response",
    message: `${operation} returned an invalid response`,
  });
}

function deliveryUnknown(clientId: string, cause: unknown): ILinkError {
  return new ILinkError({
    cause,
    clientId,
    kind: "delivery-unknown",
    message: `sendText delivery unknown for clientId=${clientId}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readResponseObject(
  operation: string,
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (isRecord(value)) return value;
  } catch (cause) {
    throw new ILinkError({
      cause,
      kind: "invalid-response",
      message: `${operation} returned invalid JSON`,
    });
  }
  throw invalidResponse(operation);
}

async function readGetUpdatesResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (cause) {
    throw new ILinkError({
      cause,
      kind: "invalid-response",
      message: "getUpdates returned an unreadable response",
    });
  }
  try {
    const parseWithSource = JSON.parse as unknown as (
      text: string,
      reviver: (
        this: unknown,
        key: string,
        value: unknown,
        context: { source: string },
      ) => unknown,
    ) => unknown;
    const value = parseWithSource(raw, (key, parsed, context) => {
      if (
        key === "message_id" &&
        typeof parsed === "number" &&
        !Number.isSafeInteger(parsed) &&
        /^\d+$/u.test(context.source)
      ) {
        return context.source;
      }
      return parsed;
    });
    if (isRecord(value)) return value;
  } catch (cause) {
    throw new ILinkError({
      cause,
      kind: "invalid-response",
      message: "getUpdates returned invalid JSON",
    });
  }
  throw invalidResponse("getUpdates");
}

function buildPostHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function endpointUrl(baseUrl: string, endpoint: string): URL {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  cleanup: () => void;
  didTimeout: () => boolean;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    forwardAbort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
    didTimeout: () => timedOut,
    signal: controller.signal,
  };
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}
