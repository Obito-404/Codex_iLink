import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  desktopProjectStatePath,
  parseDesktopProjects,
  readDesktopProjects,
} from "../src/windows/desktop-projects.ts";

test("Desktop saved workspace roots define the project set, order, and names", () => {
  assert.deepEqual(
    parseDesktopProjects({
      "electron-saved-workspace-roots": [
        "D:\\ContextOS\\",
        "D:\\Codex_iLink",
        "D:\\project\\ExcelMapper",
        "d:\\codex_ilink\\",
      ],
      "project-order": [
        "D:\\Codex_iLink",
        "C:\\Windows\\System32",
        "D:\\project\\ExcelMapper",
      ],
    }),
    [
      { cwd: "D:\\Codex_iLink", name: "Codex_iLink" },
      { cwd: "D:\\project\\ExcelMapper", name: "ExcelMapper" },
      { cwd: "D:\\ContextOS", name: "ContextOS" },
    ],
  );
});

test("Desktop project loading falls back to the fixed backup and ignores stale temp files", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-desktop-projects-"));
  const primaryPath = join(directory, ".codex-global-state.json");
  try {
    writeFileSync(primaryPath, "{not-json", "utf8");
    writeFileSync(
      `${primaryPath}.bak`,
      JSON.stringify({
        "electron-saved-workspace-roots": ["D:\\Current"],
        "project-order": ["D:\\Current"],
      }),
      "utf8",
    );
    writeFileSync(
      join(directory, "..codex-global-state.json.tmp-stale"),
      JSON.stringify({
        "electron-saved-workspace-roots": ["D:\\Stale"],
        "project-order": ["D:\\Stale"],
      }),
      "utf8",
    );

    assert.deepEqual(readDesktopProjects(primaryPath), [
      { cwd: "D:\\Current", name: "Current" },
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Desktop project state follows the configured Codex home", () => {
  assert.equal(
    desktopProjectStatePath({ CODEX_HOME: "D:\\PortableCodex" }),
    "D:\\PortableCodex\\.codex-global-state.json",
  );
});
