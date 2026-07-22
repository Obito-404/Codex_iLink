import assert from "node:assert/strict";
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
    },
    { environment: { SYSTEMROOT: "C:\\Windows" }, runPowerShell },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.environment.CODEX_ILINK_STARTUP_TASK, STARTUP_TASK_NAME);
  assert.equal(
    calls[0]?.environment.CODEX_ILINK_STARTUP_ACTION_EXECUTABLE,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  const actionArguments =
    calls[0]?.environment.CODEX_ILINK_STARTUP_ACTION_ARGUMENTS ?? "";
  assert.match(
    actionArguments,
    /^-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/u,
  );
  const encodedCommand = actionArguments.split(" ").at(-1) ?? "";
  const command = Buffer.from(encodedCommand, "base64").toString("utf16le");
  assert.match(command, /Start-Process/u);
  assert.match(command, /-WindowStyle Hidden/u);
  assert.match(command, /\$process\.WaitForExit\(\)/u);
  assert.match(command, /exit \$process\.ExitCode/u);
  assert.match(
    command,
    new RegExp(
      Buffer.from("C:\\Program Files\\nodejs\\node.exe", "utf8").toString(
        "base64",
      ),
      "u",
    ),
  );
  assert.match(
    command,
    new RegExp(
      Buffer.from(
        '--disable-warning=ExperimentalWarning "C:\\Program Files\\Codex iLink\\main.js" __run',
        "utf8",
      ).toString("base64"),
      "u",
    ),
  );
  assert.equal(
    calls[0]?.environment.CODEX_ILINK_STARTUP_ACTION_WORKING_DIRECTORY,
    "C:\\Program Files\\nodejs",
  );
  assert.doesNotMatch(calls[0]?.script ?? "", /Program Files/u);
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
        { args: ["__run"], executable: "C:\\Codex iLink\\ilink.exe" },
        { runPowerShell },
      ),
    /E_STARTUP_TASK_ENABLE:access denied/u,
  );
  assert.throws(
    () => disableWindowsStartupTask({ runPowerShell }),
    /E_STARTUP_TASK_DISABLE:access denied/u,
  );
});
