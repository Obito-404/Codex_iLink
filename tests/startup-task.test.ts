import assert from "node:assert/strict";
import test from "node:test";

import {
  disableWindowsStartupTask,
  enableWindowsStartupTask,
  inspectWindowsStartupTask,
  STARTUP_TASK_NAME,
  type StartupTaskPowerShellRunner,
} from "../src/windows/startup-task.ts";

test("startup registration passes an exact daemon launch without PowerShell interpolation", () => {
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
    calls[0]?.environment.CODEX_ILINK_STARTUP_EXECUTABLE,
    "C:\\Program Files\\nodejs\\node.exe",
  );
  assert.equal(
    calls[0]?.environment.CODEX_ILINK_STARTUP_ARGUMENTS,
    '--disable-warning=ExperimentalWarning "C:\\Program Files\\Codex iLink\\main.js" __run',
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
