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

test("Desktop project ids resolve through local-projects before ordering roots", () => {
  assert.deepEqual(
    parseDesktopProjects({
      "electron-saved-workspace-roots": [
        "D:\\ContextOS",
        "D:\\Codex_iLink",
      ],
      "local-projects": {
        "local-codex": {
          id: "local-codex",
          name: "Codex iLink",
          rootPaths: ["D:\\Codex_iLink"],
        },
        "local-context": {
          id: "local-context",
          name: "Context OS",
          rootPaths: ["D:\\ContextOS"],
        },
      },
      "project-order": ["local-codex", "local-context"],
    }),
    [
      { cwd: "D:\\Codex_iLink", name: "Codex_iLink" },
      { cwd: "D:\\ContextOS", name: "ContextOS" },
    ],
  );
});

test("ordered local projects supplement legacy saved workspace roots", () => {
  assert.deepEqual(
    parseDesktopProjects({
      "electron-saved-workspace-roots": ["D:\\Legacy"],
      "local-projects": {
        "local-current": {
          id: "local-current",
          name: "Codex iLink",
          rootPaths: ["D:\\Codex_iLink"],
        },
        "local-stale": {
          id: "local-stale",
          name: "Stale",
          rootPaths: ["D:\\Stale"],
        },
      },
      "project-order": [
        "local-current",
        "D:\\NotSaved",
        "D:\\Legacy",
      ],
    }),
    [
      { cwd: "D:\\Codex_iLink", name: "Codex_iLink" },
      { cwd: "D:\\Legacy", name: "Legacy" },
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
