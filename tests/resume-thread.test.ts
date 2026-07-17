import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const probe = resolve("src/probes/resume-thread.ts");
const fakeAppServer = resolve("tests/fixtures/fake-app-server.mjs");

test("resume probe inherits the thread configuration without overrides", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", probe, "--thread", "thread-fixture"],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CODEX_API_KEY: "invalid-key-that-must-not-reach-app-server",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
        CODEX_THREAD_ID: "parent-desktop-thread-that-must-not-be-inherited",
        CODEX_ILINK_APP_SERVER_COMMAND: JSON.stringify([
          process.execPath,
          fakeAppServer,
        ]),
        OPENAI_API_KEY: "another-invalid-key-that-must-not-reach-app-server",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(report, {
    ok: true,
    threadId: "thread-fixture",
    inherited: {
      model: "gpt-fixture",
      modelProvider: "fixture-provider",
      cwd: "D:\\Fixture",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        networkAccess: false,
        writableRoots: [],
      },
      reasoningEffort: "high",
    },
    status: { type: "idle" },
  });
});
