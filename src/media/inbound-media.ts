import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createWriteStream, type Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  resolve as resolvePath,
} from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  WireMessageItemType,
  type WireCdnMedia,
  type WireMessageItem,
} from "../ilink/protocol.ts";

export const DEFAULT_WEIXIN_CDN_BASE_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_INBOUND_MEDIA_TIMEOUT_MS = 15_000;

const DEFAULT_ALLOWED_CDN_HOSTS = ["novac2c.cdn.weixin.qq.com"] as const;
const DEFAULT_MAX_REDIRECTS = 3;
const HASHED_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/u;
const RANDOM_FILE_PATTERN = /^[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/u;

export type InboundMediaCandidate =
  | {
      aesKeyHex?: string;
      displayName: "image.jpg";
      kind: "image";
      media: WireCdnMedia;
      status: "downloadable";
    }
  | {
      displayName: string;
      kind: "file";
      media: WireCdnMedia;
      status: "downloadable";
    }
  | {
      displayName: "video.mp4";
      kind: "video";
      media: WireCdnMedia;
      status: "downloadable";
    }
  | UnsupportedInboundVoice;

export type UnsupportedInboundVoice = {
  kind: "voice";
  reason: "voice-transcript-missing";
  status: "unsupported";
};

export type StoredInboundMedia = {
  byteLength: number;
  displayName: string;
  kind: "file" | "image" | "video";
  path: string;
  status: "stored";
};

export type InboundMediaResolution = StoredInboundMedia | UnsupportedInboundVoice;

export type InboundMediaErrorCode =
  | "CANCELLED"
  | "DECRYPT_FAILED"
  | "DOWNLOAD_FAILED"
  | "HTTP_ERROR"
  | "INVALID_MEDIA"
  | "REDIRECT_ERROR"
  | "STORE_FAILED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "UNSAFE_STORAGE"
  | "UNTRUSTED_URL";

export class InboundMediaError extends Error {
  readonly code: InboundMediaErrorCode;
  readonly retryable: boolean;

  constructor(
    code: InboundMediaErrorCode,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "InboundMediaError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export type InboundMediaStoreOptions = {
  allowedHosts?: readonly string[];
  cdnBaseUrl?: string;
  fetch?: typeof fetch;
  maxBytes?: number;
  maxRedirects?: number;
  rootDirectory?: string;
  timeoutMs?: number;
};

export function inboundMediaCandidateFromItem(
  item: WireMessageItem,
): InboundMediaCandidate | null {
  if (item.type === WireMessageItemType.IMAGE && item.image_item?.media) {
    return {
      ...(item.image_item.aeskey
        ? { aesKeyHex: item.image_item.aeskey }
        : {}),
      displayName: "image.jpg",
      kind: "image",
      media: item.image_item.media,
      status: "downloadable",
    };
  }
  if (item.type === WireMessageItemType.FILE && item.file_item?.media) {
    return {
      displayName: sanitizeDisplayName(item.file_item.file_name, "file.bin"),
      kind: "file",
      media: item.file_item.media,
      status: "downloadable",
    };
  }
  if (item.type === WireMessageItemType.VIDEO && item.video_item?.media) {
    return {
      displayName: "video.mp4",
      kind: "video",
      media: item.video_item.media,
      status: "downloadable",
    };
  }
  if (
    item.type === WireMessageItemType.VOICE &&
    !item.voice_item?.text?.trim()
  ) {
    return {
      kind: "voice",
      reason: "voice-transcript-missing",
      status: "unsupported",
    };
  }
  return null;
}

export class InboundMediaStore {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #cdnBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;
  readonly #rootDirectory: string;
  readonly #timeoutMs: number;

  constructor(options: InboundMediaStoreOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxBytes = positiveSafeInteger(
      options.maxBytes ?? DEFAULT_INBOUND_MEDIA_MAX_BYTES,
      "maxBytes",
    );
    this.#timeoutMs = positiveSafeInteger(
      options.timeoutMs ?? DEFAULT_INBOUND_MEDIA_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxRedirects = nonNegativeSafeInteger(
      options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      "maxRedirects",
    );
    this.#cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_WEIXIN_CDN_BASE_URL;
    this.#allowedHosts = new Set(
      (options.allowedHosts ?? DEFAULT_ALLOWED_CDN_HOSTS).map((host) =>
        host.toLowerCase(),
      ),
    );
    if (this.#allowedHosts.size === 0) {
      throw new TypeError("allowedHosts must not be empty");
    }
    this.#rootDirectory = resolvePath(
      options.rootDirectory ?? defaultInboundMediaRoot(),
    );
  }

  async resolve(input: {
    candidate: InboundMediaCandidate;
    dedupeKey: string;
    signal?: AbortSignal;
  }): Promise<InboundMediaResolution> {
    if (input.candidate.status === "unsupported") return input.candidate;
    if (!input.dedupeKey) {
      throw new InboundMediaError(
        "INVALID_MEDIA",
        "Inbound media dedupe key is missing",
      );
    }

    const encryptionKey = mediaEncryptionKey(input.candidate);
    const url = this.#mediaUrl(input.candidate.media);
    const request = requestLifetime(input.signal, this.#timeoutMs);
    let targetPath: string | undefined;
    let targetDirectory: string | undefined;
    try {
      const response = await this.#fetchResponse(
        url,
        request.signal,
        request.progress,
      );
      request.pause();
      const transportLimit = encryptionKey
        ? this.#maxBytes + 16
        : this.#maxBytes;
      await rejectOversizedContentLength(response, transportLimit);

      targetDirectory = await this.#messageDirectory(input.dedupeKey);
      const extension = safeExtension(input.candidate.displayName);
      targetPath = join(
        targetDirectory,
        `${randomBytes(16).toString("hex")}${extension}`,
      );
      assertDirectChild(targetDirectory, targetPath, "UNSAFE_STORAGE");

      const byteLength = await streamResponseToFile({
        encryptionKey,
        maxBytes: this.#maxBytes,
        response,
        signal: request.signal,
        targetPath,
        transportLimit,
        onProgress: request.progress,
      });
      return {
        byteLength,
        displayName: input.candidate.displayName,
        kind: input.candidate.kind,
        path: targetPath,
        status: "stored",
      };
    } catch (error) {
      if (targetPath && targetDirectory) {
        await removePartialFile(targetDirectory, targetPath);
        await removeEmptyDirectory(this.#rootDirectory, targetDirectory);
      }
      if (error instanceof InboundMediaError) throw error;
      if (request.didTimeout()) {
        throw new InboundMediaError("TIMEOUT", "Inbound media download timed out", {
          retryable: true,
        });
      }
      if (input.signal?.aborted) {
        throw new InboundMediaError("CANCELLED", "Inbound media download was cancelled");
      }
      throw new InboundMediaError(
        "DOWNLOAD_FAILED",
        "Inbound media download failed",
        { retryable: true },
      );
    } finally {
      request.cleanup();
    }
  }

  async cleanup(dedupeKey: string): Promise<void> {
    if (!dedupeKey) return;
    const directoryName = dedupeDirectoryName(dedupeKey);
    await this.#removeHashedDirectory(directoryName);
  }

  async prune(activeDedupeKeys: ReadonlySet<string>): Promise<number> {
    const activeDirectories = new Set(
      [...activeDedupeKeys].map(dedupeDirectoryName),
    );
    if ((await trustedStorageRoot(this.#rootDirectory)) === null) return 0;

    let entries: Dirent[];
    try {
      entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (isFsError(error, "ENOENT")) return 0;
      throw storageError();
    }

    let removed = 0;
    for (const entry of entries) {
      if (
        !HASHED_DIRECTORY_PATTERN.test(entry.name) ||
        activeDirectories.has(entry.name) ||
        (!entry.isDirectory() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      if (await this.#removeHashedDirectory(entry.name)) removed += 1;
    }
    return removed;
  }

  #mediaUrl(media: WireCdnMedia): URL {
    if (media.full_url) return this.#trustedUrl(media.full_url);
    if (!media.encrypt_query_param) {
      throw new InboundMediaError(
        "INVALID_MEDIA",
        "Inbound media has no CDN reference",
      );
    }

    const base = this.#trustedUrl(this.#cdnBaseUrl);
    const url = new URL(`${base.pathname.replace(/\/$/u, "")}/download`, base);
    url.search = "";
    url.searchParams.set("encrypted_query_param", media.encrypt_query_param);
    return this.#trustedUrl(url);
  }

  #trustedUrl(input: string | URL): URL {
    let url: URL;
    try {
      url = input instanceof URL ? new URL(input) : new URL(input);
    } catch {
      throw untrustedUrlError();
    }
    if (
      url.protocol !== "https:" ||
      (url.port !== "" && url.port !== "443") ||
      url.username !== "" ||
      url.password !== "" ||
      !this.#allowedHosts.has(url.hostname.toLowerCase())
    ) {
      throw untrustedUrlError();
    }
    return url;
  }

  async #fetchResponse(
    initialUrl: URL,
    signal: AbortSignal,
    onProgress: () => void,
  ): Promise<Response> {
    let url = initialUrl;
    for (let redirects = 0; ; redirects += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          redirect: "manual",
          signal,
        });
        onProgress();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new InboundMediaError(
          "DOWNLOAD_FAILED",
          "Inbound media CDN request failed",
          { retryable: true },
        );
      }

      if (!isRedirect(response.status)) {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new InboundMediaError(
            "HTTP_ERROR",
            `Inbound media CDN returned HTTP ${response.status}`,
            { retryable: response.status >= 500 },
          );
        }
        return response;
      }

      if (redirects >= this.#maxRedirects) {
        await response.body?.cancel().catch(() => undefined);
        throw new InboundMediaError(
          "REDIRECT_ERROR",
          "Inbound media CDN redirected too many times",
        );
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new InboundMediaError(
          "REDIRECT_ERROR",
          "Inbound media CDN redirect has no location",
        );
      }
      try {
        url = this.#trustedUrl(new URL(location, url));
      } catch (error) {
        if (error instanceof InboundMediaError) throw error;
        throw untrustedUrlError();
      }
    }
  }

  async #messageDirectory(dedupeKey: string): Promise<string> {
    try {
      await mkdir(this.#rootDirectory, { mode: 0o700, recursive: true });
      const rootRealPath = await trustedStorageRoot(this.#rootDirectory);
      if (rootRealPath === null) throw storageError();
      const directory = join(this.#rootDirectory, dedupeDirectoryName(dedupeKey));
      assertDirectChild(this.#rootDirectory, directory, "UNSAFE_STORAGE");
      await mkdir(directory, { mode: 0o700, recursive: true });
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw storageError();
      const directoryRealPath = await realpath(directory);
      if (dirname(directoryRealPath) !== rootRealPath) throw storageError();
      return directory;
    } catch (error) {
      if (error instanceof InboundMediaError) throw error;
      throw storageError();
    }
  }

  async #removeHashedDirectory(directoryName: string): Promise<boolean> {
    if (!HASHED_DIRECTORY_PATTERN.test(directoryName)) throw storageError();
    const rootRealPath = await trustedStorageRoot(this.#rootDirectory);
    if (rootRealPath === null) return false;

    const target = join(this.#rootDirectory, directoryName);
    assertDirectChild(this.#rootDirectory, target, "UNSAFE_STORAGE");
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (isFsError(error, "ENOENT")) return false;
      throw storageError();
    }

    if (metadata.isSymbolicLink()) {
      await unlink(target).catch(() => {
        throw storageError();
      });
      return true;
    }
    if (!metadata.isDirectory()) return false;

    try {
      const targetRealPath = await realpath(target);
      if (dirname(targetRealPath) !== rootRealPath) throw storageError();
      await rm(target, { force: true, recursive: true });
      return true;
    } catch (error) {
      if (error instanceof InboundMediaError) throw error;
      throw storageError();
    }
  }
}

class ByteLimitTransform extends Transform {
  byteLength = 0;
  readonly #maxBytes: number;
  readonly #onProgress: (() => void) | undefined;

  constructor(maxBytes: number, onProgress?: () => void) {
    super();
    this.#maxBytes = maxBytes;
    this.#onProgress = onProgress;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#onProgress?.();
    this.byteLength += chunk.length;
    if (this.byteLength > this.#maxBytes) {
      callback(new MediaTooLargeError());
      return;
    }
    callback(null, chunk);
  }
}

class MediaTooLargeError extends Error {}

async function streamResponseToFile(input: {
  encryptionKey: Buffer | null;
  maxBytes: number;
  onProgress: () => void;
  response: Response;
  signal: AbortSignal;
  targetPath: string;
  transportLimit: number;
}): Promise<number> {
  const source = input.response.body
    ? Readable.fromWeb(
        input.response.body as unknown as NodeReadableStream<Uint8Array>,
      )
    : Readable.from([]);
  const transportCounter = new ByteLimitTransform(
    input.transportLimit,
    input.onProgress,
  );
  const plaintextCounter = new ByteLimitTransform(input.maxBytes);
  const output = createWriteStream(input.targetPath, {
    flags: "wx",
    mode: 0o600,
  });
  let decryptFailed = false;
  try {
    await waitForWriteStreamOpen(output);
    input.onProgress();
    if (input.encryptionKey) {
      const decipher = createDecipheriv("aes-128-ecb", input.encryptionKey, null);
      decipher.once("error", () => {
        decryptFailed = true;
      });
      await pipeline(
        source,
        transportCounter,
        decipher,
        plaintextCounter,
        output,
        { signal: input.signal },
      );
    } else {
      await pipeline(source, transportCounter, plaintextCounter, output, {
        signal: input.signal,
      });
    }
    return plaintextCounter.byteLength;
  } catch (error) {
    if (error instanceof MediaTooLargeError) {
      throw new InboundMediaError(
        "TOO_LARGE",
        "Inbound media exceeds the configured size limit",
      );
    }
    if (decryptFailed) {
      throw new InboundMediaError(
        "DECRYPT_FAILED",
        "Inbound media AES decryption failed",
      );
    }
    if (isFileSystemFailure(error)) {
      throw new InboundMediaError("STORE_FAILED", "Inbound media could not be stored");
    }
    throw error;
  }
}

async function waitForWriteStreamOpen(
  output: ReturnType<typeof createWriteStream>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      output.off("open", onOpen);
      reject(error);
    };
    const onOpen = () => {
      output.off("error", onError);
      resolve();
    };
    output.once("error", onError);
    output.once("open", onOpen);
  });
}

function mediaEncryptionKey(
  candidate: Exclude<InboundMediaCandidate, UnsupportedInboundVoice>,
): Buffer | null {
  if (candidate.kind === "image" && candidate.aesKeyHex !== undefined) {
    if (!/^[0-9a-fA-F]{32}$/u.test(candidate.aesKeyHex)) throw invalidAesKey();
    return Buffer.from(candidate.aesKeyHex, "hex");
  }
  if (candidate.media.aes_key !== undefined) {
    return parseWireAesKey(candidate.media.aes_key);
  }
  if (candidate.kind === "image") return null;
  throw new InboundMediaError(
    "INVALID_MEDIA",
    "Encrypted inbound media has no AES key",
  );
}

function parseWireAesKey(encoded: string): Buffer {
  if (!isCanonicalBase64(encoded)) throw invalidAesKey();
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/u.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw invalidAesKey();
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function sanitizeDisplayName(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const leaf = value.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const sanitized = leaf
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 128);
  if (!sanitized || sanitized === "." || sanitized === "..") return fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}

function safeExtension(displayName: string): string {
  const extension = extname(displayName).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : ".bin";
}

function dedupeDirectoryName(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex");
}

function defaultInboundMediaRoot(): string {
  return join(
    process.env.LOCALAPPDATA ?? tmpdir(),
    "Codex_iLink",
    "media",
    "inbound",
  );
}

function requestLifetime(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  cleanup: () => void;
  didTimeout: () => boolean;
  pause: () => void;
  progress: () => void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pauseTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const onAbort = () => {
    pauseTimeout();
    controller.abort(externalSignal?.reason);
  };
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Timed out", "TimeoutError"));
    }, timeoutMs);
    // The request promise depends on this timer firing, so it must keep the
    // process alive until the request progresses, completes, or times out.
  };
  if (externalSignal?.aborted) {
    onAbort();
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    armTimeout();
  }
  return {
    cleanup: () => {
      pauseTimeout();
      externalSignal?.removeEventListener("abort", onAbort);
    },
    didTimeout: () => timedOut,
    pause: pauseTimeout,
    progress: () => {
      if (!controller.signal.aborted) armTimeout();
    },
    signal: controller.signal,
  };
}

async function rejectOversizedContentLength(
  response: Response,
  maxBytes: number,
): Promise<void> {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) return;
  const length = BigInt(value);
  if (length <= BigInt(maxBytes)) return;
  await response.body?.cancel().catch(() => undefined);
  throw new InboundMediaError(
    "TOO_LARGE",
    "Inbound media exceeds the configured size limit",
  );
}

async function removePartialFile(directory: string, path: string): Promise<void> {
  assertDirectChild(directory, path, "UNSAFE_STORAGE");
  if (!RANDOM_FILE_PATTERN.test(basename(path))) throw storageError();
  await unlink(path).catch((error: unknown) => {
    if (!isFsError(error, "ENOENT")) throw storageError();
  });
}

async function removeEmptyDirectory(root: string, directory: string): Promise<void> {
  assertDirectChild(root, directory, "UNSAFE_STORAGE");
  if (!HASHED_DIRECTORY_PATTERN.test(basename(directory))) throw storageError();
  await rmdir(directory).catch((error: unknown) => {
    if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTEMPTY")) {
      throw storageError();
    }
  });
}

function assertDirectChild(
  parent: string,
  child: string,
  code: InboundMediaErrorCode,
): void {
  if (dirname(resolvePath(child)) !== resolvePath(parent)) {
    throw new InboundMediaError(code, "Inbound media storage path is unsafe");
  }
}

function sameStoragePath(left: string, right: string): boolean {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function trustedStorageRoot(root: string): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw storageError();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw storageError();
  let realPath: string;
  try {
    realPath = await realpath(root);
  } catch {
    throw storageError();
  }
  // Windows may expose the same directory through an 8.3 alias. Reject linked
  // components explicitly, then verify that the canonical target stayed stable.
  await assertNoSymbolicLinkComponents(root);
  let verifiedRealPath: string;
  try {
    verifiedRealPath = await realpath(root);
  } catch {
    throw storageError();
  }
  if (!sameStoragePath(verifiedRealPath, realPath)) throw storageError();
  return verifiedRealPath;
}

async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  let current = resolvePath(path);
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      throw storageError();
    }
    if (metadata.isSymbolicLink()) throw storageError();
    const parent = dirname(current);
    if (sameStoragePath(parent, current)) return;
    current = parent;
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isFsError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isFileSystemFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    /^E[A-Z]+$/u.test((error as NodeJS.ErrnoException).code ?? "")
  );
}

function invalidAesKey(): InboundMediaError {
  return new InboundMediaError("INVALID_MEDIA", "Inbound media AES key is invalid");
}

function untrustedUrlError(): InboundMediaError {
  return new InboundMediaError(
    "UNTRUSTED_URL",
    "Inbound media URL is not an allowed WeChat HTTPS CDN target",
  );
}

function storageError(): InboundMediaError {
  return new InboundMediaError(
    "UNSAFE_STORAGE",
    "Inbound media storage path is unsafe",
  );
}
