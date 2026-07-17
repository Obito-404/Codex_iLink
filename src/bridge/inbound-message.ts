import {
  WireMessageItemType,
  type WireCdnMedia,
  type WireMessageItem,
  type WireWeixinMessage,
} from "../ilink/protocol.ts";
import {
  inboundMediaCandidateFromItem,
  type InboundMediaCandidate,
} from "../media/inbound-media.ts";

export type ParsedControllerMessage =
  | { kind: "ignored" }
  | {
      contextToken: string;
      hasUnsupportedMedia?: true;
      kind: "text";
      mediaCandidates?: readonly InboundMediaCandidate[];
      messageId: string;
      receivedAtMs: number;
      text: string;
    }
  | {
      contextToken: string;
      kind: "unsupportedMedia";
      mediaCandidates?: readonly InboundMediaCandidate[];
      messageId: string;
    };

export function parseControllerMessage(
  message: WireWeixinMessage,
  controllerUserId: string,
): ParsedControllerMessage {
  const messageId = stableMessageId(message.message_id);
  if (
    message.from_user_id !== controllerUserId ||
    (typeof message.group_id === "string" && message.group_id.length > 0) ||
    messageId === null ||
    typeof message.context_token !== "string" ||
    message.context_token.length === 0
  ) {
    return { kind: "ignored" };
  }

  let hasUnsupportedMedia = false;
  let text = "";
  for (const item of message.item_list ?? []) {
    if (item.type === WireMessageItemType.TEXT) {
      if (typeof item.text_item?.text === "string") {
        text += item.text_item.text;
      } else {
        hasUnsupportedMedia = true;
      }
      continue;
    }

    if (
      item.type === WireMessageItemType.VOICE &&
      typeof item.voice_item?.text === "string" &&
      item.voice_item.text.trim()
    ) {
      if (text.trim()) text += "\n";
      text += item.voice_item.text;
      continue;
    }

    if (!isMediaItem(item)) hasUnsupportedMedia = true;
  }

  const mainMediaItem = selectMainMediaItem(message.item_list ?? []);
  const referencedMediaItem = mainMediaItem
    ? undefined
    : selectReferencedMediaItem(message.item_list ?? []);
  const selectedMediaItem = mainMediaItem ?? referencedMediaItem;
  const selectedCandidate = selectedMediaItem
    ? inboundMediaCandidateFromItem(selectedMediaItem)
    : null;
  const mediaCandidates: InboundMediaCandidate[] = selectedCandidate
    ? [selectedCandidate]
    : [];

  const referencedVoiceText = referencedMediaItem?.voice_item?.text?.trim();
  if (referencedVoiceText) {
    text = text.trim()
      ? `[引用语音转写]\n${referencedVoiceText}\n${text}`
      : referencedVoiceText;
  } else if (
    selectedMediaItem &&
    !selectedCandidate
  ) {
    hasUnsupportedMedia = true;
  } else if (
    !selectedMediaItem &&
    (message.item_list ?? []).some(
      (item) =>
        isMediaItem(item) &&
        !(
          item.type === WireMessageItemType.VOICE &&
          item.voice_item?.text?.trim()
        ),
    )
  ) {
    hasUnsupportedMedia = true;
  }
  text = text.trim();

  if (
    !text &&
    ((hasUnsupportedMedia && mediaCandidates.length === 0) ||
      (mediaCandidates.length > 0 &&
        mediaCandidates.every(
          (candidate) => candidate.status === "unsupported",
        )))
  ) {
    return {
      contextToken: message.context_token,
      kind: "unsupportedMedia",
      ...(mediaCandidates.length > 0 ? { mediaCandidates } : {}),
      messageId,
    };
  }

  if (!text && mediaCandidates.length === 0) return { kind: "ignored" };

  return {
    contextToken: message.context_token,
    ...(hasUnsupportedMedia ? { hasUnsupportedMedia: true } : {}),
    kind: "text",
    ...(mediaCandidates.length > 0 ? { mediaCandidates } : {}),
    messageId,
    receivedAtMs:
      Number.isSafeInteger(message.create_time_ms) &&
      (message.create_time_ms ?? -1) >= 0
        ? (message.create_time_ms ?? 0)
        : 0,
    text,
  };
}

const MEDIA_PRIORITY = [
  WireMessageItemType.IMAGE,
  WireMessageItemType.VIDEO,
  WireMessageItemType.FILE,
  WireMessageItemType.VOICE,
] as const;

function selectMainMediaItem(
  items: readonly WireMessageItem[],
): WireMessageItem | undefined {
  for (const type of MEDIA_PRIORITY) {
    const item = items.find(
      (candidate) =>
        candidate.type === type &&
        !(
          type === WireMessageItemType.VOICE &&
          candidate.voice_item?.text?.trim()
        ) &&
        hasDownloadReference(mediaFromItem(candidate)),
    );
    if (item) return item;
  }
  return undefined;
}

function selectReferencedMediaItem(
  items: readonly WireMessageItem[],
): WireMessageItem | undefined {
  return items.find(
    (item) =>
      item.type === WireMessageItemType.TEXT &&
      item.ref_msg?.message_item &&
      isMediaItem(item.ref_msg.message_item),
  )?.ref_msg?.message_item;
}

function isMediaItem(item: WireMessageItem): boolean {
  return (
    item.type === WireMessageItemType.IMAGE ||
    item.type === WireMessageItemType.VIDEO ||
    item.type === WireMessageItemType.FILE ||
    item.type === WireMessageItemType.VOICE
  );
}

function mediaFromItem(item: WireMessageItem): WireCdnMedia | undefined {
  switch (item.type) {
    case WireMessageItemType.IMAGE:
      return item.image_item?.media;
    case WireMessageItemType.VIDEO:
      return item.video_item?.media;
    case WireMessageItemType.FILE:
      return item.file_item?.media;
    case WireMessageItemType.VOICE:
      return item.voice_item?.media;
    default:
      return undefined;
  }
}

function hasDownloadReference(media: WireCdnMedia | undefined): boolean {
  return Boolean(media?.encrypt_query_param || media?.full_url);
}

const MAX_UINT64 = 18_446_744_073_709_551_615n;

function stableMessageId(value: number | string | undefined): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,19})$/u.test(value)) {
    return null;
  }
  return BigInt(value) <= MAX_UINT64 ? value : null;
}
