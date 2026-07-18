import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_WEIXIN_CDN_BASE_URL,
  InboundMediaError,
  InboundMediaStore,
  inboundMediaCandidateFromItem,
  type InboundMediaResolution,
  type StoredInboundMedia,
} from "../src/media/inbound-media.ts";

function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function chunkedResponse(
  body: Buffer,
  input: { chunkSize?: number; headers?: HeadersInit; status?: number } = {},
): Response {
  const chunkSize = input.chunkSize ?? (body.length || 1);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, body.length);
        controller.enqueue(body.subarray(offset, end));
        offset = end;
      },
    }),
    {
      ...(input.headers ? { headers: input.headers } : {}),
      status: input.status ?? 200,
    },
  );
}

function fixture(
  t: TestContext,
  fetchImpl: typeof fetch,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): { root: string; store: InboundMediaStore } {
  const root = mkdtempSync(join(tmpdir(), "codex-ilink-inbound-media-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return {
    root,
    store: new InboundMediaStore({
      fetch: fetchImpl,
      maxBytes: options.maxBytes ?? 1024,
      rootDirectory: root,
      timeoutMs: options.timeoutMs ?? 1_000,
    }),
  };
}

function assertMediaError(
  code: InboundMediaError["code"],
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof InboundMediaError);
    assert.equal(error.code, code);
    return true;
  };
}

function assertStored(
  result: InboundMediaResolution,
): asserts result is StoredInboundMedia {
  assert.equal(result.status, "stored");
}

test("downloads and decrypts a file through the official CDN fallback", async (t) => {
  const key = randomBytes(16);
  const plaintext = Buffer.from("media payload");
  const ciphertext = encrypt(plaintext, key);
  let requestedUrl = "";
  const { root, store } = fixture(t, async (input) => {
    requestedUrl = String(input);
    return chunkedResponse(ciphertext, { chunkSize: 3 });
  });
  const candidate = inboundMediaCandidateFromItem({
    file_item: {
      file_name: "../../报告?.txt",
      media: {
        aes_key: Buffer.from(key.toString("hex"), "ascii").toString("base64"),
        encrypt_query_param: "opaque/value&scope=one",
      },
    },
    type: 4,
  });

  assert.ok(candidate);
  const result = await store.resolve({
    candidate,
    dedupeKey: "bot/controller/42",
  });
  assertStored(result);

  assert.equal(
    requestedUrl,
    `${DEFAULT_WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=opaque%2Fvalue%26scope%3Done`,
  );
  assert.deepEqual(
    {
      byteLength: result.byteLength,
      displayName: result.displayName,
      kind: result.kind,
      status: result.status,
    },
    {
      byteLength: plaintext.length,
      displayName: "报告_.txt",
      kind: "file",
      status: "stored",
    },
  );
  assert.deepEqual(readFileSync(result.path), plaintext);
  const expectedDirectory = createHash("sha256")
    .update("bot/controller/42")
    .digest("hex");
  assert.equal(dirname(result.path), join(root, expectedDirectory));
  assert.match(basename(result.path), /^[0-9a-f]{32}\.txt$/u);
  assert.doesNotMatch(result.path, /报告/u);
});

test("prefers the image hex key and full URL, then stores a random image name", async (t) => {
  const key = randomBytes(16);
  const wrongKey = randomBytes(16);
  const plaintext = Buffer.from("not-a-real-jpeg-but-valid-transport");
  const ciphertext = encrypt(plaintext, key);
  let requestedUrl = "";
  const { store } = fixture(t, async (input) => {
    requestedUrl = String(input);
    return chunkedResponse(ciphertext);
  });
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      aeskey: key.toString("hex"),
      media: {
        aes_key: wrongKey.toString("base64"),
        encrypt_query_param: "must-not-be-used",
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/object?id=secret",
      },
    },
    type: 2,
  });

  assert.ok(candidate);
  const result = await store.resolve({ candidate, dedupeKey: "image-1" });
  assertStored(result);

  assert.equal(
    requestedUrl,
    "https://novac2c.cdn.weixin.qq.com/c2c/object?id=secret",
  );
  assert.equal(result.status, "stored");
  assert.equal(result.kind, "image");
  assert.equal(result.displayName, "image.jpg");
  assert.match(result.path, /[0-9a-f]{32}\.jpg$/u);
  assert.deepEqual(readFileSync(result.path), plaintext);
});

test("allows an unencrypted image but requires AES for files and videos", async (t) => {
  let fetchCalls = 0;
  const { store } = fixture(t, async () => {
    fetchCalls += 1;
    return new Response(Buffer.from("plain image"));
  });
  const image = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/plain" },
    },
    type: 2,
  });
  const file = inboundMediaCandidateFromItem({
    file_item: {
      file_name: "notes.txt",
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/file" },
    },
    type: 4,
  });
  assert.ok(image);
  assert.ok(file);

  const imageResult = await store.resolve({ candidate: image, dedupeKey: "plain" });
  assertStored(imageResult);
  assert.deepEqual(readFileSync(imageResult.path), Buffer.from("plain image"));
  await assert.rejects(
    store.resolve({ candidate: file, dedupeKey: "missing-key" }),
    assertMediaError("INVALID_MEDIA"),
  );
  assert.equal(fetchCalls, 1);
});

test("decrypts video media with a raw base64 AES key", async (t) => {
  const key = randomBytes(16);
  const plaintext = Buffer.from("video bytes");
  const { store } = fixture(
    t,
    async () => new Response(new Uint8Array(encrypt(plaintext, key))),
  );
  const candidate = inboundMediaCandidateFromItem({
    type: 5,
    video_item: {
      media: {
        aes_key: key.toString("base64"),
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/video",
      },
    },
  });

  assert.ok(candidate);
  const result = await store.resolve({ candidate, dedupeKey: "video" });
  assertStored(result);

  assert.equal(result.kind, "video");
  assert.equal(result.displayName, "video.mp4");
  assert.deepEqual(readFileSync(result.path), plaintext);
});

test("marks voice without a transcript unsupported and never downloads it", async (t) => {
  let fetchCalls = 0;
  const { root, store } = fixture(t, async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  });
  const candidate = inboundMediaCandidateFromItem({
    type: 3,
    voice_item: {
      media: {
        aes_key: randomBytes(16).toString("base64"),
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice",
      },
    },
  });

  assert.deepEqual(candidate, {
    kind: "voice",
    reason: "voice-transcript-missing",
    status: "unsupported",
  });
  assert.ok(candidate);
  assert.deepEqual(
    await store.resolve({ candidate, dedupeKey: "voice" }),
    candidate,
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(readdirSync(root), []);
});

test("rejects non-HTTPS and non-WeChat CDN URLs before fetching", async (t) => {
  let fetchCalls = 0;
  const { store } = fixture(t, async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  });

  for (const fullUrl of [
    "http://novac2c.cdn.weixin.qq.com/c2c/file",
    "https://127.0.0.1/private",
    "https://novac2c.cdn.weixin.qq.com.evil.example/private",
    "https://novac2c.cdn.weixin.qq.com:8443/private",
  ]) {
    const candidate = inboundMediaCandidateFromItem({
      image_item: { media: { full_url: fullUrl } },
      type: 2,
    });
    assert.ok(candidate);
    await assert.rejects(
      store.resolve({ candidate, dedupeKey: fullUrl }),
      assertMediaError("UNTRUSTED_URL"),
    );
  }
  assert.equal(fetchCalls, 0);
});

test("rejects a junction media root before storing outside it", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codex-ilink-media-root-parent-"));
  const target = mkdtempSync(join(tmpdir(), "codex-ilink-media-root-target-"));
  const root = join(parent, "inbound");
  symlinkSync(target, root, "junction");
  t.after(() => {
    try {
      unlinkSync(root);
    } catch {}
    rmSync(parent, { force: true, recursive: true });
    rmSync(target, { force: true, recursive: true });
  });
  const store = new InboundMediaStore({
    fetch: async () => new Response("image"),
    rootDirectory: root,
  });
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image" },
    },
    type: 2,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "junction-root" }),
    assertMediaError("UNSAFE_STORAGE"),
  );
  assert.deepEqual(readdirSync(target), []);
});

test("prune refuses to cross a junction media root", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codex-ilink-prune-root-parent-"));
  const target = mkdtempSync(join(tmpdir(), "codex-ilink-prune-root-target-"));
  const root = join(parent, "inbound");
  const sentinel = join(target, "keep.txt");
  writeFileSync(sentinel, "keep");
  symlinkSync(target, root, "junction");
  t.after(() => {
    try {
      unlinkSync(root);
    } catch {}
    rmSync(parent, { force: true, recursive: true });
    rmSync(target, { force: true, recursive: true });
  });
  const store = new InboundMediaStore({ rootDirectory: root });

  await assert.rejects(store.prune(new Set()), assertMediaError("UNSAFE_STORAGE"));
  assert.equal(existsSync(sentinel), true);
});

test("revalidates every redirect target against the CDN allowlist", async (t) => {
  const requests: string[] = [];
  const { store } = fixture(t, async (input) => {
    requests.push(String(input));
    return new Response(null, {
      headers: { location: "https://localhost/private?credential=hidden" },
      status: 302,
    });
  });
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/redirect" },
    },
    type: 2,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "redirect" }),
    assertMediaError("UNTRUSTED_URL"),
  );
  assert.deepEqual(requests, [
    "https://novac2c.cdn.weixin.qq.com/c2c/redirect",
  ]);
});

test("enforces Content-Length and chunked streaming limits without a partial file", async (t) => {
  let call = 0;
  const { root, store } = fixture(
    t,
    async () => {
      call += 1;
      return call === 1
        ? new Response("", { headers: { "content-length": "9" } })
        : chunkedResponse(Buffer.from("123456789"), { chunkSize: 2 });
    },
    { maxBytes: 8 },
  );
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/large" },
    },
    type: 2,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "length" }),
    assertMediaError("TOO_LARGE"),
  );
  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "chunked" }),
    assertMediaError("TOO_LARGE"),
  );
  assert.deepEqual(readdirSync(root, { recursive: true }), []);
});

test("enforces the plaintext limit after AES decryption", async (t) => {
  const key = randomBytes(16);
  const plaintext = Buffer.from("123456789");
  const { root, store } = fixture(
    t,
    async () => chunkedResponse(encrypt(plaintext, key), { chunkSize: 3 }),
    { maxBytes: 8 },
  );
  const candidate = inboundMediaCandidateFromItem({
    file_item: {
      file_name: "large.bin",
      media: {
        aes_key: key.toString("base64"),
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/encrypted-large",
      },
    },
    type: 4,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "plaintext-large" }),
    assertMediaError("TOO_LARGE"),
  );
  assert.deepEqual(readdirSync(root, { recursive: true }), []);
});

test("rejects invalid AES block or PKCS7 data and removes the partial file", async (t) => {
  const key = randomBytes(16);
  const { root, store } = fixture(
    t,
    async () => chunkedResponse(Buffer.alloc(15, 0xa5), { chunkSize: 2 }),
  );
  const candidate = inboundMediaCandidateFromItem({
    file_item: {
      file_name: "corrupt.bin",
      media: {
        aes_key: key.toString("base64"),
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/corrupt",
      },
    },
    type: 4,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "corrupt" }),
    assertMediaError("DECRYPT_FAILED"),
  );
  assert.deepEqual(readdirSync(root, { recursive: true }), []);
});

test("keeps a progressing download alive beyond one timeout window", async (t) => {
  const chunkCount = 20;
  let index = 0;
  const { store } = fixture(
    t,
    async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
          async pull(controller) {
            if (index >= chunkCount) {
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            index += 1;
            controller.enqueue(Uint8Array.of(0x61));
          },
        }),
      ),
    { maxBytes: 4_096, timeoutMs: 100 },
  );
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/progress" },
    },
    type: 2,
  });
  assert.ok(candidate);

  const startedAt = Date.now();
  const result = await store.resolve({ candidate, dedupeKey: "progress" });
  assertStored(result);
  assert.ok(Date.now() - startedAt > 100);
  assert.equal(readFileSync(result.path).length, chunkCount);
});

test("times out a response body with no chunk progress", async (t) => {
  const { store } = fixture(
    t,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull() {
            await new Promise(() => {});
          },
        }),
      ),
    { timeoutMs: 5 },
  );
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/stalled-body" },
    },
    type: 2,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "stalled-body" }),
    assertMediaError("TIMEOUT"),
  );
});

test("times out stalled CDN requests", async (t) => {
  const { store } = fixture(
    t,
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
    { timeoutMs: 5 },
  );
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/stalled" },
    },
    type: 2,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "timeout" }),
    assertMediaError("TIMEOUT"),
  );
});

test("does not expose CDN URLs, query credentials, or AES keys in errors", async (t) => {
  const secretKey = randomBytes(16).toString("base64");
  const secretQuery = "credential-do-not-log";
  const secretUrl = `https://novac2c.cdn.weixin.qq.com/c2c/file?token=${secretQuery}`;
  const { store } = fixture(t, async () => new Response("denied", { status: 403 }));
  const candidate = inboundMediaCandidateFromItem({
    file_item: {
      file_name: "secret.txt",
      media: { aes_key: secretKey, full_url: secretUrl },
    },
    type: 4,
  });
  assert.ok(candidate);

  await assert.rejects(
    store.resolve({ candidate, dedupeKey: "secret-error" }),
    (error: unknown) => {
      assert.ok(error instanceof InboundMediaError);
      assert.equal(error.code, "HTTP_ERROR");
      assert.doesNotMatch(error.message, new RegExp(secretQuery));
      assert.doesNotMatch(error.message, new RegExp(secretKey));
      assert.doesNotMatch(error.message, /novac2c/u);
      return true;
    },
  );
});

test("cleanup removes only one hashed message directory and prune keeps active keys", async (t) => {
  const { root, store } = fixture(t, async () => new Response("image"));
  const candidate = inboundMediaCandidateFromItem({
    image_item: {
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/image" },
    },
    type: 2,
  });
  assert.ok(candidate);
  const first = await store.resolve({ candidate, dedupeKey: "first" });
  const active = await store.resolve({ candidate, dedupeKey: "active" });
  const stale = await store.resolve({ candidate, dedupeKey: "stale" });
  assertStored(first);
  assertStored(active);
  assertStored(stale);

  await store.cleanup("first");
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(active.path), true);
  assert.equal(existsSync(stale.path), true);

  const pruned = await store.prune(new Set(["active"]));
  assert.equal(pruned, 1);
  assert.equal(existsSync(active.path), true);
  assert.equal(existsSync(stale.path), false);
  assert.equal(dirname(active.path).startsWith(root), true);
});
