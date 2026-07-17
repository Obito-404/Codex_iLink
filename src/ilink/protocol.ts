export const ILINK_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_BOT_TYPE = "3";
export const ILINK_APP_ID = "bot";
export const ILINK_APP_CLIENT_VERSION = "132102";
export const ILINK_CHANNEL_VERSION = "2.4.6";
export const ILINK_BOT_AGENT = "Codex-iLink/0.0.0";
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export type ILinkErrorKind =
  | "api"
  | "auth-expired"
  | "cancelled"
  | "delivery-unknown"
  | "http"
  | "invalid-response";

export class ILinkError extends Error {
  readonly clientId: string | undefined;
  readonly errcode: number | undefined;
  readonly httpStatus: number | undefined;
  readonly kind: ILinkErrorKind;
  readonly ret: number | undefined;

  constructor(input: {
    cause?: unknown;
    clientId?: string;
    errcode?: number;
    httpStatus?: number;
    kind: ILinkErrorKind;
    message: string;
    ret?: number;
  }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "ILinkError";
    this.clientId = input.clientId;
    this.errcode = input.errcode;
    this.httpStatus = input.httpStatus;
    this.kind = input.kind;
    this.ret = input.ret;
  }
}

export type ILinkSession = {
  baseUrl: string;
  botId: string;
  botToken: string;
  controllerUserId: string;
};

export type QrChallenge = {
  qrcode: string;
  qrcodeUrl: string;
};

export type QrPollResult =
  | {
      baseUrl: string;
      kind: "redirect";
    }
  | {
      kind: "confirmed";
      session: ILinkSession;
    }
  | {
      kind:
        | "already-bound"
        | "expired"
        | "scanned"
        | "verify-blocked"
        | "verify-required"
        | "waiting";
    };

export const WireMessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

export type WireCdnMedia = {
  aes_key?: string;
  encrypt_query_param?: string;
  encrypt_type?: number;
  full_url?: string;
};

export type WireImageItem = {
  aeskey?: string;
  hd_size?: number;
  media?: WireCdnMedia;
  mid_size?: number;
  thumb_height?: number;
  thumb_media?: WireCdnMedia;
  thumb_size?: number;
  thumb_width?: number;
  url?: string;
};

export type WireVoiceItem = {
  bits_per_sample?: number;
  encode_type?: number;
  media?: WireCdnMedia;
  playtime?: number;
  sample_rate?: number;
  text?: string;
};

export type WireFileItem = {
  file_name?: string;
  len?: string;
  md5?: string;
  media?: WireCdnMedia;
};

export type WireVideoItem = {
  media?: WireCdnMedia;
  play_length?: number;
  thumb_height?: number;
  thumb_media?: WireCdnMedia;
  thumb_size?: number;
  thumb_width?: number;
  video_md5?: string;
  video_size?: number;
};

export type WireRefMessage = {
  message_item?: WireMessageItem;
  title?: string;
};

export type WireMessageItem = {
  create_time_ms?: number;
  file_item?: WireFileItem;
  image_item?: WireImageItem;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: WireRefMessage;
  text_item?: { text?: string };
  type?: number;
  update_time_ms?: number;
  video_item?: WireVideoItem;
  voice_item?: WireVoiceItem;
};

export type WireWeixinMessage = {
  client_id?: string;
  context_token?: string;
  create_time_ms?: number;
  delete_time_ms?: number;
  from_user_id?: string;
  group_id?: string;
  item_list?: WireMessageItem[];
  message_id?: number | string;
  message_state?: number;
  message_type?: number;
  run_id?: string;
  seq?: number;
  session_id?: string;
  to_user_id?: string;
  update_time_ms?: number;
};

export type GetUpdatesResult =
  | {
      cursor: string;
      kind: "updates";
      messages: WireWeixinMessage[];
      nextPollTimeoutMs?: number;
    }
  | {
      cursor: string;
      kind: "timeout";
    };

export type SendTextResult = {
  accepted: true;
  clientId: string;
};

export type SendMessageResult = SendTextResult;
