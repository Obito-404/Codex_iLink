import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuntimePaths = {
  dataDirectory: string;
  inboxDirectory: string;
  logDirectory: string;
  mediaDirectory: string;
  pipePath: string;
  spoolDirectory: string;
  stateDatabasePath: string;
};

export function runtimePaths(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const dataDirectory = join(
    environment.LOCALAPPDATA ?? homedir(),
    "Codex_iLink",
  );
  return {
    dataDirectory,
    inboxDirectory: join(dataDirectory, "Inbox"),
    logDirectory: join(dataDirectory, "logs"),
    mediaDirectory: join(dataDirectory, "media", "inbound"),
    pipePath: userPipePath(environment),
    spoolDirectory: join(dataDirectory, "spool"),
    stateDatabasePath: join(dataDirectory, "state.sqlite"),
  };
}

export function userPipePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const identity = `${environment.USERPROFILE ?? homedir()}|${
    environment.USERNAME ?? "user"
  }`;
  const suffix = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 16);
  return `\\\\.\\pipe\\codex-ilink-${suffix}`;
}
