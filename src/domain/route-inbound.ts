export type SessionBinding = {
  expiresAtMs: number;
  threadId: string;
};

export type NotificationWindow = {
  expiresAtMs: number;
  threadId: string;
};

export type RouteInboundTextInput = {
  binding: SessionBinding | null;
  mainThreadId: string;
  notificationWindows: readonly NotificationWindow[];
  nowMs: number;
  text: string;
};

export type TurnRouteDecision = {
  binding: SessionBinding | null;
  kind: "turn";
  route: "binding" | "main" | "notification";
  text: string;
  threadId: string;
};

export type AmbiguousNotificationRouteDecision = {
  kind: "ambiguousNotificationRoute";
  threadIds: string[];
};

const BINDING_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export function routeInboundText(
  input: RouteInboundTextInput,
): AmbiguousNotificationRouteDecision | TurnRouteDecision {
  if (input.binding && input.binding.expiresAtMs > input.nowMs) {
    return {
      binding: {
        expiresAtMs: input.nowMs + BINDING_IDLE_TIMEOUT_MS,
        threadId: input.binding.threadId,
      },
      kind: "turn",
      route: "binding",
      text: input.text,
      threadId: input.binding.threadId,
    };
  }

  const liveNotificationWindows = input.notificationWindows.filter(
    (window) => window.expiresAtMs > input.nowMs,
  );
  if (liveNotificationWindows.length === 1) {
    const [window] = liveNotificationWindows;
    if (!window) throw new Error("live notification window disappeared");

    return {
      binding: {
        expiresAtMs: input.nowMs + BINDING_IDLE_TIMEOUT_MS,
        threadId: window.threadId,
      },
      kind: "turn",
      route: "notification",
      text: input.text,
      threadId: window.threadId,
    };
  }
  if (liveNotificationWindows.length > 1) {
    return {
      kind: "ambiguousNotificationRoute",
      threadIds: liveNotificationWindows.map((window) => window.threadId),
    };
  }

  return {
    binding: null,
    kind: "turn",
    route: "main",
    text: input.text,
    threadId: input.mainThreadId,
  };
}
