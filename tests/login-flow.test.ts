import assert from "node:assert/strict";
import test from "node:test";

import { runLoginFlow } from "../src/cli/login-flow.ts";

test("login displays one QR and persists only the protected token for its controller", async () => {
  const rawToken = "raw-token-must-not-be-stored";
  const pollBaseUrls: Array<string | undefined> = [];
  const pollResults = [
    { kind: "waiting" as const },
    { kind: "scanned" as const },
    { baseUrl: "https://edge.weixin.qq.com", kind: "redirect" as const },
    {
      kind: "confirmed" as const,
      session: {
        baseUrl: "https://api.weixin.qq.com",
        botId: "bot-1",
        botToken: rawToken,
        controllerUserId: "controller-1",
      },
    },
  ];
  let pollIndex = 0;
  let createCalls = 0;
  const shownQrUrls: string[] = [];
  const sleeps: number[] = [];
  const protectedInputs: string[] = [];
  const bindCalls: unknown[] = [];
  const saveCalls: unknown[] = [];

  const result = await runLoginFlow({
    ilink: {
      createQr: async (input) => {
        createCalls += 1;
        assert.deepEqual(input, { localTokenList: [] });
        return {
          qrcode: "opaque-qrcode-must-not-leak",
          qrcodeUrl: "https://qr.example.test/challenge",
        };
      },
      pollQr: async (input) => {
        assert.equal(input.qrcode, "opaque-qrcode-must-not-leak");
        pollBaseUrls.push(input.baseUrl);
        const next = pollResults[pollIndex];
        pollIndex += 1;
        if (!next) throw new Error("unexpected extra poll");
        return next;
      },
    },
    now: () => 1_721_234_567_890,
    protectToken: (token) => {
      protectedInputs.push(token);
      return "dpapi-protected-token";
    },
    showQr: async (qrUrl) => {
      shownQrUrls.push(qrUrl);
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    state: {
      bindController: (controller) => {
        bindCalls.push(controller);
        return controller;
      },
      saveILinkSession: (session) => {
        saveCalls.push(session);
      },
    },
  });

  assert.deepEqual(result, {
    baseUrl: "https://api.weixin.qq.com",
    botId: "bot-1",
    controllerUserId: "controller-1",
  });
  assert.equal(createCalls, 1);
  assert.deepEqual(shownQrUrls, ["https://qr.example.test/challenge"]);
  assert.deepEqual(pollBaseUrls, [undefined, undefined, undefined, "https://edge.weixin.qq.com"]);
  assert.deepEqual(sleeps, [1_000, 1_000, 1_000]);
  assert.deepEqual(protectedInputs, [rawToken]);
  assert.deepEqual(bindCalls, [
    {
      accountId: "bot-1",
      boundAtMs: 1_721_234_567_890,
      userId: "controller-1",
    },
  ]);
  assert.deepEqual(saveCalls, [
    {
      baseUrl: "https://api.weixin.qq.com",
      botId: "bot-1",
      controllerUserId: "controller-1",
      protectedToken: "dpapi-protected-token",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(saveCalls), new RegExp(rawToken, "u"));
});

test("terminal QR states fail with stable errors that do not leak the challenge", async () => {
  const cases = [
    ["expired", "qr-expired", "iLink QR code expired"],
    [
      "verify-required",
      "verification-required",
      "iLink QR verification is required",
    ],
    [
      "verify-blocked",
      "verification-blocked",
      "iLink QR verification is blocked",
    ],
    ["already-bound", "already-bound", "iLink bot is already bound"],
  ] as const;

  for (const [kind, code, message] of cases) {
    const secretQr = `secret-qrcode-${kind}`;
    await assert.rejects(
      runLoginFlow({
        ilink: {
          createQr: async () => ({
            qrcode: secretQr,
            qrcodeUrl: `https://qr.example.test/${secretQr}`,
          }),
          pollQr: async () => ({ kind }),
        },
        now: () => {
          throw new Error("terminal state must not bind");
        },
        protectToken: () => {
          throw new Error("terminal state must not protect a token");
        },
        showQr: () => {},
        sleep: async () => {
          throw new Error("terminal state must not retry");
        },
        state: {
          bindController: () => {
            throw new Error("terminal state must not bind");
          },
          saveILinkSession: () => {
            throw new Error("terminal state must not save a session");
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "LoginFlowError");
        assert.equal((error as Error & { code?: string }).code, code);
        assert.equal(error.message, message);
        assert.doesNotMatch(error.message, new RegExp(secretQr, "u"));
        return true;
      },
    );
  }
});
