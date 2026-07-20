import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ILinkClient } from "../src/ilink/ilink-client.ts";

type SendTextTestInput = Parameters<ILinkClient["sendText"]>[0];

test("createQr requests an unauthenticated bot QR challenge", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ ...(init ? { init } : {}), url: String(input) });
    return Response.json({
      qrcode: "opaque-qr-code",
      qrcode_img_content: "https://example.invalid/qr",
    });
  };
  const client = new ILinkClient({ fetch: fetchImpl });

  const challenge = await client.createQr({ localTokenList: [] });

  assert.deepEqual(challenge, {
    qrcode: "opaque-qr-code",
    qrcodeUrl: "https://example.invalid/qr",
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(
    request.url,
    "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
  );
  assert.equal(request.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    local_token_list: [],
  });

  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(headers.get("Authorization"), null);
  assert.equal(headers.get("iLink-App-Id"), "bot");
  assert.equal(headers.get("iLink-App-ClientVersion"), "132102");
  assert.match(
    Buffer.from(headers.get("X-WECHAT-UIN") ?? "", "base64").toString("utf8"),
    /^\d+$/,
  );
});

test("createQr exposes an HTTP failure without leaking the response body", async () => {
  const client = new ILinkClient({
    fetch: async () =>
      new Response("sensitive gateway body", {
        status: 401,
        statusText: "Unauthorized",
      }),
  });

  await assert.rejects(
    client.createQr({ localTokenList: [] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal((error as Error & { kind?: string }).kind, "http");
      assert.equal((error as Error & { httpStatus?: number }).httpStatus, 401);
      assert.doesNotMatch(error.message, /sensitive gateway body/);
      return true;
    },
  );
});

test("createQr rejects a malformed success response", async () => {
  const client = new ILinkClient({
    fetch: async () => Response.json({ qrcode: "opaque-qr" }),
  });

  await assert.rejects(
    client.createQr({ localTokenList: [] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal(
        (error as Error & { kind?: string }).kind,
        "invalid-response",
      );
      return true;
    },
  );
});

test("pollQr uses GET and maps the wire redirect status", async () => {
  let captured: { init?: RequestInit; url: string } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { ...(init ? { init } : {}), url: String(input) };
    return Response.json({
      status: "scaned_but_redirect",
      redirect_host: "edge.weixin.qq.com",
    });
  };
  const client = new ILinkClient({ fetch: fetchImpl });

  const result = await client.pollQr({
    qrcode: "opaque qr/value",
    verifyCode: "123 456",
  });

  assert.deepEqual(result, {
    baseUrl: "https://edge.weixin.qq.com",
    kind: "redirect",
  });
  assert.ok(captured);
  const url = new URL(captured.url);
  assert.equal(url.origin, "https://ilinkai.weixin.qq.com");
  assert.equal(url.pathname, "/ilink/bot/get_qrcode_status");
  assert.equal(url.searchParams.get("qrcode"), "opaque qr/value");
  assert.equal(url.searchParams.get("verify_code"), "123 456");
  assert.equal(captured.init?.method, "GET");
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("iLink-App-Id"), "bot");
  assert.equal(headers.get("iLink-App-ClientVersion"), "132102");
  assert.equal(headers.get("Content-Type"), null);
  assert.equal(headers.get("AuthorizationType"), null);
  assert.equal(headers.get("X-WECHAT-UIN"), null);
});

test("pollQr maps confirmed credentials into a bound iLink session", async () => {
  const client = new ILinkClient({
    fetch: async () =>
      Response.json({
        baseurl: "https://api.weixin.qq.com/",
        bot_token: "bot-token",
        ilink_bot_id: "bot-1",
        ilink_user_id: "controller-1",
        status: "confirmed",
      }),
  });

  const result = await client.pollQr({ qrcode: "opaque-qr" });

  assert.deepEqual(result, {
    kind: "confirmed",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "bot-token",
      controllerUserId: "controller-1",
    },
  });
});

test("pollQr rejects a confirmed response missing the controller identity", async () => {
  const client = new ILinkClient({
    fetch: async () =>
      Response.json({
        bot_token: "must-not-appear-in-error",
        ilink_bot_id: "bot-1",
        status: "confirmed",
      }),
  });

  await assert.rejects(
    client.pollQr({ qrcode: "opaque-qr" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal(
        (error as Error & { kind?: string }).kind,
        "invalid-response",
      );
      assert.doesNotMatch(error.message, /must-not-appear-in-error/);
      return true;
    },
  );
});

test("pollQr normalizes every nonterminal wire status", async () => {
  const cases = [
    ["wait", "waiting"],
    ["scaned", "scanned"],
    ["expired", "expired"],
    ["need_verifycode", "verify-required"],
    ["verify_code_blocked", "verify-blocked"],
    ["binded_redirect", "already-bound"],
  ] as const;

  for (const [wireStatus, kind] of cases) {
    const client = new ILinkClient({
      fetch: async () => Response.json({ status: wireStatus }),
    });

    assert.deepEqual(await client.pollQr({ qrcode: "opaque-qr" }), { kind });
  }
});

test("pollQr maps its long-poll timeout to waiting", async () => {
  const client = new ILinkClient({
    fetch: async (_input, init) => {
      if (!init?.signal) throw new Error("pollQr did not install a timeout signal");
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
    },
  });

  assert.deepEqual(
    await client.pollQr({ qrcode: "opaque-qr", timeoutMs: 5 }),
    { kind: "waiting" },
  );
});

test("pollQr preserves a redirected base path without adding a double slash", async () => {
  let requestedUrl = "";
  const client = new ILinkClient({
    fetch: async (input) => {
      requestedUrl = String(input);
      return Response.json({ status: "wait" });
    },
  });

  await client.pollQr({
    baseUrl: "https://edge.weixin.qq.com/region/",
    qrcode: "opaque-qr",
  });

  assert.equal(
    requestedUrl,
    "https://edge.weixin.qq.com/region/ilink/bot/get_qrcode_status?qrcode=opaque-qr",
  );
});

test("getUpdates long-polls with the stored cursor and authenticated session", async () => {
  let captured: { init?: RequestInit; url: string } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { ...(init ? { init } : {}), url: String(input) };
    return Response.json({
      get_updates_buf: "cursor-next",
      longpolling_timeout_ms: 42_000,
      msgs: [
        {
          context_token: "context-1",
          from_user_id: "controller-1",
          message_id: 123,
        },
      ],
      ret: 0,
    });
  };
  const client = new ILinkClient({ fetch: fetchImpl });

  const result = await client.getUpdates({
    cursor: "cursor-previous",
    session: {
      baseUrl: "https://api.weixin.qq.com/base/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
  });

  assert.deepEqual(result, {
    cursor: "cursor-next",
    kind: "updates",
    messages: [
      {
        context_token: "context-1",
        from_user_id: "controller-1",
        message_id: 123,
      },
    ],
    nextPollTimeoutMs: 42_000,
  });
  assert.ok(captured);
  assert.equal(
    captured.url,
    "https://api.weixin.qq.com/base/ilink/bot/getupdates",
  );
  assert.equal(captured.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    base_info: {
      bot_agent: "Codex-iLink/0.0.0",
      channel_version: "2.4.6",
    },
    get_updates_buf: "cursor-previous",
  });
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer secret-token");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
});

test("getUpdates preserves an unsigned 64-bit message id without rounding", async () => {
  const client = new ILinkClient({
    fetch: async () =>
      new Response(
        '{"ret":0,"get_updates_buf":"cursor-next","msgs":[{"message_id":9223372036854775807,"from_user_id":"controller-1","context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"/st"}}]}]}',
        { headers: { "Content-Type": "application/json" } },
      ),
  });

  const result = await client.getUpdates({
    cursor: "cursor-previous",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
  });

  assert.equal(result.kind, "updates");
  if (result.kind !== "updates") assert.fail("expected an update batch");
  assert.equal(result.messages[0]?.message_id, "9223372036854775807");
});

test("notifyStart announces the authenticated bot before polling", async () => {
  let captured: { init?: RequestInit; url: string } | undefined;
  const client = new ILinkClient({
    fetch: async (input, init) => {
      captured = { ...(init ? { init } : {}), url: String(input) };
      return Response.json({ ret: 0 });
    },
  });

  await client.notifyStart({
    session: {
      baseUrl: "https://api.weixin.qq.com/base/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
  });

  assert.ok(captured);
  assert.equal(
    captured.url,
    "https://api.weixin.qq.com/base/ilink/bot/msg/notifystart",
  );
  assert.equal(captured.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    base_info: {
      bot_agent: "Codex-iLink/0.0.0",
      channel_version: "2.4.6",
    },
  });
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer secret-token");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
});

test("notifyStop announces the authenticated bot after polling ends", async () => {
  let captured: { init?: RequestInit; url: string } | undefined;
  const client = new ILinkClient({
    fetch: async (input, init) => {
      captured = { ...(init ? { init } : {}), url: String(input) };
      return Response.json({ ret: 0 });
    },
  });

  await client.notifyStop({
    session: {
      baseUrl: "https://api.weixin.qq.com/base/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
  });

  assert.ok(captured);
  assert.equal(
    captured.url,
    "https://api.weixin.qq.com/base/ilink/bot/msg/notifystop",
  );
  assert.equal(captured.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    base_info: {
      bot_agent: "Codex-iLink/0.0.0",
      channel_version: "2.4.6",
    },
  });
});

test("sendTyping fetches one ticket and sends typing then cancel statuses", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  const client = new ILinkClient({
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ ...(init ? { init } : {}), url });
      return url.endsWith("/ilink/bot/getconfig")
        ? Response.json({ ret: 0, typing_ticket: "typing-ticket-1" })
        : Response.json({ ret: 0 });
    },
  });
  const session = {
    baseUrl: "https://api.weixin.qq.com/base/",
    botId: "bot-1",
    botToken: "secret-token",
    controllerUserId: "controller-1",
  };

  assert.equal(
    await client.sendTyping({
      contextToken: "context-1",
      session,
      status: "typing",
    }),
    true,
  );
  assert.equal(
    await client.sendTyping({
      contextToken: "context-2",
      session,
      status: "cancel",
    }),
    true,
  );

  assert.deepEqual(
    requests.map(({ init, url }) => ({
      body: JSON.parse(String(init?.body)),
      method: init?.method,
      url,
    })),
    [
      {
        body: {
          base_info: {
            bot_agent: "Codex-iLink/0.0.0",
            channel_version: "2.4.6",
          },
          context_token: "context-1",
          ilink_user_id: "controller-1",
        },
        method: "POST",
        url: "https://api.weixin.qq.com/base/ilink/bot/getconfig",
      },
      {
        body: {
          base_info: {
            bot_agent: "Codex-iLink/0.0.0",
            channel_version: "2.4.6",
          },
          ilink_user_id: "controller-1",
          status: 1,
          typing_ticket: "typing-ticket-1",
        },
        method: "POST",
        url: "https://api.weixin.qq.com/base/ilink/bot/sendtyping",
      },
      {
        body: {
          base_info: {
            bot_agent: "Codex-iLink/0.0.0",
            channel_version: "2.4.6",
          },
          ilink_user_id: "controller-1",
          status: 2,
          typing_ticket: "typing-ticket-1",
        },
        method: "POST",
        url: "https://api.weixin.qq.com/base/ilink/bot/sendtyping",
      },
    ],
  );
});

test("sendTyping reports caller cancellation while fetching its ticket", async () => {
  const external = new AbortController();
  external.abort("shutdown");
  const client = new ILinkClient({
    fetch: async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException("cancelled", "AbortError");
    },
  });

  await assert.rejects(
    client.sendTyping({
      contextToken: "context-1",
      session: {
        baseUrl: "https://api.weixin.qq.com/base/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
      signal: external.signal,
      status: "typing",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal((error as Error & { kind?: string }).kind, "cancelled");
      return true;
    },
  );
});

test("getUpdates rejects an application ret error without advancing the cursor", async () => {
  const client = new ILinkClient({
    fetch: async () =>
      Response.json({
        errmsg: "busy",
        get_updates_buf: "must-not-commit",
        ret: 7,
      }),
  });

  await assert.rejects(
    client.getUpdates({
      cursor: "cursor-safe",
      session: {
        baseUrl: "https://api.weixin.qq.com/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal(error.message, "getUpdates ret=7 errcode=none: busy");
      assert.equal((error as Error & { kind?: string }).kind, "api");
      assert.equal((error as Error & { ret?: number }).ret, 7);
      return true;
    },
  );
});

test("getUpdates classifies -14 in ret or errcode as expired authentication", async () => {
  for (const response of [{ errcode: -14, ret: 0 }, { ret: -14 }]) {
    const client = new ILinkClient({
      fetch: async () => Response.json({ ...response, errmsg: "stale token" }),
    });

    await assert.rejects(
      client.getUpdates({
        cursor: "cursor-safe",
        session: {
          baseUrl: "https://api.weixin.qq.com/",
          botId: "bot-1",
          botToken: "stale-token",
          controllerUserId: "controller-1",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ILinkError");
        assert.equal(
          (error as Error & { kind?: string }).kind,
          "auth-expired",
        );
        return true;
      },
    );
  }
});

test("one -14 pauses every authenticated API for the same bot", async () => {
  let nowMs = 1_000;
  let fetchCalls = 0;
  const pauses: Array<{ botId: string; pausedUntilMs: number }> = [];
  const client = new ILinkClient({
    authExpiredCooldownMs: 1_000,
    fetch: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? Response.json({ errmsg: "stale token", ret: -14 })
        : Response.json({ get_updates_buf: "cursor-new", msgs: [], ret: 0 });
    },
    now: () => nowMs,
    onAuthExpired: (pause) => pauses.push(pause),
  });
  const session = {
    baseUrl: "https://api.weixin.qq.com/",
    botId: "bot-1",
    botToken: "stale-token",
    controllerUserId: "controller-1",
  };

  await assert.rejects(
    client.sendText({
      clientId: "auth-expired-send",
      contextToken: "context",
      session,
      text: "不会发送",
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { kind?: string }).kind === "auth-expired",
  );
  assert.deepEqual(pauses, [{ botId: "bot-1", pausedUntilMs: 2_000 }]);
  assert.equal(client.authPausedUntil(session), 2_000);

  await assert.rejects(
    client.getUpdates({ cursor: "cursor-old", session }),
    /paused after expired authentication/u,
  );
  await assert.rejects(
    client.notifyStart({ session }),
    /paused after expired authentication/u,
  );
  assert.equal(fetchCalls, 1, "paused APIs must not reach fetch");

  nowMs = 2_000;
  assert.deepEqual(
    await client.getUpdates({ cursor: "cursor-old", session }),
    { cursor: "cursor-new", kind: "updates", messages: [] },
  );
  assert.equal(fetchCalls, 2);
  assert.equal(client.authPausedUntil(session), null);
});

test("getUpdates treats its client timeout as an empty poll and keeps the cursor", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (!init?.signal) throw new Error("getUpdates did not install a timeout signal");
    return await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("timed out", "AbortError")),
        { once: true },
      );
    });
  };
  const client = new ILinkClient({ fetch: fetchImpl });

  const result = await client.getUpdates({
    cursor: "cursor-safe",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
    timeoutMs: 5,
  });

  assert.deepEqual(result, {
    cursor: "cursor-safe",
    kind: "timeout",
  });
});

test("getUpdates preserves caller cancellation instead of reporting a timeout", async () => {
  const external = new AbortController();
  external.abort("shutdown");
  const client = new ILinkClient({
    fetch: async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException("cancelled", "AbortError");
    },
  });

  await assert.rejects(
    client.getUpdates({
      cursor: "cursor-safe",
      session: {
        baseUrl: "https://api.weixin.qq.com/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
      signal: external.signal,
      timeoutMs: 60_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal((error as Error & { kind?: string }).kind, "cancelled");
      return true;
    },
  );
});

test("sendText preserves the caller clientId when an outbox retries", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ ...(init ? { init } : {}), url: String(input) });
    return Response.json({ ret: 0 });
  };
  const client = new ILinkClient({ fetch: fetchImpl });
  const input = {
    clientId: "codex-ilink:retry-stable-id",
    contextToken: "context-latest",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
    text: "任务已经完成",
  };

  const first = await client.sendText(input);
  const retry = await client.sendText(input);

  assert.deepEqual(first, {
    accepted: true,
    clientId: "codex-ilink:retry-stable-id",
  });
  assert.deepEqual(retry, first);
  assert.equal(requests.length, 2);
  const expectedBody = {
    base_info: {
      bot_agent: "Codex-iLink/0.0.0",
      channel_version: "2.4.6",
    },
    msg: {
      client_id: "codex-ilink:retry-stable-id",
      context_token: "context-latest",
      from_user_id: "",
      item_list: [
        {
          text_item: { text: "任务已经完成" },
          type: 1,
        },
      ],
      message_state: 2,
      message_type: 2,
      to_user_id: "controller-1",
    },
  };
  for (const request of requests) {
    assert.equal(
      request.url,
      "https://api.weixin.qq.com/ilink/bot/sendmessage",
    );
    assert.equal(request.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(request.init?.body)), expectedBody);
    assert.equal(
      new Headers(request.init?.headers).get("Authorization"),
      "Bearer secret-token",
    );
  }
});

test("sendText uses CRLF line breaks that the WeChat text renderer preserves", async () => {
  let wireText = "";
  const client = new ILinkClient({
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        msg: { item_list: Array<{ text_item: { text: string } }> };
      };
      wireText = body.msg.item_list[0]?.text_item.text ?? "";
      return Response.json({ ret: 0 });
    },
  });

  await client.sendText({
    clientId: "codex-ilink:help-lines",
    contextToken: "context-help",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
    text: "/p — projects\n/help — commands",
  });

  assert.equal(wireText, "/p — projects\r\n/help — commands");
});

test("sendText shares one in-flight request for an identical clientId and payload", async () => {
  let fetchCalls = 0;
  let resolveResponse!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const client = new ILinkClient({
    fetch: async () => {
      fetchCalls += 1;
      return await pendingResponse;
    },
  });
  const input = {
    clientId: "codex-ilink:concurrent-stable-id",
    contextToken: "context-latest",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
    text: "任务已经完成",
  };

  const first = client.sendText(input);
  const duplicate = client.sendText(input);

  assert.equal(duplicate, first);
  assert.equal(fetchCalls, 1);

  resolveResponse(Response.json({ ret: 0 }));
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.deepEqual(firstResult, {
    accepted: true,
    clientId: "codex-ilink:concurrent-stable-id",
  });
  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(fetchCalls, 1);
});

test("sendText fails closed when an in-flight clientId collides with another payload", async () => {
  const collisionInputs = [
    {
      label: "target",
      update: (input: SendTextTestInput): SendTextTestInput => ({
        ...input,
        session: { ...input.session, controllerUserId: "controller-2" },
      }),
    },
    {
      label: "context",
      update: (input: SendTextTestInput): SendTextTestInput => ({
        ...input,
        contextToken: "context-other",
      }),
    },
    {
      label: "text",
      update: (input: SendTextTestInput): SendTextTestInput => ({
        ...input,
        text: "另一条消息",
      }),
    },
  ] as const;

  for (const collision of collisionInputs) {
    let fetchCalls = 0;
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const client = new ILinkClient({
      fetch: async () => {
        fetchCalls += 1;
        return await pendingResponse;
      },
    });
    const input: SendTextTestInput = {
      clientId: `codex-ilink:collision-${collision.label}`,
      contextToken: "context-latest",
      session: {
        baseUrl: "https://api.weixin.qq.com/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
      text: "任务已经完成",
    };

    const first = client.sendText(input);
    await assert.rejects(
      client.sendText(collision.update(input)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "ILinkClientIdCollisionError");
        assert.equal(
          (error as Error & { code?: string }).code,
          "ILINK_CLIENT_ID_COLLISION",
        );
        assert.equal(
          (error as Error & { clientId?: string }).clientId,
          input.clientId,
        );
        assert.match(error.message, /clientId collision/);
        assert.match(error.message, new RegExp(input.clientId));
        return true;
      },
    );
    assert.equal(fetchCalls, 1);

    resolveResponse(Response.json({ ret: 0 }));
    await first;
  }
});

test("sendText clears a failed flight so the same clientId can retry", async () => {
  let fetchCalls = 0;
  const client = new ILinkClient({
    fetch: async () => {
      fetchCalls += 1;
      return Response.json(
        fetchCalls === 1 ? { errmsg: "rejected", ret: 23 } : { ret: 0 },
      );
    },
  });
  const input = {
    clientId: "codex-ilink:retry-after-failure",
    contextToken: "context-latest",
    session: {
      baseUrl: "https://api.weixin.qq.com/",
      botId: "bot-1",
      botToken: "secret-token",
      controllerUserId: "controller-1",
    },
    text: "任务已经完成",
  };

  await assert.rejects(client.sendText(input));
  assert.deepEqual(await client.sendText(input), {
    accepted: true,
    clientId: "codex-ilink:retry-after-failure",
  });
  assert.equal(fetchCalls, 2);
});

test("sendText rejects an application ret error as not accepted", async () => {
  const client = new ILinkClient({
    fetch: async () => Response.json({ errmsg: "rejected", ret: 23 }),
  });

  await assert.rejects(
    client.sendText({
      clientId: "codex-ilink:stable-id",
      contextToken: "context-latest",
      session: {
        baseUrl: "https://api.weixin.qq.com/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
      text: "任务已经完成",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal((error as Error & { kind?: string }).kind, "api");
      assert.equal((error as Error & { ret?: number }).ret, 23);
      return true;
    },
  );
});

test("sendText classifies a timeout as delivery unknown with the same clientId", async () => {
  const client = new ILinkClient({
    fetch: async (_input, init) => {
      if (!init?.signal) throw new Error("sendText did not install a timeout signal");
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
    },
  });

  await assert.rejects(
    client.sendText({
      clientId: "codex-ilink:stable-retry-id",
      contextToken: "context-latest",
      session: {
        baseUrl: "https://api.weixin.qq.com/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
      text: "任务已经完成",
      timeoutMs: 5,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal(
        (error as Error & { kind?: string }).kind,
        "delivery-unknown",
      );
      assert.equal(
        (error as Error & { clientId?: string }).clientId,
        "codex-ilink:stable-retry-id",
      );
      return true;
    },
  );
});

test("sendText treats an unreadable success response as delivery unknown", async () => {
  const client = new ILinkClient({
    fetch: async () =>
      new Response("not-json", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
  });

  await assert.rejects(
    client.sendText({
      clientId: "codex-ilink:stable-response-id",
      contextToken: "context-latest",
      session: {
        baseUrl: "https://api.weixin.qq.com/",
        botId: "bot-1",
        botToken: "secret-token",
        controllerUserId: "controller-1",
      },
      text: "任务已经完成",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ILinkError");
      assert.equal(
        (error as Error & { kind?: string }).kind,
        "delivery-unknown",
      );
      assert.equal(
        (error as Error & { clientId?: string }).clientId,
        "codex-ilink:stable-response-id",
      );
      return true;
    },
  );
});

test("media follows the official encrypted CDN upload and structured item flow", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const filePath = join(directory, "到账凭证.png");
  const plaintext = Buffer.from("fake-png-payload");
  writeFileSync(filePath, plaintext);
  let uploadRequest: Record<string, unknown> | undefined;
  let ciphertext: Buffer | undefined;
  let sendRequest: Record<string, unknown> | undefined;
  const client = new ILinkClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/ilink/bot/getuploadurl")) {
        uploadRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer secret-token",
        );
        return Response.json({
          upload_full_url:
            "https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=opaque",
        });
      }
      if (url.includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        ciphertext = Buffer.from(init?.body as Uint8Array);
        return new Response(null, {
          headers: { "x-encrypted-param": "download-opaque" },
          status: 200,
        });
      }
      if (url.endsWith("/ilink/bot/sendmessage")) {
        sendRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ret: 0 });
      }
      throw new Error(`unexpected request ${url}`);
    },
  });
  const session = {
    baseUrl: "https://api.weixin.qq.com/",
    botId: "bot-1",
    botToken: "secret-token",
    controllerUserId: "controller-1",
  };

  const prepared = await client.prepareMedia({
    media: {
      kind: "image",
      name: "到账凭证.png",
      path: filePath,
      type: "local-media",
      v: 1,
    },
    session,
  });
  await client.sendMedia({
    clientId: "codex-ilink:media-1",
    contextToken: "ctx-media",
    media: prepared,
    session,
  });

  assert.equal(uploadRequest?.media_type, 1);
  assert.equal(uploadRequest?.rawsize, plaintext.length);
  assert.equal(uploadRequest?.filesize, 32);
  assert.equal(uploadRequest?.no_need_thumb, true);
  assert.ok(typeof uploadRequest?.aeskey === "string");
  assert.ok(ciphertext);
  const decipher = createDecipheriv(
    "aes-128-ecb",
    Buffer.from(String(uploadRequest.aeskey), "hex"),
    null,
  );
  assert.deepEqual(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    plaintext,
  );
  const message = (sendRequest?.msg ?? {}) as Record<string, unknown>;
  const item = (message.item_list as Array<Record<string, unknown>>)[0];
  assert.equal(message.client_id, "codex-ilink:media-1");
  assert.equal(item?.type, 2);
  const image = item?.image_item as Record<string, unknown>;
  const media = image.media as Record<string, unknown>;
  assert.deepEqual(media, {
    aes_key: Buffer.from(String(uploadRequest.aeskey), "utf8").toString("base64"),
    encrypt_query_param: "download-opaque",
    encrypt_type: 1,
  });
  assert.equal(image.mid_size, 32);
});

test("a local PDF follows the complete ordinary file upload flow", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-outbound-pdf-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const filePath = join(directory, "报销单.pdf");
  const plaintext = Buffer.from("%PDF-1.4\n% fixture");
  writeFileSync(filePath, plaintext);
  let uploadRequest: Record<string, unknown> | undefined;
  let sendRequest: Record<string, unknown> | undefined;
  const client = new ILinkClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/ilink/bot/getuploadurl")) {
        uploadRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          upload_full_url:
            "https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=pdf",
        });
      }
      if (url.includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        return new Response(null, {
          headers: { "x-encrypted-param": "pdf-download-param" },
          status: 200,
        });
      }
      if (url.endsWith("/ilink/bot/sendmessage")) {
        sendRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ret: 0 });
      }
      throw new Error(`unexpected request ${url}`);
    },
  });
  const session = {
    baseUrl: "https://api.weixin.qq.com/",
    botId: "bot-1",
    botToken: "secret-token",
    controllerUserId: "controller-1",
  };

  const prepared = await client.prepareMedia({
    media: {
      kind: "file",
      name: "报销单.pdf",
      path: filePath,
      type: "local-media",
      v: 1,
    },
    session,
  });
  await client.sendMedia({
    clientId: "codex-ilink:pdf-1",
    contextToken: "ctx-pdf",
    media: prepared,
    session,
  });

  assert.equal(uploadRequest?.media_type, 3);
  assert.equal(uploadRequest?.rawsize, plaintext.length);
  const message = sendRequest?.msg as Record<string, unknown>;
  const item = (message.item_list as Array<Record<string, unknown>>)[0];
  assert.deepEqual(item, {
    file_item: {
      file_name: "报销单.pdf",
      len: String(plaintext.length),
      media: {
        aes_key: prepared.aesKeyBase64,
        encrypt_query_param: "pdf-download-param",
        encrypt_type: 1,
      },
    },
    type: 4,
  });
});

test("prepared videos and ordinary attachments use the official item fields", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = new ILinkClient({
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ret: 0 });
    },
  });
  const session = {
    baseUrl: "https://api.weixin.qq.com/",
    botId: "bot-1",
    botToken: "secret-token",
    controllerUserId: "controller-1",
  };
  await client.sendMedia({
    clientId: "video-1",
    contextToken: "ctx",
    media: {
      aesKeyBase64: "YWVz",
      ciphertextSize: 48,
      encryptedQueryParam: "video-param",
      kind: "video",
      name: "clip.mp4",
      plaintextSize: 40,
      type: "prepared-media",
      v: 1,
    },
    session,
  });
  await client.sendMedia({
    clientId: "file-1",
    contextToken: "ctx",
    media: {
      aesKeyBase64: "YWVz",
      ciphertextSize: 64,
      encryptedQueryParam: "file-param",
      kind: "file",
      name: "报销单.pdf",
      plaintextSize: 60,
      type: "prepared-media",
      v: 1,
    },
    session,
  });

  const video = ((requests[0]?.msg as Record<string, unknown>)
    .item_list as Array<Record<string, unknown>>)[0];
  assert.deepEqual(video, {
    type: 5,
    video_item: {
      media: {
        aes_key: "YWVz",
        encrypt_query_param: "video-param",
        encrypt_type: 1,
      },
      video_size: 48,
    },
  });
  const file = ((requests[1]?.msg as Record<string, unknown>)
    .item_list as Array<Record<string, unknown>>)[0];
  assert.deepEqual(file, {
    file_item: {
      file_name: "报销单.pdf",
      len: "60",
      media: {
        aes_key: "YWVz",
        encrypt_query_param: "file-param",
        encrypt_type: 1,
      },
    },
    type: 4,
  });
});
