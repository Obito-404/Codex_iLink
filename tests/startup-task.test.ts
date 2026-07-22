import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import {
  disableWindowsStartupTask,
  enableWindowsStartupTask,
  inspectWindowsStartupTask,
  STARTUP_TASK_NAME,
  type StartupTaskPowerShellRunner,
} from "../src/windows/startup-task.ts";

test("startup registration wraps the exact daemon launch in a hidden supervised host", () => {
  const calls: Parameters<StartupTaskPowerShellRunner>[0][] = [];
  const runPowerShell: StartupTaskPowerShellRunner = (input) => {
    calls.push(input);
    return { status: 0, stderr: "", stdout: "" };
  };

  enableWindowsStartupTask(
    {
      args: [
        "--disable-warning=ExperimentalWarning",
        "C:\\Program Files\\Codex iLink\\main.js",
        "__run",
      ],
      executable: "C:\\Program Files\\nodejs\\node.exe",
      hostScript:
        "C:\\Program Files\\Codex iLink\\dist\\windows\\startup-host.vbs",
    },
    { environment: { SYSTEMROOT: "C:\\Windows" }, runPowerShell },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.environment.CODEX_ILINK_STARTUP_TASK, STARTUP_TASK_NAME);
  assert.equal(
    calls[0]?.environment.CODEX_ILINK_STARTUP_ACTION_EXECUTABLE,
    "C:\\Windows\\System32\\wscript.exe",
  );
  const argumentLine =
    '--disable-warning=ExperimentalWarning "C:\\Program Files\\Codex iLink\\main.js" __run';
  const actionArguments =
    calls[0]?.environment.CODEX_ILINK_STARTUP_ACTION_ARGUMENTS ?? "";
  const actionMatch =
    /^\/\/B \/\/NoLogo "C:\\Program Files\\Codex iLink\\dist\\windows\\startup-host\.vbs" ([0-9a-f]+) ([0-9a-f]+)$/u.exec(
      actionArguments,
    );
  assert.ok(actionMatch);
  assert.equal(
    decodeUtf16Hex(actionMatch[1] ?? ""),
    "C:\\Program Files\\nodejs\\node.exe",
  );
  assert.equal(decodeUtf16Hex(actionMatch[2] ?? ""), argumentLine);
  assert.equal(
    calls[0]?.environment.CODEX_ILINK_STARTUP_ACTION_WORKING_DIRECTORY,
    "C:\\Program Files\\nodejs",
  );
  assert.doesNotMatch(calls[0]?.script ?? "", /Program Files/u);
});

test("windowless startup host waits for the daemon and returns its exit code", () => {
  const result = spawnSync(
    resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    [
      "//B",
      "//NoLogo",
      resolve("src/windows/startup-host.vbs"),
      encodeUtf16HexFixture(process.execPath),
      encodeUtf16HexFixture(
        '-e process.exit(process.argv[1].length) "hello world"',
      ),
    ],
    { shell: false, timeout: 10_000, windowsHide: true },
  );

  assert.equal(result.status, 11, result.error?.message);
});

test("startup inspection distinguishes enabled and absent tasks", () => {
  const results = [
    { status: 0, stderr: "", stdout: "" },
    { status: 3, stderr: "", stdout: "" },
  ];
  const runPowerShell: StartupTaskPowerShellRunner = () => results.shift()!;

  assert.equal(inspectWindowsStartupTask({ runPowerShell }), "enabled");
  assert.equal(inspectWindowsStartupTask({ runPowerShell }), "disabled");
});

test("startup registration and removal fail closed on task scheduler errors", () => {
  const runPowerShell: StartupTaskPowerShellRunner = () => ({
    status: 1,
    stderr: "access denied",
    stdout: "",
  });

  assert.throws(
    () =>
      enableWindowsStartupTask(
        {
          args: ["__run"],
          executable: "C:\\Codex iLink\\ilink.exe",
          hostScript: "C:\\Codex iLink\\startup-host.vbs",
        },
        { runPowerShell },
      ),
    /E_STARTUP_TASK_ENABLE:access denied/u,
  );
  assert.throws(
    () => disableWindowsStartupTask({ runPowerShell }),
    /E_STARTUP_TASK_DISABLE:access denied/u,
  );
});

function encodeUtf16HexFixture(value: string): string {
  return Buffer.from(value, "utf16le").swap16().toString("hex");
}

function decodeUtf16Hex(value: string): string {
  return Buffer.from(value, "hex").swap16().toString("utf16le");
}
