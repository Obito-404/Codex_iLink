import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { win32 } from "node:path";

export const OUTBOUND_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

const OUTBOUND_PAYLOAD_PREFIX = "\u001ecodex-ilink-outbound:";
const OUTBOUND_SNAPSHOT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-([0-9a-f]{64})(?:\.[^.\\]+)?$/iu;

export type OutboundMediaKind = "file" | "image" | "video";

export type LocalOutboundMedia = {
  kind: OutboundMediaKind;
  name: string;
  path: string;
  staged?: true;
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

export type StagedOutboundMediaRead = {
  media: LocalOutboundMedia;
  plaintext: Buffer;
};

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
      !win32.isAbsolute(value.path) ||
      (value.staged !== undefined && value.staged !== true)
    ) {
      throw new Error("E_OUTBOUND_PAYLOAD_INVALID");
    }
    return {
      kind: value.kind,
      name: value.name,
      path: value.path,
      ...(value.staged === true ? { staged: true as const } : {}),
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
  const normalizedPath = win32.normalize(
    normalizeWindowsMarkdownPath(input.path),
  );
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

export function stageOutboundMedia(input: {
  exportRoot: string;
  label: string;
  path: string;
  workspaceRoot: string;
}): LocalOutboundMedia {
  const workspacePath = safeLocalWindowsPath(input.workspaceRoot);
  const sourceInputPath = safeLocalWindowsPath(input.path);
  if (!isWindowsPathInside(sourceInputPath, workspacePath)) {
    throw new Error("E_OUTBOUND_MEDIA_OUTSIDE_WORKSPACE");
  }
  assertNoLinkedChild(workspacePath, sourceInputPath);
  const workspaceRoot = realpathSync.native(workspacePath);
  const sourcePath = realpathSync.native(sourceInputPath);
  if (!isWindowsPathInside(sourcePath, workspaceRoot)) {
    throw new Error("E_OUTBOUND_MEDIA_OUTSIDE_WORKSPACE");
  }

  const exportPath = safeLocalWindowsPath(input.exportRoot);
  mkdirSync(exportPath, { recursive: true });
  if (lstatSync(exportPath).isSymbolicLink()) {
    throw new Error("E_OUTBOUND_MEDIA_LINK");
  }
  const exportRoot = realpathSync.native(exportPath);
  if (isWindowsPathInside(exportRoot, workspaceRoot)) {
    throw new Error("E_OUTBOUND_MEDIA_EXPORT_ROOT");
  }

  let destinationDescriptor: number | undefined;
  let destinationPath: string | undefined;
  try {
    const bytes = readStableFile(sourcePath, workspaceRoot);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    destinationPath = win32.join(
      exportRoot,
      `${randomUUID()}-${sha256}${win32.extname(sourcePath)}`,
    );
    destinationDescriptor = openSync(destinationPath, "wx", 0o600);
    writeFileSync(destinationDescriptor, bytes);
    fsyncSync(destinationDescriptor);
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    return stagedOutboundMedia({
      exportRoot,
      label: input.label,
      path: destinationPath,
    });
  } catch (error) {
    if (destinationPath) {
      try {
        unlinkSync(destinationPath);
      } catch {
        // A never-published partial snapshot can be retried with a fresh name.
      }
    }
    throw error;
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
  }
}

export function stagedOutboundMedia(input: {
  exportRoot: string;
  label: string;
  path: string;
}): LocalOutboundMedia {
  const exportRoot = realpathSync.native(safeLocalWindowsPath(input.exportRoot));
  const candidate = safeLocalWindowsPath(input.path);
  if (!OUTBOUND_SNAPSHOT_NAME.test(win32.basename(candidate))) {
    throw new Error("E_OUTBOUND_MEDIA_NOT_STAGED");
  }
  if (!isWindowsPathInside(candidate, exportRoot)) {
    throw new Error("E_OUTBOUND_MEDIA_NOT_STAGED");
  }
  assertNoLinkedChild(exportRoot, candidate);
  const canonicalPath = realpathSync.native(candidate);
  if (!isWindowsPathInside(canonicalPath, exportRoot)) {
    throw new Error("E_OUTBOUND_MEDIA_NOT_STAGED");
  }
  const info = lstatSync(canonicalPath);
  if (info.isSymbolicLink()) throw new Error("E_OUTBOUND_MEDIA_LINK");
  assertStageableFile(info);
  return {
    ...localOutboundMedia({ label: input.label, path: canonicalPath }),
    staged: true,
  };
}

export function readStagedOutboundMedia(input: {
  exportRoot: string;
  label: string;
  path: string;
}): StagedOutboundMediaRead {
  const media = stagedOutboundMedia(input);
  const exportRoot = realpathSync.native(safeLocalWindowsPath(input.exportRoot));
  const expectedHash = OUTBOUND_SNAPSHOT_NAME.exec(win32.basename(media.path))?.[1];
  if (!expectedHash) throw new Error("E_OUTBOUND_MEDIA_NOT_STAGED");
  const plaintext = readStableFile(media.path, exportRoot);
  const actualHash = createHash("sha256").update(plaintext).digest("hex");
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error("E_OUTBOUND_MEDIA_CHANGED");
  }
  return { media, plaintext };
}

export function removeOutboundMediaSnapshot(
  path: string,
  exportRootPath: string,
): boolean {
  try {
    const exportRoot = realpathSync.native(
      safeLocalWindowsPath(exportRootPath),
    );
    const candidate = safeLocalWindowsPath(path);
    const relative = win32.relative(exportRoot, candidate);
    if (
      relative.includes("\\") ||
      !OUTBOUND_SNAPSHOT_NAME.test(relative)
    ) {
      return false;
    }
    const info = lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return false;
    const canonicalPath = realpathSync.native(candidate);
    if (!isWindowsPathInside(canonicalPath, exportRoot)) return false;
    unlinkSync(canonicalPath);
    return true;
  } catch {
    return false;
  }
}

export function pruneOutboundMediaSnapshots(input: {
  exportRoot: string;
  retainedPathKeys: ReadonlySet<string>;
}): number {
  const exportPath = safeLocalWindowsPath(input.exportRoot);
  if (!existsSync(exportPath)) return 0;
  if (lstatSync(exportPath).isSymbolicLink()) {
    throw new Error("E_OUTBOUND_MEDIA_LINK");
  }
  const exportRoot = realpathSync.native(exportPath);
  let removed = 0;
  for (const entry of readdirSync(exportRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !OUTBOUND_SNAPSHOT_NAME.test(entry.name)) continue;
    const path = win32.join(exportRoot, entry.name);
    if (input.retainedPathKeys.has(outboundMediaPathKey(path))) continue;
    if (removeOutboundMediaSnapshot(path, exportRoot)) removed += 1;
  }
  return removed;
}

export function outboundMediaDirectory(inboxDirectory: string): string {
  return win32.join(win32.dirname(inboxDirectory), "Outbound");
}

export function outboundMediaPathKey(path: string): string {
  return win32
    .normalize(normalizeWindowsMarkdownPath(path))
    .toLowerCase();
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

function isWindowsPathInside(path: string, root: string): boolean {
  const relative = win32.relative(root, path);
  return (
    relative === "" ||
    (!relative.startsWith("..\\") &&
      relative !== ".." &&
      !win32.isAbsolute(relative))
  );
}

function safeLocalWindowsPath(path: string): string {
  const normalized = win32.normalize(normalizeWindowsMarkdownPath(path));
  if (
    !/^[A-Za-z]:\\/u.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.slice(2).includes(":")
  ) {
    throw new Error("E_OUTBOUND_MEDIA_PATH");
  }
  return normalized;
}

function assertNoLinkedChild(root: string, path: string): void {
  if (!isWindowsPathInside(path, root)) {
    throw new Error("E_OUTBOUND_MEDIA_OUTSIDE_WORKSPACE");
  }
  const relative = win32.relative(root, path);
  let current = root;
  for (const part of relative === "" ? [] : relative.split("\\")) {
    current = win32.join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("E_OUTBOUND_MEDIA_LINK");
    }
  }
}

function assertStageableFile(info: ReturnType<typeof fstatSync>): void {
  if (!info.isFile()) throw new Error("E_OUTBOUND_MEDIA_NOT_FILE");
  if (info.nlink > 1) throw new Error("E_OUTBOUND_MEDIA_LINK");
  if (info.size > OUTBOUND_MEDIA_MAX_BYTES) {
    throw new Error("E_OUTBOUND_MEDIA_TOO_LARGE");
  }
}

function readStableFile(path: string, root: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const before = fstatSync(descriptor);
    assertStageableFile(before);
    assertNoLinkedChild(root, path);
    const pathInfo = lstatSync(path);
    if (
      pathInfo.isSymbolicLink() ||
      pathInfo.dev !== before.dev ||
      pathInfo.ino !== before.ino
    ) {
      throw new Error("E_OUTBOUND_MEDIA_CHANGED");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("E_OUTBOUND_MEDIA_CHANGED");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
