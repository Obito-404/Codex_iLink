import { statSync } from "node:fs";
import { win32 } from "node:path";

export const OUTBOUND_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

const OUTBOUND_PAYLOAD_PREFIX = "\u001ecodex-ilink-outbound:";

export type OutboundMediaKind = "file" | "image" | "video";

export type LocalOutboundMedia = {
  kind: OutboundMediaKind;
  name: string;
  path: string;
  type: "local-media";
  v: 1;
};

export type PreparedOutboundMedia = {
  aesKeyBase64: string;
  encryptedQueryParam: string;
  kind: OutboundMediaKind;
  name: string;
  plaintextSize: number;
  ciphertextSize: number;
  type: "prepared-media";
  v: 1;
};

export type OutboundPayload =
  | { text: string; type: "text" }
  | LocalOutboundMedia
  | PreparedOutboundMedia;

export function serializeOutboundPayload(
  payload: LocalOutboundMedia | PreparedOutboundMedia,
): string {
  return `${OUTBOUND_PAYLOAD_PREFIX}${JSON.stringify(payload)}`;
}

export function parseOutboundPayload(body: string): OutboundPayload {
  if (!body.startsWith(OUTBOUND_PAYLOAD_PREFIX)) {
    return { text: body, type: "text" };
  }
  let value: unknown;
  try {
    value = JSON.parse(body.slice(OUTBOUND_PAYLOAD_PREFIX.length));
  } catch {
    throw new Error("E_OUTBOUND_PAYLOAD_INVALID");
  }
  if (!isRecord(value) || value.v !== 1 || typeof value.type !== "string") {
    throw new Error("E_OUTBOUND_PAYLOAD_INVALID");
  }
  if (value.type === "local-media") {
    if (
      !isMediaKind(value.kind) ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      typeof value.path !== "string" ||
      !win32.isAbsolute(value.path)
    ) {
      throw new Error("E_OUTBOUND_PAYLOAD_INVALID");
    }
    return {
      kind: value.kind,
      name: value.name,
      path: value.path,
      type: "local-media",
      v: 1,
    };
  }
  if (
    value.type !== "prepared-media" ||
    !isMediaKind(value.kind) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.aesKeyBase64 !== "string" ||
    value.aesKeyBase64.length === 0 ||
    typeof value.encryptedQueryParam !== "string" ||
    value.encryptedQueryParam.length === 0 ||
    !isNonNegativeSafeInteger(value.plaintextSize) ||
    !isNonNegativeSafeInteger(value.ciphertextSize)
  ) {
    throw new Error("E_OUTBOUND_PAYLOAD_INVALID");
  }
  return {
    aesKeyBase64: value.aesKeyBase64,
    ciphertextSize: value.ciphertextSize,
    encryptedQueryParam: value.encryptedQueryParam,
    kind: value.kind,
    name: value.name,
    plaintextSize: value.plaintextSize,
    type: "prepared-media",
    v: 1,
  };
}

export function localOutboundMedia(input: {
  label: string;
  path: string;
}): LocalOutboundMedia {
  const normalizedPath = normalizeWindowsMarkdownPath(input.path);
  if (!win32.isAbsolute(normalizedPath)) {
    throw new Error("E_OUTBOUND_MEDIA_PATH");
  }
  const info = statSync(normalizedPath, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new Error("E_OUTBOUND_MEDIA_NOT_FILE");
  if (info.size > OUTBOUND_MEDIA_MAX_BYTES) {
    throw new Error("E_OUTBOUND_MEDIA_TOO_LARGE");
  }
  const basename = win32.basename(normalizedPath);
  return {
    kind: outboundMediaKind(normalizedPath),
    name: sanitizeMediaName(input.label, basename),
    path: normalizedPath,
    type: "local-media",
    v: 1,
  };
}

export function normalizeWindowsMarkdownPath(path: string): string {
  const trimmed = path.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) {
    return `${trimmed.slice(0, 2)}${trimmed.slice(2).replace(/[\\/]+/gu, "\\")}`;
  }
  return trimmed;
}

export function outboundMediaKind(path: string): OutboundMediaKind {
  const extension = win32.extname(path).toLowerCase();
  if (
    [".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"].includes(
      extension,
    )
  ) {
    return "image";
  }
  if (
    [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"].includes(
      extension,
    )
  ) {
    return "video";
  }
  return "file";
}

function sanitizeMediaName(label: string, fallback: string): string {
  const candidate = win32.basename(label.trim()) || fallback;
  const sanitized = candidate.replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_") || fallback;
  const sourceExtension = win32.extname(fallback);
  if (!sourceExtension) return sanitized.slice(0, 240);
  const preservedExtension = sourceExtension.slice(0, 239);
  const labelHasSourceExtension = sanitized
    .toLowerCase()
    .endsWith(sourceExtension.toLowerCase());
  const stem = labelHasSourceExtension
    ? sanitized.slice(0, -sourceExtension.length)
    : sanitized;
  return `${stem.slice(0, 240 - preservedExtension.length)}${preservedExtension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaKind(value: unknown): value is OutboundMediaKind {
  return value === "file" || value === "image" || value === "video";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
