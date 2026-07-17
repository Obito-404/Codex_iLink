export type InboundIntent =
  | { code: string | null; kind: "approve" }
  | { code: string | null; kind: "deny" }
  | { kind: "clearSession" }
  | { kind: "compactSession" }
  | { kind: "enterSession"; index: number }
  | { kind: "exitSession" }
  | { kind: "help" }
  | { kind: "message"; text: string }
  | { kind: "newSession" }
  | { kind: "permissions" }
  | { kind: "projects" }
  | { kind: "selectPermission"; index: number }
  | { kind: "selectProject"; index: number }
  | { kind: "sessions"; page: "archived" | "first" | "next" }
  | { kind: "status" }
  | { kind: "stopTurn" }
  | { kind: "unknownCommand"; text: string };

export const COMMAND_HELP = [
  "p — projects",
  "p<n> — select project",
  "s | s+ | sarc — sessions",
  "s<n> — enter session",
  "new — new session",
  "clear — clear context in a new session",
  "compact — compact current context",
  "stop — stop current turn",
  "exit — return to main",
  "st — status",
  "perm | perm<n> — permissions",
  "ok[code] | no[code] — approval",
  "help — commands",
].join("\n");

export function parseInboundText(text: string): InboundIntent {
  const command = text.trim();

  switch (command) {
    case "p":
      return { kind: "projects" };
    case "s":
      return { kind: "sessions", page: "first" };
    case "s+":
      return { kind: "sessions", page: "next" };
    case "sarc":
      return { kind: "sessions", page: "archived" };
    case "new":
      return { kind: "newSession" };
    case "clear":
      return { kind: "clearSession" };
    case "compact":
      return { kind: "compactSession" };
    case "stop":
      return { kind: "stopTurn" };
    case "exit":
      return { kind: "exitSession" };
    case "st":
      return { kind: "status" };
    case "perm":
      return { kind: "permissions" };
    case "help":
      return { kind: "help" };
  }

  const approval = /^(ok|no)([a-f][a-f\d]{5})?$/iu.exec(command);
  if (approval) {
    return {
      code: approval[2]?.toUpperCase() ?? null,
      kind: approval[1]?.toLowerCase() === "ok" ? "approve" : "deny",
    };
  }

  const indexed = /^(p|s|perm)([1-9]\d*)$/u.exec(command);
  if (!indexed) {
    return isReservedCommandShape(command)
      ? { kind: "unknownCommand", text }
      : { kind: "message", text };
  }
  const index = Number(indexed[2]);
  if (!Number.isSafeInteger(index)) return { kind: "unknownCommand", text };

  switch (indexed[1]) {
    case "p":
      return { index, kind: "selectProject" };
    case "s":
      return { index, kind: "enterSession" };
    case "perm":
      return { index, kind: "selectPermission" };
    default:
      return { kind: "unknownCommand", text };
  }
}

function isReservedCommandShape(command: string): boolean {
  return (
    command.startsWith("/") ||
    /^go(?:$|\s*\d+$)/iu.test(command) ||
    /^perm(?:\s|[+\-.\d])/iu.test(command) ||
    /^(?:p|s)(?:\s|[+\-.\d])/u.test(command) ||
    /^(?:ok|no)(?:\s|[a-f\d]+$)/iu.test(command)
  );
}
