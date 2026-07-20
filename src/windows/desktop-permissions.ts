import { readFileSync } from "node:fs";

import type { ThreadPermissionSettings } from "../codex/protocol.ts";

export type DesktopPermissionKind =
  | "approve-for-me"
  | "ask-for-approval"
  | "full-access";

export type DesktopPermissionSelection = {
  kind: DesktopPermissionKind;
  settings: Required<ThreadPermissionSettings>;
};

const MAX_DESKTOP_PERMISSION_STATE_BYTES = 1024 * 1024;

export function readDesktopPermissionSelection(
  primaryPath: string,
): DesktopPermissionSelection {
  const errors: unknown[] = [];
  for (const path of [primaryPath, `${primaryPath}.bak`]) {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (raw.byteLength > MAX_DESKTOP_PERMISSION_STATE_BYTES) {
      throw new Error("E_DESKTOP_PERMISSION_STATE_TOO_LARGE");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8")) as unknown;
    } catch (error) {
      errors.push(error);
      continue;
    }
    return parseDesktopPermissionSelection(value);
  }
  throw new AggregateError(
    errors,
    "E_DESKTOP_PERMISSION_STATE_UNAVAILABLE",
  );
}

export function parseDesktopPermissionSelection(
  value: unknown,
): DesktopPermissionSelection {
  if (!isRecord(value)) throw invalidDesktopPermissionMode();
  const atoms = value["electron-persisted-atom-state"];
  if (atoms === undefined) return autoPermissionSelection();
  if (!isRecord(atoms)) throw invalidDesktopPermissionMode();
  const modes = atoms["agent-mode-by-host-id"];
  if (modes === undefined) return autoPermissionSelection();
  if (!isRecord(modes)) throw invalidDesktopPermissionMode();

  switch (modes.local) {
    case undefined:
    case "auto":
      return autoPermissionSelection();
    case "guardian-approvals":
      return {
        kind: "approve-for-me",
        settings: {
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          permissions: ":workspace",
        },
      };
    case "full-access":
      return {
        kind: "full-access",
        settings: {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          permissions: ":danger-full-access",
        },
      };
    default:
      throw invalidDesktopPermissionMode();
  }
}

function autoPermissionSelection(): DesktopPermissionSelection {
  return {
    kind: "ask-for-approval",
    settings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: ":workspace",
    },
  };
}

export function desktopPermissionLabel(kind: DesktopPermissionKind): string {
  switch (kind) {
    case "ask-for-approval":
      return "请求批准";
    case "approve-for-me":
      return "替我审批";
    case "full-access":
      return "完全访问权限";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidDesktopPermissionMode(): Error {
  return new Error("E_DESKTOP_PERMISSION_MODE_INVALID");
}
