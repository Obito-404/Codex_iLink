#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { SqliteState } from "../bridge/sqlite-state.ts";
import { ILinkClient } from "../ilink/ilink-client.ts";
import {
  protectForCurrentUser,
  unprotectForCurrentUser,
} from "../windows/dpapi.ts";
import {
  findDesktopCodexExecutable,
  hostControlPipePath,
  requestHostControl,
  runWindowsHost,
  type HostStatus,
} from "../windows/host.ts";
import { runtimePaths } from "../windows/runtime-paths.ts";
import { runLoginFlow } from "./login-flow.ts";

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 45_000;
const STATUS_RETRY_MS = 100;

export const CLI_HELP = `用法: ilink <command>

  login   扫码绑定唯一微信用户
  start   在后台启动微信 Bridge
  status  查看 Bridge 状态
  doctor  检查运行环境与绑定状态
  stop    优雅停止后台 Bridge`;

export type CliIo = {
  error(message: string): void;
  log(message: string): void;
};

export type CliCommands = {
  doctor(): Promise<number>;
  login(): Promise<number>;
  start(): Promise<number>;
  status(): Promise<number>;
  stop(): Promise<number>;
};

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
  if (argv.length !== 1) {
    io.error(`参数过多。\n${CLI_HELP}`);
    return 2;
  }
  try {
    if (command === "login") return await commands.login();
    if (command === "start") return await commands.start();
    if (command === "status") return await commands.status();
    if (command === "doctor") return await commands.doctor();
    if (command === "stop") return await commands.stop();
    if (command === "__run") return await runDaemonProcess(io);
  } catch (error) {
    io.error(errorMessage(error));
    return 1;
  }
  io.error(`未知命令: ${command}\n${CLI_HELP}`);
  return 2;
}

export type DoctorCheck = {
  detail: string;
  level: "error" | "ok" | "warn";
  name: string;
};

export async function collectDoctorChecks(
  environment: NodeJS.ProcessEnv = process.env,
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

  try {
    checks.push({
      detail: findDesktopCodexExecutable(environment),
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
    const status = await currentHostStatus(environment);
    checks.push({
      detail: status
        ? `${status.phase}, PID ${status.pid}`
        : "未运行（可执行 ilink start）",
      level: status ? "ok" : "warn",
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
    doctor: () => doctorCommand(io),
    login: () => loginCommand(io),
    start: () => startCommand(io),
    status: () => statusCommand(io),
    stop: () => stopCommand(io),
  };
}

async function loginCommand(io: CliIo): Promise<number> {
  assertWindows();
  requireLocalAppData();
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
    if (existing) {
      io.log(`已绑定微信用户 ${existing.controllerUserId}，无需重复扫码。`);
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
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url), "__run"],
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
  return 0;
}

async function doctorCommand(io: CliIo): Promise<number> {
  const checks = await collectDoctorChecks();
  for (const check of checks) {
    const icon = check.level === "ok" ? "✅" : check.level === "warn" ? "⚠️" : "❌";
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

const invokedPath = process.argv[1];
if (
  invokedPath &&
  fileURLToPath(import.meta.url).toLowerCase() === invokedPath.toLowerCase()
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
