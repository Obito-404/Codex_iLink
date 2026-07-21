import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseDesktopPermissionSelection,
  readDesktopPermissionSelection,
} from "../src/windows/desktop-permissions.ts";

test("Desktop permission modes map to the exact thread/start settings", () => {
  const selection = (mode: string) =>
    parseDesktopPermissionSelection({
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: mode },
      },
    });

  assert.deepEqual(selection("auto"), {
    kind: "ask-for-approval",
    settings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: ":workspace",
    },
  });
  assert.deepEqual(selection("guardian-approvals"), {
    kind: "approve-for-me",
    settings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      permissions: ":workspace",
    },
  });
  assert.deepEqual(selection("full-access"), {
    kind: "full-access",
    settings: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: ":danger-full-access",
    },
  });
});

test("a missing local Desktop permission mode uses Desktop's auto fallback", () => {
  assert.deepEqual(parseDesktopPermissionSelection({}), {
    kind: "ask-for-approval",
    settings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: ":workspace",
    },
  });
});

test("unknown or malformed Desktop permission modes fail closed", () => {
  for (const value of [
    {
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: "future-mode" },
      },
    },
    {
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: 1 },
      },
    },
  ]) {
    assert.throws(
      () => parseDesktopPermissionSelection(value),
      /E_DESKTOP_PERMISSION_MODE_INVALID/u,
    );
  }
});

test("Desktop permission loading falls back to the fixed backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-desktop-permissions-"));
  const primaryPath = join(directory, ".codex-global-state.json");
  try {
    writeFileSync(primaryPath, "{not-json", "utf8");
    writeFileSync(
      `${primaryPath}.bak`,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "agent-mode-by-host-id": { local: "guardian-approvals" },
        },
      }),
      "utf8",
    );

    assert.deepEqual(readDesktopPermissionSelection(primaryPath), {
      kind: "approve-for-me",
      settings: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        permissions: ":workspace",
      },
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Desktop permission loading reports both missing state files", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-desktop-permissions-"));
  const primaryPath = join(directory, ".codex-global-state.json");
  try {
    assert.throws(
      () => readDesktopPermissionSelection(primaryPath),
      (error) =>
        error instanceof AggregateError &&
        error.message === "E_DESKTOP_PERMISSION_STATE_UNAVAILABLE" &&
        error.errors.length === 2,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Desktop permission loading reports when primary and backup are invalid", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-desktop-permissions-"));
  const primaryPath = join(directory, ".codex-global-state.json");
  try {
    writeFileSync(primaryPath, "{not-json", "utf8");
    writeFileSync(`${primaryPath}.bak`, "{also-not-json", "utf8");

    assert.throws(
      () => readDesktopPermissionSelection(primaryPath),
      (error) =>
        error instanceof AggregateError &&
        error.message === "E_DESKTOP_PERMISSION_STATE_UNAVAILABLE" &&
        error.errors.length === 2,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a semantic error in primary state never falls back to stale full access", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-desktop-permissions-"));
  const primaryPath = join(directory, ".codex-global-state.json");
  try {
    writeFileSync(
      primaryPath,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "agent-mode-by-host-id": { local: "future-mode" },
        },
      }),
      "utf8",
    );
    writeFileSync(
      `${primaryPath}.bak`,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "agent-mode-by-host-id": { local: "full-access" },
        },
      }),
      "utf8",
    );

    assert.throws(
      () => readDesktopPermissionSelection(primaryPath),
      /E_DESKTOP_PERMISSION_MODE_INVALID/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an oversized primary state never falls back to stale full access", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-desktop-permissions-"));
  const primaryPath = join(directory, ".codex-global-state.json");
  try {
    writeFileSync(primaryPath, Buffer.alloc(1024 * 1024 + 1));
    writeFileSync(
      `${primaryPath}.bak`,
      JSON.stringify({
        "electron-persisted-atom-state": {
          "agent-mode-by-host-id": { local: "full-access" },
        },
      }),
      "utf8",
    );

    assert.throws(
      () => readDesktopPermissionSelection(primaryPath),
      /E_DESKTOP_PERMISSION_STATE_TOO_LARGE/u,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
