export type SessionBinding = {
  expiresAtMs: number;
  threadId: string;
  updatedAtMs: number;
};

export type NotificationWindow = {
  deliveredAtMs: number;
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
  binding: Omit<SessionBinding, "updatedAtMs"> | null;
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
  const activeBinding =
    input.binding && input.binding.expiresAtMs > input.nowMs
      ? input.binding
      : null;
  const liveNotificationWindows = input.notificationWindows.filter(
    (window) => window.expiresAtMs > input.nowMs,
  );
  const bindingSupersedesNotifications =
    activeBinding &&
    liveNotificationWindows.every(
      (window) => window.deliveredAtMs <= activeBinding.updatedAtMs,
    );
  if (bindingSupersedesNotifications) {
    return {
      binding: {
        expiresAtMs: input.nowMs + BINDING_IDLE_TIMEOUT_MS,
        threadId: activeBinding.threadId,
      },
      kind: "turn",
      route: "binding",
      text: input.text,
      threadId: activeBinding.threadId,
    };
  }
  if (liveNotificationWindows.length > 1) {
    return {
      kind: "ambiguousNotificationRoute",
      threadIds: liveNotificationWindows.map((window) => window.threadId),
    };
  }
  const [notificationWindow] = liveNotificationWindows;
  if (notificationWindow) {
    return {
      binding: {
        expiresAtMs: input.nowMs + BINDING_IDLE_TIMEOUT_MS,
        threadId: notificationWindow.threadId,
      },
      kind: "turn",
      route: "notification",
      text: input.text,
      threadId: notificationWindow.threadId,
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
