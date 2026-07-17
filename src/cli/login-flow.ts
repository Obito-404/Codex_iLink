import type { SqliteState } from "../bridge/sqlite-state.ts";
import type { ILinkClient } from "../ilink/ilink-client.ts";

const POLL_RETRY_DELAY_MS = 1_000;

export type LoginFlowErrorCode =
  | "already-bound"
  | "qr-expired"
  | "verification-blocked"
  | "verification-required";

export class LoginFlowError extends Error {
  readonly code: LoginFlowErrorCode;

  constructor(code: LoginFlowErrorCode, message: string) {
    super(message);
    this.name = "LoginFlowError";
    this.code = code;
  }
}

export type LoginFlowDependencies = {
  ilink: Pick<ILinkClient, "createQr" | "pollQr">;
  now: () => number;
  protectToken: (token: string) => string;
  signal?: AbortSignal;
  showQr: (qrUrl: string) => Promise<void> | void;
  sleep: (milliseconds: number) => Promise<void>;
  state: Pick<SqliteState, "bindController" | "saveILinkSession">;
};

export type LoginFlowResult = {
  baseUrl: string;
  botId: string;
  controllerUserId: string;
};

export async function runLoginFlow(
  dependencies: LoginFlowDependencies,
): Promise<LoginFlowResult> {
  const challenge = await dependencies.ilink.createQr({
    localTokenList: [],
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  await dependencies.showQr(challenge.qrcodeUrl);
  let pollingBaseUrl: string | undefined;

  while (true) {
    const result = await dependencies.ilink.pollQr({
      ...(pollingBaseUrl ? { baseUrl: pollingBaseUrl } : {}),
      qrcode: challenge.qrcode,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });

    if (result.kind === "waiting" || result.kind === "scanned") {
      await dependencies.sleep(POLL_RETRY_DELAY_MS);
      continue;
    }
    if (result.kind === "redirect") {
      pollingBaseUrl = result.baseUrl;
      await dependencies.sleep(POLL_RETRY_DELAY_MS);
      continue;
    }
    if (result.kind === "confirmed") {
      const protectedToken = dependencies.protectToken(result.session.botToken);
      dependencies.state.bindController({
        accountId: result.session.botId,
        boundAtMs: dependencies.now(),
        userId: result.session.controllerUserId,
      });
      dependencies.state.saveILinkSession({
        baseUrl: result.session.baseUrl,
        botId: result.session.botId,
        controllerUserId: result.session.controllerUserId,
        protectedToken,
      });
      return {
        baseUrl: result.session.baseUrl,
        botId: result.session.botId,
        controllerUserId: result.session.controllerUserId,
      };
    }

    const terminalErrors = {
      "already-bound": {
        code: "already-bound",
        message: "iLink bot is already bound",
      },
      expired: {
        code: "qr-expired",
        message: "iLink QR code expired",
      },
      "verify-blocked": {
        code: "verification-blocked",
        message: "iLink QR verification is blocked",
      },
      "verify-required": {
        code: "verification-required",
        message: "iLink QR verification is required",
      },
    } as const;
    const terminalError = terminalErrors[result.kind];
    throw new LoginFlowError(terminalError.code, terminalError.message);
  }
}
