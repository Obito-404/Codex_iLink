import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

export const STARTUP_TASK_NAME = "Codex iLink Bridge";
const TASK_DISABLED_EXIT_CODE = 3;

const ENABLE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction ` +
  String.raw`-Execute $env:CODEX_ILINK_STARTUP_ACTION_EXECUTABLE ` +
  String.raw`-Argument $env:CODEX_ILINK_STARTUP_ACTION_ARGUMENTS ` +
  String.raw`-WorkingDirectory $env:CODEX_ILINK_STARTUP_ACTION_WORKING_DIRECTORY
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries ` +
  String.raw`-DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden ` +
  String.raw`-MultipleInstances IgnoreNew -RestartCount 3 ` +
  String.raw`-RestartInterval (New-TimeSpan -Minutes 1) ` +
  String.raw`-ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $env:CODEX_ILINK_STARTUP_TASK ` +
  String.raw`-Action $action -Trigger $trigger -Principal $principal ` +
  String.raw`-Settings $settings -Description "Start Codex iLink after user logon" ` +
  String.raw`-Force | Out-Null
`;

const DISABLE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $env:CODEX_ILINK_STARTUP_TASK -ErrorAction SilentlyContinue
if ($null -ne $task) {
  Unregister-ScheduledTask -TaskName $env:CODEX_ILINK_STARTUP_TASK -Confirm:$false
}
`;

const STATUS_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $env:CODEX_ILINK_STARTUP_TASK -ErrorAction SilentlyContinue
if ($null -eq $task -or $task.State -eq "Disabled") { exit ${TASK_DISABLED_EXIT_CODE} }
exit 0
`;

export type StartupTaskPowerShellInput = {
  environment: NodeJS.ProcessEnv;
  script: string;
};

export type StartupTaskPowerShellResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

export type StartupTaskPowerShellRunner = (
  input: StartupTaskPowerShellInput,
) => StartupTaskPowerShellResult;

type StartupTaskOptions = {
  environment?: NodeJS.ProcessEnv;
  runPowerShell?: StartupTaskPowerShellRunner;
};

export function enableWindowsStartupTask(
  launch: { args: readonly string[]; executable: string },
  options: StartupTaskOptions = {},
): void {
  if (!isAbsolute(launch.executable) || launch.executable.includes("\0")) {
    throw new Error("E_STARTUP_TASK_INVALID_EXECUTABLE");
  }
  if (launch.args.some((argument) => argument.includes("\0"))) {
    throw new Error("E_STARTUP_TASK_INVALID_ARGUMENT");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const action = hiddenStartupAction(launch, sourceEnvironment);
  const environment = startupEnvironment(options.environment, {
    CODEX_ILINK_STARTUP_ACTION_ARGUMENTS: action.args,
    CODEX_ILINK_STARTUP_ACTION_EXECUTABLE: action.executable,
    CODEX_ILINK_STARTUP_ACTION_WORKING_DIRECTORY: dirname(launch.executable),
  });
  requireSuccess(
    (options.runPowerShell ?? runPowerShell)({
      environment,
      script: ENABLE_SCRIPT,
    }),
    "ENABLE",
  );
}

function hiddenStartupAction(
  launch: { args: readonly string[]; executable: string },
  environment: NodeJS.ProcessEnv,
): { args: string; executable: string } {
  const systemRoot = environmentValue(environment, "SystemRoot");
  if (!systemRoot || !isAbsolute(systemRoot) || systemRoot.includes("\0")) {
    throw new Error("E_STARTUP_TASK_INVALID_SYSTEM_ROOT");
  }
  const executable = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const command = String.raw`
$ErrorActionPreference = "Stop"
$executable = ${decodeBase64Expression(launch.executable)}
$arguments = ${decodeBase64Expression(serializeWindowsArguments(launch.args))}
$workingDirectory = ${decodeBase64Expression(dirname(launch.executable))}
$process = Start-Process -FilePath $executable -ArgumentList $arguments ` +
    String.raw`-WorkingDirectory $workingDirectory -WindowStyle Hidden -PassThru
$process.WaitForExit()
exit $process.ExitCode
`;
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  return {
    args:
      "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
      `-WindowStyle Hidden -EncodedCommand ${encodedCommand}`,
    executable,
  };
}

function decodeBase64Expression(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encoded}"))`;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(environment).find(
    ([key]) => key.toLowerCase() === normalized,
  )?.[1];
}

export function disableWindowsStartupTask(
  options: StartupTaskOptions = {},
): void {
  requireSuccess(
    (options.runPowerShell ?? runPowerShell)({
      environment: startupEnvironment(options.environment),
      script: DISABLE_SCRIPT,
    }),
    "DISABLE",
  );
}

export function inspectWindowsStartupTask(
  options: StartupTaskOptions = {},
): "disabled" | "enabled" {
  const result = (options.runPowerShell ?? runPowerShell)({
    environment: startupEnvironment(options.environment),
    script: STATUS_SCRIPT,
  });
  if (result.status === 0) return "enabled";
  if (result.status === TASK_DISABLED_EXIT_CODE) return "disabled";
  throw startupTaskError("STATUS", result);
}

function startupEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  values: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...values,
    CODEX_ILINK_STARTUP_TASK: STARTUP_TASK_NAME,
  };
}

function runPowerShell(
  input: StartupTaskPowerShellInput,
): StartupTaskPowerShellResult {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      input.script,
    ],
    {
      encoding: "utf8",
      env: input.environment,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function requireSuccess(
  result: StartupTaskPowerShellResult,
  operation: "DISABLE" | "ENABLE",
): void {
  if (result.status !== 0) throw startupTaskError(operation, result);
}

function startupTaskError(
  operation: "DISABLE" | "ENABLE" | "STATUS",
  result: StartupTaskPowerShellResult,
): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    detail
      ? `E_STARTUP_TASK_${operation}:${detail}`
      : `E_STARTUP_TASK_${operation}`,
  );
}

function serializeWindowsArguments(arguments_: readonly string[]): string {
  return arguments_.map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""';
  if (!/[\s"]/u.test(argument)) return argument;

  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + character;
    }
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}
