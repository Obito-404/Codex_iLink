import assert from "node:assert/strict";
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
