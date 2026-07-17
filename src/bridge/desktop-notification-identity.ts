import { WECHAT_FINAL_MAX_MESSAGES } from "./wechat-output.ts";

export type DesktopNotificationIdentity = {
  baseClientId: string;
  part: number | null;
  replyable: boolean;
  threadId: string;
  turnId: string;
};

const DESKTOP_NOTIFICATION_CLIENT_ID =
  /^(codex-ilink:desktop:([A-Za-z0-9-]+):([A-Za-z0-9-]+):(final|notice))(?::part:([1-9][0-9]*))?$/u;

export function desktopNotificationClientId(
  threadId: string,
  turnId: string,
  replyable = true,
): string {
  const kind = replyable ? "final" : "notice";
  return `codex-ilink:desktop:${threadId}:${turnId}:${kind}`;
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
  const threadId = match?.[2];
  const turnId = match?.[3];
  if (!baseClientId || !threadId || !turnId) return null;
  const part = match[5] ? Number(match[5]) : null;
  if (
    part !== null &&
    (!Number.isSafeInteger(part) || part > WECHAT_FINAL_MAX_MESSAGES)
  ) {
    return null;
  }
  return {
    baseClientId,
    part,
    replyable: match[4] === "final",
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
