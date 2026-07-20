import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { SqliteState } from "../bridge/sqlite-state.ts";
import {
  AWAY_TIMEOUT_MINUTES_RANGE,
  isInMinuteRange,
  parseMinuteDuration,
  SESSION_TIMEOUT_MINUTES_RANGE,
} from "../domain/user-settings.ts";
import { ILinkClient } from "../ilink/ilink-client.ts";
import {
  isStandaloneExecutable,
  runtimeEntrypoint,
  runtimePackageRoot,
} from "../runtime/package-assets.ts";
import {
  protectForCurrentUser,
  unprotectForCurrentUser,
} from "../windows/dpapi.ts";
import {
  inspectCodexVersion,
  type CodexVersionCommandRunner,
} from "../windows/codex-version.ts";
import {
  findDesktopCodexExecutable,
  hostControlPipePath,
  requestHostControl,
  runWindowsHost,
  type HostStatus,
} from "../windows/host.ts";
import { runtimePaths } from "../windows/runtime-paths.ts";
import {
  disableWindowsStartupTask,
  enableWindowsStartupTask,
  inspectWindowsStartupTask,
} from "../windows/startup-task.ts";
import { runLoginFlow } from "./login-flow.ts";

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 45_000;
const STATUS_RETRY_MS = 100;

export const CLI_HELP = `用法: ilink <command>

  config  查看或修改超时配置
  setup   完成插件安装、微信绑定并启动 Bridge
  login   扫码绑定唯一微信用户；失效时用 login --force
  start   在后台启动微信 Bridge
  startup 管理登录后自动启动
  status  查看 Bridge 状态
  doctor  检查运行环境、Guard、绑定与启动状态
  stop    优雅停止后台 Bridge`;

export type CliIo = {
  error(message: string): void;
  log(message: string): void;
};

export type CliCommands = {
  config(args: readonly string[]): Promise<number>;
  doctor(): Promise<number>;
  login(args: readonly string[]): Promise<number>;
  setup(): Promise<number>;
  start(): Promise<number>;
  startup(args: readonly string[]): Promise<number>;
  status(): Promise<number>;
  stop(): Promise<number>;
};

export type SetupActions = {
  configurePlugin(): Promise<void>;
  configureStartup(): Promise<void>;
  hasUsableSession(): boolean;
  login(): Promise<number>;
  start(): Promise<number>;
};

export type CodexCommandResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

export type CodexCommandRunner = (
  args: readonly string[],
) => CodexCommandResult;

export async function configureCodexPlugin(input: {
  packageRoot: string;
  pluginVersion: string;
  runCodex: CodexCommandRunner;
}): Promise<void> {
  const marketplaces = input.runCodex(["plugin", "marketplace", "list"]);
  requireCodexCommandSuccess(marketplaces, "读取 Codex Marketplace 失败");
  const marketplaceRoot = codexILinkMarketplaceRoot(marketplaces.stdout);
  if (marketplaceRoot && !sameRealPath(marketplaceRoot, input.packageRoot)) {
    const plugins = input.runCodex(["plugin", "list"]);
    requireCodexCommandSuccess(plugins, "读取 Codex 插件状态失败");
    if (/^codex-ilink-probe@codex-ilink\s+installed,/mu.test(plugins.stdout)) {
      requireCodexCommandSuccess(
        input.runCodex(["plugin", "remove", "codex-ilink-probe@codex-ilink"]),
        "移除旧 Codex iLink Guard 失败",
      );
    }
    requireCodexCommandSuccess(
      input.runCodex(["plugin", "marketplace", "remove", "codex-ilink"]),
      "移除旧 Codex iLink Marketplace 失败",
    );
    requireCodexCommandSuccess(
      input.runCodex(["plugin", "marketplace", "add", input.packageRoot]),
      "添加 Codex iLink Marketplace 失败",
    );
    requireCodexCommandSuccess(
      input.runCodex(["plugin", "add", "codex-ilink-probe@codex-ilink"]),
      "安装 Codex iLink Guard 失败",
    );
    return;
  }

  if (!marketplaceRoot) {
    requireCodexCommandSuccess(
      input.runCodex(["plugin", "marketplace", "add", input.packageRoot]),
      "添加 Codex iLink Marketplace 失败",
    );
  }

  const plugins = input.runCodex(["plugin", "list"]);
  requireCodexCommandSuccess(plugins, "读取 Codex 插件状态失败");
  if (installedGuardVersion(plugins.stdout) !== input.pluginVersion) {
    if (/^codex-ilink-probe@codex-ilink\s+installed,/mu.test(plugins.stdout)) {
      requireCodexCommandSuccess(
        input.runCodex(["plugin", "remove", "codex-ilink-probe@codex-ilink"]),
        "移除旧 Codex iLink Guard 失败",
      );
    }
    requireCodexCommandSuccess(
      input.runCodex(["plugin", "add", "codex-ilink-probe@codex-ilink"]),
      "安装 Codex iLink Guard 失败",
    );
  }
}

function installedGuardVersion(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match =
      /^codex-ilink-probe@codex-ilink\s+installed,\s+enabled\s+(\S+)/u.exec(
        line.trim(),
      );
    if (match?.[1]) return match[1];
  }
  return null;
}

function codexILinkMarketplaceRoot(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^codex-ilink\s+(.+)$/u.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function requireCodexCommandSuccess(
  result: CodexCommandResult,
  summary: string,
): void {
  if (result.status === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(detail ? `${summary}：${detail}` : summary);
}

export async function runSetupInstallation(
  io: CliIo,
  actions: SetupActions,
): Promise<number> {
  io.log("[1/4] 正在安装 Codex iLink Guard…");
  await actions.configurePlugin();

  if (actions.hasUsableSession()) {
    io.log("[2/4] 微信已绑定，跳过扫码。");
  } else {
    io.log("[2/4] 正在绑定微信…");
    const loginCode = await actions.login();
    if (loginCode !== 0) return loginCode;
  }

  io.log("[3/4] 正在配置登录后自动启动…");
  await actions.configureStartup();

  io.log("[4/4] 正在启动 Bridge…");
  const startCode = await actions.start();
  if (startCode !== 0) return startCode;

  io.log("安装完成。Codex 出于安全考虑要求人工审核 Hooks；ilink 不会自动信任或绕过审核。");
  io.log("最后一步：刷新或重启 Codex Desktop，打开 Hooks，审核并信任 codex-ilink-probe（Codex iLink Guard）。");
  io.log("Hook 定义变化后需要重新审核；完成信任后即可在微信使用。");
  return 0;
}

export async function runCli(
  argv: readonly string[],
  options: {
    commands?: CliCommands;
    io?: CliIo;
  } = {},
): Promise<number> {
  const io = options.io ?? console;
  const commands = options.commands ?? productionCommands(io);
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.log(CLI_HELP);
    return 0;
  }
  if (
    command !== "config" &&
    command !== "login" &&
    command !== "startup" &&
    command !== "__hook" &&
    argv.length !== 1
  ) {
    io.error(`参数过多。\n${CLI_HELP}`);
    return 2;
  }
  try {
    if (command === "config") return await commands.config(argv.slice(1));
    if (command === "login") return await commands.login(argv.slice(1));
    if (command === "setup") return await commands.setup();
    if (command === "start") return await commands.start();
    if (command === "startup") return await commands.startup(argv.slice(1));
    if (command === "status") return await commands.status();
    if (command === "doctor") return await commands.doctor();
    if (command === "stop") return await commands.stop();
    if (command === "__run") return await runDaemonProcess(io);
    if (command === "__hook") return await runInternalHook(argv.slice(1));
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
  io.error(`未知命令: ${command}\n${CLI_HELP}`);
  return 2;
}

export type DoctorCheck = {
  detail: string;
  level: "error" | "info" | "ok" | "warn";
  name: string;
};

export type DoctorDependencies = {
  currentHostStatus?: typeof currentHostStatus;
  findCodexExecutable?: typeof findDesktopCodexExecutable;
  inspectStartupTask?: typeof inspectWindowsStartupTask;
  runCodex?: CodexVersionCommandRunner;
};

export async function collectDoctorChecks(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (process.platform === "win32") {
    checks.push({ detail: "Windows", level: "ok", name: "系统" });
  } else {
    checks.push({
      detail: "仅支持 Windows",
      level: "error",
      name: "系统",
    });
  }

  if (environment.LOCALAPPDATA) {
    checks.push({
      detail: runtimePaths(environment).dataDirectory,
      level: "ok",
      name: "数据目录",
    });
  } else {
    checks.push({
      detail: "LOCALAPPDATA 未设置",
      level: "error",
      name: "数据目录",
    });
  }

  let codexExecutable: string | undefined;
  try {
    codexExecutable = (dependencies.findCodexExecutable ?? findDesktopCodexExecutable)(
      environment,
    );
    checks.push({
      detail: codexExecutable,
      level: "ok",
      name: "Desktop Codex",
    });
  } catch {
    checks.push({
      detail: "未找到 Codex Desktop 内置 codex.exe",
      level: "error",
      name: "Desktop Codex",
    });
  }

  if (codexExecutable) {
    const runCodex = dependencies.runCodex ?? runCodexCommand;
    const assessment = inspectCodexVersion(
      codexExecutable,
      runCodex,
    );
    checks.push({
      detail: assessment.detail,
      level: assessment.level,
      name: "Codex 版本",
    });
    checks.push(inspectGuardPlugin(codexExecutable, runCodex));
  } else {
    checks.push({
      detail: "无法读取 Codex 版本：未找到 Codex Desktop 内置 codex.exe",
      level: "error",
      name: "Codex 版本",
    });
    checks.push({
      detail: "无法检查：未找到 Codex Desktop 内置 codex.exe",
      level: "error",
      name: "Codex iLink Guard",
    });
  }

  checks.push({
    detail: "需在 Codex Desktop 的 Hooks 页面人工审核；ilink 不自动读取或写入信任状态",
    level: "info",
    name: "Hooks 信任",
  });

  try {
    const startupStatus = (
      dependencies.inspectStartupTask ?? inspectWindowsStartupTask
    )({ environment });
    checks.push({
      detail: startupStatus === "enabled" ? "已启用" : "未启用",
      level: startupStatus === "enabled" ? "ok" : "warn",
      name: "登录启动",
    });
  } catch (error) {
    checks.push({
      detail: `查询失败：${errorMessage(error)}`,
      level: "error",
      name: "登录启动",
    });
  }

  if (environment.LOCALAPPDATA) {
    let state: SqliteState | undefined;
    try {
      const paths = runtimePaths(environment);
      mkdirSync(paths.dataDirectory, { recursive: true });
      state = new SqliteState(paths.stateDatabasePath);
      const diagnostics = state.storageDiagnostics();
      checks.push({
        detail: `schema=${diagnostics.schemaVersion}, WAL=${diagnostics.journalMode}, sync=${diagnostics.synchronous}`,
        level:
          diagnostics.schemaVersion >= 1 &&
          diagnostics.journalMode.toLowerCase() === "wal" &&
          diagnostics.synchronous === "full"
            ? "ok"
            : "error",
        name: "状态库",
      });
      const session = state.getILinkSession();
      if (!session) {
        checks.push({
          detail: "尚未扫码，请运行 ilink login",
          level: "warn",
          name: "微信绑定",
        });
      } else {
        try {
          unprotectForCurrentUser(session.protectedToken);
          checks.push({
            detail: `已绑定 ${session.controllerUserId}`,
            level: "ok",
            name: "微信绑定",
          });
        } catch {
          checks.push({
            detail: "凭证无法由当前 Windows 用户解密",
            level: "error",
            name: "微信绑定",
          });
        }
      }
    } catch (error) {
      checks.push({
        detail: errorMessage(error),
        level: "error",
        name: "状态库",
      });
    } finally {
      state?.close();
    }
  }

  try {
    const status = await (
      dependencies.currentHostStatus ?? currentHostStatus
    )(environment);
    const authExpired = isILinkAuthenticationExpired(status);
    checks.push({
      detail: authExpired
        ? "微信登录已失效；请执行 ilink stop、ilink login --force、ilink start"
        : status
          ? `${status.phase}, PID ${status.pid}`
        : "未运行（可执行 ilink start）",
      level: authExpired ? "error" : status ? "ok" : "warn",
      name: "Bridge",
    });
  } catch (error) {
    checks.push({
      detail: `控制管道异常: ${errorMessage(error)}`,
      level: "error",
      name: "Bridge",
    });
  }
  return checks;
}

export async function currentHostStatus(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HostStatus | null> {
  try {
    const response = await requestHostControl(
      hostControlPipePath(environment),
      "status",
    );
    if (!response.ok) throw new Error(response.error);
    return response.status;
  } catch (error) {
    if (isMissingControlPipe(error)) return null;
    throw error;
  }
}

function productionCommands(io: CliIo): CliCommands {
  return {
    config: (args) => configCommand(io, args),
    doctor: () => doctorCommand(io),
    login: (args) => loginCommand(io, args),
    setup: () => setupCommand(io),
    start: () => startCommand(io),
    startup: (args) => startupCommand(io, args),
    status: () => statusCommand(io),
    stop: () => stopCommand(io),
  };
}

async function setupCommand(io: CliIo): Promise<number> {
  assertWindows();
  requireLocalAppData();
  const packageRoot = installedPackageRoot();
  const codexExecutable = findDesktopCodexExecutable();
  const pluginVersion = installedPluginVersion(packageRoot);
  return runSetupInstallation(io, {
    configurePlugin: () =>
      configureCodexPlugin({
        packageRoot,
        pluginVersion,
        runCodex: (args) => runCodexCommand(codexExecutable, args),
      }),
    configureStartup: async () => enableWindowsStartupTask(daemonLaunch()),
    hasUsableSession: () => hasUsableILinkSession(),
    login: () => loginCommand(io),
    start: () => startCommand(io),
  });
}

function installedPackageRoot(): string {
  return runtimePackageRoot();
}

function installedPluginVersion(packageRoot: string): string {
  const manifestPath = join(
    packageRoot,
    "plugins",
    "codex-ilink-probe",
    ".codex-plugin",
    "plugin.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("E_PLUGIN_VERSION_INVALID");
  }
  return manifest.version;
}

function runCodexCommand(
  executable: string,
  args: readonly string[],
): CodexCommandResult {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    stderr: result.error ? errorMessage(result.error) : (result.stderr ?? ""),
    stdout: result.stdout ?? "",
  };
}

function hasUsableILinkSession(): boolean {
  const state = new SqliteState(runtimePaths().stateDatabasePath);
  try {
    const session = state.getILinkSession();
    if (!session) return false;
    try {
      unprotectForCurrentUser(session.protectedToken);
      return true;
    } catch {
      state.clearILinkSession();
      return false;
    }
  } finally {
    state.close();
  }
}

async function configCommand(
  io: CliIo,
  args: readonly string[],
): Promise<number> {
  assertWindows();
  requireLocalAppData();
  const state = new SqliteState(runtimePaths().stateDatabasePath);
  try {
    if (args.length === 1 && args[0] === "reset") {
      state.resetUserSettings();
      io.log(
        "配置已恢复默认值：workspace + on-request + auto_review；会话 30 分钟，离开 5 分钟。",
      );
      return 0;
    }
    if (args.length === 3 && args[0] === "set") {
      const [_, name, rawDuration] = args;
      if (name === "default-permission") {
        const profile =
          rawDuration === "read-only"
            ? ":read-only"
            : rawDuration === "workspace"
              ? ":workspace"
              : rawDuration === "full-access"
                ? ":danger-full-access"
                : null;
        if (!profile) {
          io.error("默认权限必须是 read-only、workspace 或 full-access。");
          return 2;
        }
        state.setDefaultPermissionProfile(profile);
        io.log(`新会话默认权限已设置为 ${rawDuration}，立即生效。`);
        return 0;
      }
      if (name === "default-approval") {
        if (rawDuration !== "on-request" && rawDuration !== "never") {
          io.error("默认审批必须是 on-request 或 never。");
          return 2;
        }
        state.setDefaultApprovalPolicy(rawDuration);
        io.log(`新会话默认审批已设置为 ${rawDuration}，立即生效。`);
        return 0;
      }
      if (name === "default-reviewer") {
        if (rawDuration !== "auto_review" && rawDuration !== "user") {
          io.error("默认审批人必须是 auto_review 或 user。");
          return 2;
        }
        state.setDefaultApprovalsReviewer(rawDuration);
        io.log(`新会话默认审批人已设置为 ${rawDuration}，立即生效。`);
        return 0;
      }
      const minutes = rawDuration ? parseMinuteDuration(rawDuration) : null;
      if (name === "session-timeout") {
        if (minutes === null || !isInMinuteRange(minutes, SESSION_TIMEOUT_MINUTES_RANGE)) {
          io.error("会话绑定超时必须是 5m 到 1440m。例：ilink config set session-timeout 60m");
          return 2;
        }
        state.setSessionTimeoutMinutes(minutes);
        io.log(`会话绑定超时已设置为 ${String(minutes)} 分钟，立即生效。`);
        return 0;
      }
      if (name === "away-timeout") {
        if (minutes === null || !isInMinuteRange(minutes, AWAY_TIMEOUT_MINUTES_RANGE)) {
          io.error("离开判定时间必须是 1m 到 60m。例：ilink config set away-timeout 10m");
          return 2;
        }
        state.setAwayTimeoutMinutes(minutes);
        io.log(`离开判定时间已设置为 ${String(minutes)} 分钟，立即生效；锁屏仍立即离开。`);
        return 0;
      }
    }
    if (args.length !== 0) {
      io.error("配置参数无效；使用 ilink config 查看当前配置。");
      return 2;
    }
    const settings = state.getBridgeSettings();
    const permissions = state.getDefaultThreadPermissionSettings();
    io.log(
      `新会话默认权限：${permissions.permissions === ":read-only" ? "read-only" : permissions.permissions === ":danger-full-access" ? "full-access" : "workspace"}`,
    );
    io.log(`新会话默认审批：${permissions.approvalPolicy}`);
    io.log(`新会话默认审批人：${permissions.approvalsReviewer}`);
    io.log(`会话绑定超时：${String(settings.sessionTimeoutMinutes)} 分钟`);
    io.log(
      `离开判定时间：${String(settings.awayTimeoutMinutes)} 分钟（锁屏仍立即判定离开）`,
    );
    return 0;
  } finally {
    state.close();
  }
}

async function loginCommand(
  io: CliIo,
  args: readonly string[] = [],
): Promise<number> {
  assertWindows();
  requireLocalAppData();
  const force = args.length === 1 && args[0] === "--force";
  if (args.length > 0 && !force) {
    io.error("用法: ilink login [--force]");
    return 2;
  }
  if (await currentHostStatus()) {
    io.error("Bridge 正在运行，请先执行 ilink stop。");
    return 1;
  }

  const paths = runtimePaths();
  const state = new SqliteState(paths.stateDatabasePath);
  const abort = new AbortController();
  const cancel = (): void => abort.abort(new Error("E_LOGIN_CANCELLED"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const existing = state.getILinkSession();
    if (existing && !force) {
      io.log(
        `已绑定微信用户 ${existing.controllerUserId}，无需重复扫码；若登录已失效，请执行 ilink login --force。`,
      );
      return 0;
    }
    const result = await runLoginFlow({
      ilink: new ILinkClient(),
      now: Date.now,
      protectToken: protectForCurrentUser,
      showQr: (qrUrl) => {
        io.log(`请用微信扫描二维码：${qrUrl}`);
        openQrInBrowser(qrUrl);
      },
      signal: abort.signal,
      sleep: (milliseconds) => abortableDelay(milliseconds, abort.signal),
      state,
    });
    io.log(`绑定成功：${result.controllerUserId}`);
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    state.close();
  }
}

async function startCommand(io: CliIo): Promise<number> {
  assertWindows();
  requireLocalAppData();
  const current = await currentHostStatus();
  if (current) {
    io.log(`Bridge 已在运行：${current.phase}, PID ${current.pid}`);
    return 0;
  }
  const paths = runtimePaths();
  mkdirSync(paths.logDirectory, { recursive: true });

  // Fail synchronously for the common configuration errors instead of
  // starting a detached process that immediately disappears.
  findDesktopCodexExecutable();
  const state = new SqliteState(paths.stateDatabasePath);
  try {
    const session = state.getILinkSession();
    if (!session) {
      io.error("尚未绑定微信，请先执行 ilink login。");
      return 1;
    }
    unprotectForCurrentUser(session.protectedToken);
  } finally {
    state.close();
  }

  const logPath = join(paths.logDirectory, "bridge.log");
  const log = openSync(logPath, "a");
  let child: ChildProcess;
  try {
    const launch = daemonLaunch();
    child = spawn(
      launch.executable,
      launch.args,
      {
        detached: true,
        env: process.env,
        shell: false,
        stdio: ["ignore", log, log],
        windowsHide: true,
      },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
  } finally {
    closeSync(log);
  }

  const status = await waitForHostState(
    (candidate) => candidate?.phase === "running",
    START_TIMEOUT_MS,
  );
  if (!status) {
    io.error(`Bridge 启动失败，请查看 ${logPath}`);
    return 1;
  }
  io.log(`Bridge 已启动：PID ${status.pid}`);
  return 0;
}

function daemonLaunch(): { args: string[]; executable: string } {
  return isStandaloneExecutable()
    ? { args: ["__run"], executable: process.execPath }
    : {
        args: [
          "--disable-warning=ExperimentalWarning",
          runtimeEntrypoint(),
          "__run",
        ],
        executable: process.execPath,
      };
}

async function runInternalHook(argv: readonly string[]): Promise<number> {
  const kind = argv[0];
  const script =
    kind === "lifecycle"
      ? "lifecycle-notify.mjs"
      : kind === "turn"
        ? "turn-lifecycle-hook.mjs"
        : null;
  if (!script) return 2;

  const previousEvent = process.env.CODEX_ILINK_HOOK_EVENT;
  if (kind === "turn" && argv[1]) {
    process.env.CODEX_ILINK_HOOK_EVENT = argv[1];
  }
  try {
    const scriptPath = join(
      runtimePackageRoot(),
      "plugins",
      "codex-ilink-probe",
      "scripts",
      script,
    );
    await import(pathToFileURL(scriptPath).href);
    return 0;
  } finally {
    if (previousEvent === undefined) {
      delete process.env.CODEX_ILINK_HOOK_EVENT;
    } else {
      process.env.CODEX_ILINK_HOOK_EVENT = previousEvent;
    }
  }
}

async function statusCommand(io: CliIo): Promise<number> {
  assertWindows();
  const status = await currentHostStatus();
  if (!status) {
    io.log("Bridge 未运行。");
    return 1;
  }
  io.log(
    `Bridge ${phaseLabel(status.phase)}，PID ${status.pid}，启动于 ${new Date(status.startedAtMs).toLocaleString()}`,
  );
  if (isILinkAuthenticationExpired(status)) {
    io.error(
      "微信登录已失效。请执行：ilink stop → ilink login --force → ilink start",
    );
    return 1;
  }
  return 0;
}

async function startupCommand(
  io: CliIo,
  args: readonly string[],
): Promise<number> {
  assertWindows();
  const action = args[0] ?? "status";
  if (
    args.length > 1 ||
    (action !== "status" && action !== "enable" && action !== "disable")
  ) {
    io.error("用法: ilink startup [status|enable|disable]");
    return 2;
  }
  if (action === "enable") {
    enableWindowsStartupTask(daemonLaunch());
    io.log("已启用登录后自动启动。");
    return 0;
  }
  if (action === "disable") {
    disableWindowsStartupTask();
    io.log("已禁用登录后自动启动；当前 Bridge 不会被停止。");
    return 0;
  }
  const status = inspectWindowsStartupTask();
  io.log(
    status === "enabled"
      ? "登录后自动启动：已启用。"
      : "登录后自动启动：未启用。",
  );
  return status === "enabled" ? 0 : 1;
}

async function doctorCommand(io: CliIo): Promise<number> {
  const checks = await collectDoctorChecks();
  for (const check of checks) {
    const icon =
      check.level === "ok"
        ? "✅"
        : check.level === "warn"
          ? "⚠️"
          : check.level === "info"
            ? "ℹ️"
            : "❌";
    io.log(`${icon} ${check.name}: ${check.detail}`);
  }
  return checks.some((check) => check.level === "error") ? 1 : 0;
}

async function stopCommand(io: CliIo): Promise<number> {
  assertWindows();
  const current = await currentHostStatus();
  if (!current) {
    io.log("Bridge 已停止。");
    return 0;
  }
  let response;
  try {
    response = await requestHostControl(hostControlPipePath(), "stop");
  } catch (error) {
    if (isMissingControlPipe(error)) {
      io.log("Bridge 已停止。");
      return 0;
    }
    if (isUncertainStopAcknowledgement(error)) {
      if (await waitForHostStopped(STOP_TIMEOUT_MS)) {
        io.log("Bridge 已停止。");
        return 0;
      }
    }
    throw error;
  }
  if (!response.ok) {
    io.error(`停止失败：${response.error}`);
    return 1;
  }
  if (!(await waitForHostStopped(STOP_TIMEOUT_MS))) {
    io.error("Bridge 未能在超时前优雅停止。");
    return 1;
  }
  io.log("Bridge 已停止。");
  return 0;
}

async function waitForHostStopped(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await currentHostStatus()) === null) return true;
    } catch (error) {
      if (!isUncertainStopAcknowledgement(error)) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, STATUS_RETRY_MS));
  }
  return false;
}

async function runDaemonProcess(io: CliIo): Promise<number> {
  const abort = new AbortController();
  const stop = (): void => abort.abort(new Error("E_HOST_SIGNAL"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    await runWindowsHost({ signal: abort.signal });
    return 0;
  } catch (error) {
    io.error(`Bridge 退出：${errorMessage(error)}`);
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}

async function waitForHostState(
  predicate: (status: HostStatus | null) => boolean,
  timeoutMs: number,
): Promise<HostStatus | null> {
  const deadline = Date.now() + timeoutMs;
  let last: HostStatus | null = null;
  while (Date.now() < deadline) {
    last = await currentHostStatus();
    if (predicate(last)) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, STATUS_RETRY_MS));
  }
  return last;
}

function openQrInBrowser(qrUrl: string): void {
  let url: URL;
  try {
    url = new URL(qrUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  const child = spawn(
    "rundll32.exe",
    ["url.dll,FileProtocolHandler", url.href],
    {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.on("error", () => undefined);
  child.unref();
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      rejectDelay(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function phaseLabel(phase: HostStatus["phase"]): string {
  if (phase === "running") return "运行中";
  if (phase === "starting") return "启动中";
  return "停止中";
}

function isILinkAuthenticationExpired(status: HostStatus | null): boolean {
  return (
    status?.ilinkAuthPausedUntilMs !== undefined &&
    status.ilinkAuthPausedUntilMs > Date.now()
  );
}

function isMissingControlPipe(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function isUncertainStopAcknowledgement(error: unknown): boolean {
  if (isMissingControlPipe(error)) return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message === "E_HOST_CONTROL_EOF" || message === "E_HOST_CONTROL_TIMEOUT";
}

function assertWindows(): void {
  if (process.platform !== "win32") throw new Error("E_HOST_WINDOWS_ONLY");
}

function requireLocalAppData(): void {
  if (!process.env.LOCALAPPDATA) throw new Error("E_LOCALAPPDATA_REQUIRED");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectGuardPlugin(
  codexExecutable: string,
  runCodex: CodexVersionCommandRunner,
): DoctorCheck {
  let result: CodexCommandResult;
  try {
    result = runCodex(codexExecutable, ["plugin", "list"]);
  } catch (error) {
    return {
      detail: `无法读取插件状态：${errorMessage(error)}`,
      level: "error",
      name: "Codex iLink Guard",
    };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      detail: detail ? `无法读取插件状态：${detail}` : "无法读取插件状态",
      level: "error",
      name: "Codex iLink Guard",
    };
  }
  const version = installedGuardVersion(result.stdout);
  if (version) {
    return {
      detail: `已安装并启用 ${version}`,
      level: "ok",
      name: "Codex iLink Guard",
    };
  }
  return {
    detail: "未安装或未启用，请运行 ilink setup",
    level: "error",
    name: "Codex iLink Guard",
  };
}


function sameRealPath(leftPath: string, rightPath: string): boolean {
  try {
    return (
      realpathSync.native(leftPath).toLowerCase() ===
      realpathSync.native(rightPath).toLowerCase()
    );
  } catch {
    return leftPath.toLowerCase() === rightPath.toLowerCase();
  }
}
