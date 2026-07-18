import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve(
  "plugins/codex-ilink-probe/scripts/capture-hook.ps1",
);

test("hook script captures only routing metadata and stays silent", () => {
  const probeDir = mkdtempSync(join(tmpdir(), "codex-ilink-hook-"));

  try {
    const result = spawnSync(
      process.env.CODEX_ILINK_PWSH ?? "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ILINK_PROBE_DIR: probeDir },
        input: JSON.stringify({
          session_id: "thread-123",
          turn_id: "turn-456",
          cwd: "D:\\Codex_iLink",
          hook_event_name: "UserPromptSubmit",
          model: "gpt-test",
          permission_mode: "default",
          tool_name: "Bash",
          tool_input: { command: "do not persist this command" },
          transcript_path: "C:\\secret\\transcript.jsonl",
          prompt: "do not persist this prompt",
        }),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");

    const lines = readFileSync(join(probeDir, "hooks.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u);
    assert.equal(lines.length, 1);

    const event = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.deepEqual(
      {
        sessionId: event.sessionId,
        turnId: event.turnId,
        cwd: event.cwd,
        eventName: event.eventName,
        model: event.model,
        permissionMode: event.permissionMode,
        toolName: event.toolName,
      },
      {
        sessionId: "thread-123",
        turnId: "turn-456",
        cwd: "D:\\Codex_iLink",
        eventName: "UserPromptSubmit",
        model: "gpt-test",
        permissionMode: "default",
        toolName: "Bash",
      },
    );
    assert.equal(JSON.stringify(event).includes("transcript"), false);
    assert.equal(JSON.stringify(event).includes("do not persist"), false);
  } finally {
    rmSync(probeDir, { force: true, recursive: true });
  }
});
