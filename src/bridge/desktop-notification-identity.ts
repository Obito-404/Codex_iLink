import { WECHAT_FINAL_MAX_MESSAGES } from "./wechat-output.ts";

export type DesktopNotificationIdentity = {
  baseClientId: string;
  origin: TerminalNotificationOrigin;
  part: number | null;
  replyable: boolean;
  threadId: string;
  turnId: string;
};

export type TerminalNotificationOrigin = "automation" | "desktop";

const DESKTOP_NOTIFICATION_CLIENT_ID =
  /^(codex-ilink:(automation|desktop):([A-Za-z0-9-]+):([A-Za-z0-9-]+):(final|notice))(?::part:([1-9][0-9]*))?$/u;

export function desktopNotificationClientId(
  threadId: string,
  turnId: string,
  replyable = true,
): string {
  return terminalNotificationClientId(
    "desktop",
    threadId,
    turnId,
    replyable,
  );
}

export function terminalNotificationClientId(
  origin: TerminalNotificationOrigin,
  threadId: string,
  turnId: string,
  replyable = true,
): string {
  const kind = replyable ? "final" : "notice";
  return `codex-ilink:${origin}:${threadId}:${turnId}:${kind}`;
}

export function desktopNotificationMessageClientIds(
  baseClientId: string,
  messageCount: number,
): string[] {
  if (messageCount === 1) return [baseClientId];
  if (
    !Number.isSafeInteger(messageCount) ||
    messageCount < 1 ||
    messageCount > WECHAT_FINAL_MAX_MESSAGES
  ) {
    throw new Error("E_DESKTOP_NOTIFICATION_PARTS");
  }
  return Array.from(
    { length: messageCount },
    (_, index) => `${baseClientId}:part:${String(index + 1)}`,
  );
}

export function desktopNotificationCandidateClientIds(
  baseClientId: string,
): string[] {
  return [
    baseClientId,
    ...Array.from(
      { length: WECHAT_FINAL_MAX_MESSAGES },
      (_, index) => `${baseClientId}:part:${String(index + 1)}`,
    ),
  ];
}

export function parseDesktopNotificationClientId(
  clientId: string,
): DesktopNotificationIdentity | null {
  const match = DESKTOP_NOTIFICATION_CLIENT_ID.exec(clientId);
  const baseClientId = match?.[1];
  const origin = match?.[2];
  const threadId = match?.[3];
  const turnId = match?.[4];
  if (
    !baseClientId ||
    (origin !== "automation" && origin !== "desktop") ||
    !threadId ||
    !turnId
  ) {
    return null;
  }
  const part = match[6] ? Number(match[6]) : null;
  if (
    part !== null &&
    (!Number.isSafeInteger(part) || part > WECHAT_FINAL_MAX_MESSAGES)
  ) {
    return null;
  }
  return {
    baseClientId,
    origin,
    part,
    replyable: match[5] === "final",
    threadId,
    turnId,
  };
}

export function isFinalDesktopNotificationPart(
  clientId: string,
  exists: (candidateClientId: string) => boolean,
): boolean {
  const identity = parseDesktopNotificationClientId(clientId);
  if (!identity) return false;
  if (identity.part === null || identity.part >= WECHAT_FINAL_MAX_MESSAGES) {
    return true;
  }
  return !exists(
    `${identity.baseClientId}:part:${String(identity.part + 1)}`,
  );
}
