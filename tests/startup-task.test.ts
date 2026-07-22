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
  assert.equal(
    actionArguments,
    '//B //NoLogo "C:\\Program Files\\Codex iLink\\dist\\windows\\startup-host.vbs" ' +
      `${utf16Hex("C:\\Program Files\\nodejs\\node.exe")} ${utf16Hex(argumentLine)}`,
  );
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
      utf16Hex(process.execPath),
      utf16Hex('-e process.exit(process.argv[1].length) "hello world"'),
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

function utf16Hex(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}
