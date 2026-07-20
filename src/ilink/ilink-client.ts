import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_BOT_AGENT,
  ILINK_BOT_TYPE,
  ILINK_CHANNEL_VERSION,
  ILINK_CDN_BASE_URL,
  ILINK_LOGIN_BASE_URL,
  ILinkError,
  type GetUpdatesResult,
  type ILinkSession,
  type QrChallenge,
  type QrPollResult,
  type SendMessageResult,
  type SendTextResult,
  WireMessageItemType,
  type WireMessageItem,
  type WireWeixinMessage,
} from "./protocol.ts";
import {
  OUTBOUND_MEDIA_MAX_BYTES,
  type LocalOutboundMedia,
  type PreparedOutboundMedia,
} from "../media/outbound-media.ts";

export type ILinkFetch = typeof fetch;

export type ILinkClientOptions = {
  authExpiredCooldownMs?: number;
  fetch?: ILinkFetch;
  now?: () => number;
  onAuthExpired?: (input: {
    botId: string;
    pausedUntilMs: number;
  }) => void;
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

export type SendTypingInput = {
  contextToken: string;
  session: ILinkSession;
  signal?: AbortSignal;
  status: "cancel" | "typing";
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

export type PrepareMediaInput = {
  media: LocalOutboundMedia;
  plaintext?: Uint8Array;
  session: ILinkSession;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type SendMediaInput = {
  clientId: string;
  contextToken: string;
  media: PreparedOutboundMedia;
  session: ILinkSession;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type SendMediaIdentity = {
  contextToken: string;
  media: PreparedOutboundMedia;
  targetUserId: string;
};

type SendMediaFlight = {
  identity: SendMediaIdentity;
  promise: Promise<SendMessageResult>;
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
  readonly #authExpiredCooldownMs: number;
  readonly #authPausedUntilMs = new Map<string, number>();
  readonly #fetch: ILinkFetch;
  readonly #now: () => number;
  readonly #onAuthExpired: ILinkClientOptions["onAuthExpired"];
  readonly #sendMediaFlights = new Map<string, SendMediaFlight>();
  readonly #sendTextFlights = new Map<string, SendTextFlight>();
  readonly #typingTickets = new Map<string, Promise<string | null>>();

  constructor(options: ILinkClientOptions = {}) {
    this.#authExpiredCooldownMs =
      options.authExpiredCooldownMs ?? 60 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.#authExpiredCooldownMs) ||
      this.#authExpiredCooldownMs < 0
    ) {
      throw new Error("E_ILINK_AUTH_EXPIRED_COOLDOWN");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#onAuthExpired = options.onAuthExpired;
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
    this.#assertSessionActive("getUpdates", input.session);
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
    this.#assertApiSuccess("getUpdates", body, input.session);
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
    this.#assertSessionActive(operation, input.session);
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
    this.#assertApiSuccess(operation, body, input.session);
  }

  async sendTyping(input: SendTypingInput): Promise<boolean> {
    this.#assertSessionActive("sendTyping", input.session);
    const ticket = await this.#typingTicket(input);
    if (!ticket) return false;
    this.#assertSessionActive("sendTyping", input.session);

    const requestSignal = createRequestSignal(input.signal, input.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.#fetch(
        endpointUrl(input.session.baseUrl, "ilink/bot/sendtyping"),
        {
          body: JSON.stringify({
            ilink_user_id: input.session.controllerUserId,
            typing_ticket: ticket,
            status: input.status === "typing" ? 1 : 2,
            base_info: buildBaseInfo(),
          }),
          headers: buildPostHeaders(input.session.botToken),
          method: "POST",
          signal: requestSignal.signal,
        },
      );
    } catch (error) {
      if (input.signal?.aborted) {
        throw new ILinkError({
          cause: error,
          kind: "cancelled",
          message: "sendTyping cancelled",
        });
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }
    assertHttpSuccess("sendTyping", response);
    const body = await readResponseObject("sendTyping", response);
    try {
      this.#assertApiSuccess("sendTyping", body, input.session);
    } catch (error) {
      this.#typingTickets.delete(typingTicketKey(input.session));
      throw error;
    }
    return true;
  }

  async #typingTicket(input: SendTypingInput): Promise<string | null> {
    const key = typingTicketKey(input.session);
    const existing = this.#typingTickets.get(key);
    if (existing) return existing;

    const pending = this.#fetchTypingTicket(input);
    this.#typingTickets.set(key, pending);
    try {
      const ticket = await pending;
      if (ticket === null && this.#typingTickets.get(key) === pending) {
        this.#typingTickets.delete(key);
      }
      return ticket;
    } catch (error) {
      if (this.#typingTickets.get(key) === pending) {
        this.#typingTickets.delete(key);
      }
      throw error;
    }
  }

  async #fetchTypingTicket(input: SendTypingInput): Promise<string | null> {
    this.#assertSessionActive("getConfig", input.session);
    const requestSignal = createRequestSignal(input.signal, input.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.#fetch(
        endpointUrl(input.session.baseUrl, "ilink/bot/getconfig"),
        {
          body: JSON.stringify({
            ilink_user_id: input.session.controllerUserId,
            context_token: input.contextToken,
            base_info: buildBaseInfo(),
          }),
          headers: buildPostHeaders(input.session.botToken),
          method: "POST",
          signal: requestSignal.signal,
        },
      );
    } catch (error) {
      if (input.signal?.aborted) {
        throw new ILinkError({
          cause: error,
          kind: "cancelled",
          message: "getConfig cancelled",
        });
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }
    assertHttpSuccess("getConfig", response);
    const body = await readResponseObject("getConfig", response);
    this.#assertApiSuccess("getConfig", body, input.session);
    return typeof body.typing_ticket === "string" && body.typing_ticket.length > 0
      ? body.typing_ticket
      : null;
  }

  async prepareMedia(input: PrepareMediaInput): Promise<PreparedOutboundMedia> {
    this.#assertSessionActive("prepareMedia", input.session);
    if (input.signal?.aborted) {
      throw new ILinkError({
        kind: "cancelled",
        message: "prepareMedia cancelled before upload",
      });
    }
    const plaintext = input.plaintext
      ? Buffer.from(input.plaintext)
      : await readFile(input.media.path);
    if (plaintext.length > OUTBOUND_MEDIA_MAX_BYTES) {
      throw new Error("E_OUTBOUND_MEDIA_TOO_LARGE");
    }
    const aesKey = randomBytes(16);
    const aesKeyHex = aesKey.toString("hex");
    const fileKey = randomBytes(16).toString("hex");
    const cipher = createCipheriv("aes-128-ecb", aesKey, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const uploadRequest = createRequestSignal(
      input.signal,
      input.timeoutMs ?? 30_000,
    );
    let uploadInfo: Record<string, unknown>;
    try {
      this.#assertSessionActive("prepareMedia", input.session);
      const response = await this.#fetch(
        endpointUrl(input.session.baseUrl, "ilink/bot/getuploadurl"),
        {
          body: JSON.stringify({
            filekey: fileKey,
            media_type: uploadMediaType(input.media.kind),
            to_user_id: input.session.controllerUserId,
            rawsize: plaintext.length,
            rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
            filesize: ciphertext.length,
            no_need_thumb: true,
            aeskey: aesKeyHex,
            base_info: buildBaseInfo(),
          }),
          headers: buildPostHeaders(input.session.botToken),
          method: "POST",
          signal: uploadRequest.signal,
        },
      );
      assertHttpSuccess("prepareMedia", response);
      uploadInfo = await readResponseObject("prepareMedia", response);
      this.#assertApiSuccess(
        "prepareMedia",
        uploadInfo as { errcode?: number; errmsg?: string; ret?: number },
        input.session,
      );
    } finally {
      uploadRequest.cleanup();
    }

    const uploadUrl = outboundUploadUrl(uploadInfo, fileKey);
    const cdnRequest = createRequestSignal(
      input.signal,
      input.timeoutMs ?? 30_000,
    );
    let response: Response;
    try {
      response = await this.#fetch(uploadUrl, {
        body: new Uint8Array(ciphertext),
        headers: { "Content-Type": "application/octet-stream" },
        method: "POST",
        redirect: "error",
        signal: cdnRequest.signal,
      });
    } finally {
      cdnRequest.cleanup();
    }
    if (response.status !== 200) {
      throw new ILinkError({
        httpStatus: response.status,
        kind: "http",
        message: `prepareMedia CDN HTTP ${response.status}`,
      });
    }
    const encryptedQueryParam = response.headers.get("x-encrypted-param")?.trim();
    if (!encryptedQueryParam) {
      throw new ILinkError({
        kind: "invalid-response",
        message: "prepareMedia CDN response missing x-encrypted-param",
      });
    }
    return {
      aesKeyBase64: Buffer.from(aesKeyHex, "utf8").toString("base64"),
      ciphertextSize: ciphertext.length,
      encryptedQueryParam,
      kind: input.media.kind,
      name: input.media.name,
      plaintextSize: plaintext.length,
      type: "prepared-media",
      v: 1,
    };
  }

  sendMedia(input: SendMediaInput): Promise<SendMessageResult> {
    if (input.signal?.aborted) {
      return Promise.reject(
        new ILinkError({
          kind: "cancelled",
          message: "sendMedia cancelled before dispatch",
        }),
      );
    }
    const identity: SendMediaIdentity = {
      contextToken: input.contextToken,
      media: input.media,
      targetUserId: input.session.controllerUserId,
    };
    const existing = this.#sendMediaFlights.get(input.clientId);
    if (existing) {
      if (JSON.stringify(existing.identity) !== JSON.stringify(identity)) {
        return Promise.reject(sendTextClientIdCollision(input.clientId));
      }
      return existing.promise;
    }
    const promise = this.#dispatchMedia(input);
    this.#sendMediaFlights.set(input.clientId, { identity, promise });
    const clearFlight = () => {
      if (this.#sendMediaFlights.get(input.clientId)?.promise === promise) {
        this.#sendMediaFlights.delete(input.clientId);
      }
    };
    void promise.then(clearFlight, clearFlight);
    return promise;
  }

  async #dispatchMedia(input: SendMediaInput): Promise<SendMessageResult> {
    return this.#dispatchItem({
      clientId: input.clientId,
      contextToken: input.contextToken,
      item: mediaWireItem(input.media),
      operation: "sendMedia",
      session: input.session,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
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
    return this.#dispatchItem({
      clientId: input.clientId,
      contextToken: input.contextToken,
      item: {
        type: WireMessageItemType.TEXT,
        text_item: { text: input.text.replace(/\r?\n/gu, "\r\n") },
      },
      operation: "sendText",
      session: input.session,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  }

  async #dispatchItem(input: {
    clientId: string;
    contextToken: string;
    item: WireMessageItem;
    operation: "sendMedia" | "sendText";
    session: ILinkSession;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<SendMessageResult> {
    this.#assertSessionActive(input.operation, input.session);
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
              item_list: [input.item],
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
    assertHttpSuccess(input.operation, response);
    let body: { errcode?: number; errmsg?: string; ret?: number };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw deliveryUnknown(input.clientId, error);
    }
    this.#assertApiSuccess(input.operation, body, input.session);
    return { accepted: true, clientId: input.clientId };
  }

  authPausedUntil(session: Pick<ILinkSession, "botId">): number | null {
    const pausedUntilMs = this.#authPausedUntilMs.get(session.botId);
    if (pausedUntilMs === undefined) return null;
    if (pausedUntilMs <= this.#now()) {
      this.#authPausedUntilMs.delete(session.botId);
      return null;
    }
    return pausedUntilMs;
  }

  #assertSessionActive(operation: string, session: ILinkSession): void {
    const pausedUntilMs = this.authPausedUntil(session);
    if (pausedUntilMs === null) return;
    throw new ILinkError({
      kind: "auth-expired",
      message: `${operation} paused after expired authentication`,
    });
  }

  #assertApiSuccess(
    operation: string,
    body: { errcode?: number; errmsg?: string; ret?: number },
    session: ILinkSession,
  ): void {
    try {
      assertApiSuccess(operation, body);
    } catch (error) {
      if (error instanceof ILinkError && error.kind === "auth-expired") {
        const pausedUntilMs = this.#now() + this.#authExpiredCooldownMs;
        this.#authPausedUntilMs.set(session.botId, pausedUntilMs);
        try {
          this.#onAuthExpired?.({ botId: session.botId, pausedUntilMs });
        } catch {
          // Observability must not replace the authentication error.
        }
      }
      throw error;
    }
  }
}

function typingTicketKey(session: ILinkSession): string {
  return `${session.baseUrl}\u0000${session.botId}\u0000${session.controllerUserId}`;
}

function uploadMediaType(kind: LocalOutboundMedia["kind"]): number {
  if (kind === "image") return 1;
  if (kind === "video") return 2;
  return 3;
}

function outboundUploadUrl(
  response: Record<string, unknown>,
  fileKey: string,
): URL {
  const fullUrl =
    typeof response.upload_full_url === "string"
      ? response.upload_full_url.trim()
      : "";
  const url = fullUrl
    ? new URL(fullUrl)
    : typeof response.upload_param === "string" && response.upload_param.length > 0
      ? new URL(
          `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(fileKey)}`,
        )
      : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.hostname !== "novac2c.cdn.weixin.qq.com" &&
      !url.hostname.endsWith(".cdn.weixin.qq.com"))
  ) {
    throw new ILinkError({
      kind: "invalid-response",
      message: "prepareMedia returned an invalid CDN upload URL",
    });
  }
  return url;
}

function mediaWireItem(media: PreparedOutboundMedia): WireMessageItem {
  const cdn = {
    aes_key: media.aesKeyBase64,
    encrypt_query_param: media.encryptedQueryParam,
    encrypt_type: 1,
  };
  if (media.kind === "image") {
    return {
      image_item: { media: cdn, mid_size: media.ciphertextSize },
      type: WireMessageItemType.IMAGE,
    };
  }
  if (media.kind === "video") {
    return {
      type: WireMessageItemType.VIDEO,
      video_item: { media: cdn, video_size: media.ciphertextSize },
    };
  }
  return {
    file_item: {
      file_name: media.name,
      len: String(media.plaintextSize),
      media: cdn,
    },
    type: WireMessageItemType.FILE,
  };
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
