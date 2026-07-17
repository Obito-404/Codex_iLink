export type InboundIntent =
  | { kind: "approve"; index: number }
  | { kind: "deny"; index: number }
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
  | { kind: "unknownCommand"; text: string };

export const COMMAND_HELP = [
  "/p — projects",
  "/p <n> — select project",
  "/s | /s + | /s arc — sessions",
  "/s <n> — enter session",
  "/new — new session",
  "/exit — return to main",
  "/st — status",
  "/perm | /perm <n> — permissions",
  "/ok <n> | /no <n> — approval",
  "/help — commands",
].join("\n");

export function parseInboundText(text: string): InboundIntent {
  const command = text.trim();
  if (!command.startsWith("/")) return { kind: "message", text };

  switch (command) {
    case "/p":
      return { kind: "projects" };
    case "/s":
      return { kind: "sessions", page: "first" };
    case "/s +":
      return { kind: "sessions", page: "next" };
    case "/s arc":
      return { kind: "sessions", page: "archived" };
    case "/new":
      return { kind: "newSession" };
    case "/exit":
      return { kind: "exitSession" };
    case "/st":
      return { kind: "status" };
    case "/perm":
      return { kind: "permissions" };
    case "/help":
      return { kind: "help" };
  }

  const indexed = /^\/(p|s|perm|ok|no) ([1-9]\d*)$/u.exec(command);
  if (!indexed) return { kind: "unknownCommand", text };
  const index = Number(indexed[2]);
  if (!Number.isSafeInteger(index)) return { kind: "unknownCommand", text };

  switch (indexed[1]) {
    case "p":
      return { index, kind: "selectProject" };
    case "s":
      return { index, kind: "enterSession" };
    case "perm":
      return { index, kind: "selectPermission" };
    case "ok":
      return { index, kind: "approve" };
    case "no":
      return { index, kind: "deny" };
    default:
      return { kind: "unknownCommand", text };
  }
}
