import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_HELP,
  configureCodexPlugin,
  runCli,
  runSetupInstallation,
  type CliCommands,
  type SetupActions,
} from "../src/cli/ilink.ts";

function fixtureCommands(calls: string[]): CliCommands {
  return {
    config: async (args) => {
      calls.push(["config", ...args].join(" "));
      return 9;
    },
    doctor: async () => {
      calls.push("doctor");
      return 10;
    },
    login: async () => {
      calls.push("login");
      return 11;
    },
    setup: async () => {
      calls.push("setup");
      return 15;
    },
    start: async () => {
      calls.push("start");
      return 12;
    },
    startup: async (args) => {
      calls.push(["startup", ...args].join(" "));
      return 16;
    },
    status: async () => {
      calls.push("status");
      return 13;
    },
    stop: async () => {
      calls.push("stop");
      return 14;
    },
  };
}

test("CLI exposes its eight public commands", async () => {
  for (const [command, expectedCode] of [
    ["config", 9],
    ["doctor", 10],
    ["login", 11],
    ["setup", 15],
    ["start", 12],
    ["startup", 16],
    ["status", 13],
    ["stop", 14],
  ] as const) {
    const calls: string[] = [];
    const output: string[] = [];
    const code = await runCli([command], {
      commands: fixtureCommands(calls),
      io: {
        error: (message) => output.push(`error:${message}`),
        log: (message) => output.push(`log:${message}`),
      },
    });
    assert.equal(code, expectedCode);
    assert.deepEqual(calls, [command]);
    assert.deepEqual(output, []);
  }
});

test("CLI help is concise and does not invoke a command", async () => {
  const calls: string[] = [];
  const output: string[] = [];
  const code = await runCli([], {
    commands: fixtureCommands(calls),
    io: {
      error: (message) => output.push(`error:${message}`),
      log: (message) => output.push(message),
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(output, [CLI_HELP]);
  for (const command of [
    "config",
    "login",
    "setup",
    "start",
    "startup",
    "status",
    "doctor",
    "stop",
  ]) {
    assert.match(CLI_HELP, new RegExp(`\\b${command}\\b`, "u"));
  }
});

test("CLI forwards the startup action", async () => {
  const calls: string[] = [];
  assert.equal(
    await runCli(["startup", "enable"], {
      commands: fixtureCommands(calls),
      io: { error: () => undefined, log: () => undefined },
    }),
    16,
  );
  assert.deepEqual(calls, ["startup enable"]);
});

test("CLI reports unknown commands and command failures without a stack trace", async () => {
  const errors: string[] = [];
  const calls: string[] = [];
  assert.equal(
    await runCli(["restart"], {
      commands: fixtureCommands(calls),
      io: { error: (message) => errors.push(message), log: () => undefined },
    }),
    2,
  );
  assert.match(errors[0] ?? "", /未知命令: restart/u);

  const commands = fixtureCommands(calls);
  commands.start = async () => {
    throw new Error("stable failure");
  };
  assert.equal(
    await runCli(["start"], {
      commands,
      io: { error: (message) => errors.push(message), log: () => undefined },
    }),
    1,
  );
  assert.equal(errors.at(-1), "stable failure");
});

test("setup installs the Guard, binds WeChat, and starts the Bridge", async () => {
  const calls: string[] = [];
  const output: string[] = [];
  const actions: SetupActions = {
    configurePlugin: async () => {
      calls.push("plugin");
    },
    configureStartup: async () => {
      calls.push("startup");
    },
    hasUsableSession: () => false,
    login: async () => {
      calls.push("login");
      return 0;
    },
    start: async () => {
      calls.push("start");
      return 0;
    },
  };

  const code = await runSetupInstallation(
    { error: (message) => output.push(`error:${message}`), log: (message) => output.push(message) },
    actions,
  );

  assert.equal(code, 0);
  assert.deepEqual(calls, ["plugin", "login", "startup", "start"]);
  assert.match(output.join("\n"), /安装 Codex iLink Guard/u);
  assert.match(output.join("\n"), /绑定微信/u);
  assert.match(output.join("\n"), /安装完成/u);
  assert.match(output.join("\n"), /不会自动信任或绕过审核/u);
  assert.match(output.join("\n"), /打开 Hooks/u);
  assert.match(output.join("\n"), /codex-ilink-probe（Codex iLink Guard）/u);
  assert.match(output.join("\n"), /Hook 定义变化后需要重新审核/u);
});

test("setup installs a missing Codex marketplace and Guard plugin", async () => {
  const calls: string[][] = [];
  await configureCodexPlugin({
    packageRoot: "C:\\npm\\node_modules\\codex-ilink",
    pluginVersion: "0.1.3+codex.20260716141315",
    runCodex: (args) => {
      calls.push([...args]);
      const command = args.join(" ");
      if (command === "plugin marketplace list") {
        return { status: 0, stderr: "", stdout: "MARKETPLACE ROOT\nopenai-bundled C:\\openai\n" };
      }
      if (command === "plugin list") {
        return {
          status: 0,
          stderr: "",
          stdout: "PLUGIN STATUS VERSION PATH\ncodex-ilink-probe@codex-ilink not installed\n",
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    },
  });

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list"],
    ["plugin", "marketplace", "add", "C:\\npm\\node_modules\\codex-ilink"],
    ["plugin", "list"],
    ["plugin", "add", "codex-ilink-probe@codex-ilink"],
  ]);
});

test("setup replaces a Codex iLink marketplace that points to an older installation", async () => {
  const calls: string[][] = [];
  await configureCodexPlugin({
    packageRoot: "C:\\npm\\node_modules\\codex-ilink",
    pluginVersion: "0.1.3+codex.20260716141315",
    runCodex: (args) => {
      calls.push([...args]);
      const command = args.join(" ");
      if (command === "plugin marketplace list") {
        return {
          status: 0,
          stderr: "",
          stdout: "MARKETPLACE ROOT\ncodex-ilink D:\\old\\codex-ilink\n",
        };
      }
      if (command === "plugin list") {
        return {
          status: 0,
          stderr: "",
          stdout:
            "PLUGIN STATUS VERSION PATH\n" +
            "codex-ilink-probe@codex-ilink installed, enabled 0.1.2 D:\\old\\plugin\n",
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    },
  });

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list"],
    ["plugin", "list"],
    ["plugin", "remove", "codex-ilink-probe@codex-ilink"],
    ["plugin", "marketplace", "remove", "codex-ilink"],
    ["plugin", "marketplace", "add", "C:\\npm\\node_modules\\codex-ilink"],
    ["plugin", "add", "codex-ilink-probe@codex-ilink"],
  ]);
});

test("setup refreshes an older Guard plugin from the current npm package", async () => {
  const calls: string[][] = [];
  await configureCodexPlugin({
    packageRoot: "C:\\npm\\node_modules\\codex-ilink",
    pluginVersion: "0.1.3+codex.20260716141315",
    runCodex: (args) => {
      calls.push([...args]);
      const command = args.join(" ");
      if (command === "plugin marketplace list") {
        return {
          status: 0,
          stderr: "",
          stdout: "MARKETPLACE ROOT\ncodex-ilink C:\\npm\\node_modules\\codex-ilink\n",
        };
      }
      if (command === "plugin list") {
        return {
          status: 0,
          stderr: "",
          stdout:
            "PLUGIN STATUS VERSION PATH\n" +
            "codex-ilink-probe@codex-ilink installed, enabled 0.1.2 D:\\old\\plugin\n",
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    },
  });

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list"],
    ["plugin", "list"],
    ["plugin", "remove", "codex-ilink-probe@codex-ilink"],
    ["plugin", "add", "codex-ilink-probe@codex-ilink"],
  ]);
});

test("published package exposes a runnable ilink executable", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.bin?.ilink, "./dist/cli/launcher.js");
  assert.match(packageJson.scripts?.ilink ?? "", /src\/cli\/main\.ts/u);

  const result = spawnSync(process.execPath, [packageJson.bin.ilink], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /用法: ilink <command>/u);
  assert.match(result.stdout, /setup\s+完成插件安装/u);
});

test("ilink config shows the default session and away timeouts", (t) => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-config-"));
  t.after(() => rmSync(localAppData, { force: true, recursive: true }));

  const result = spawnSync(process.execPath, ["dist/cli/main.js", "config"], {
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /会话绑定超时：30 分钟/u);
  assert.match(result.stdout, /离开判定时间：5 分钟/u);
  assert.match(result.stdout, /锁屏仍立即判定离开/u);
});

test("ilink config set persists timing settings across CLI processes", (t) => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-config-set-"));
  t.after(() => rmSync(localAppData, { force: true, recursive: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["dist/cli/main.js", "config", ...args], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });

  const session = run("set", "session-timeout", "60m");
  assert.equal(session.status, 0, session.stderr);
  assert.match(session.stdout, /会话绑定超时已设置为 60 分钟/u);

  const away = run("set", "away-timeout", "10m");
  assert.equal(away.status, 0, away.stderr);
  assert.match(away.stdout, /离开判定时间已设置为 10 分钟/u);

  const current = run();
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /会话绑定超时：60 分钟/u);
  assert.match(current.stdout, /离开判定时间：10 分钟/u);
});

test("ilink config reset restores safe defaults", (t) => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-config-reset-"));
  t.after(() => rmSync(localAppData, { force: true, recursive: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["dist/cli/main.js", "config", ...args], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });

  assert.equal(run("set", "session-timeout", "60m").status, 0);
  assert.equal(run("set", "away-timeout", "10m").status, 0);
  const reset = run("reset");
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /已恢复默认值/u);

  const current = run();
  assert.match(current.stdout, /会话绑定超时：30 分钟/u);
  assert.match(current.stdout, /离开判定时间：5 分钟/u);
});

test("ilink config rejects unsafe timeout values without changing settings", (t) => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-config-range-"));
  t.after(() => rmSync(localAppData, { force: true, recursive: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["dist/cli/main.js", "config", ...args], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });

  assert.equal(run("set", "session-timeout", "4m").status, 2);
  assert.equal(run("set", "session-timeout", "1441m").status, 2);
  assert.equal(run("set", "away-timeout", "0m").status, 2);
  assert.equal(run("set", "away-timeout", "61m").status, 2);
  const current = run();
  assert.match(current.stdout, /会话绑定超时：30 分钟/u);
  assert.match(current.stdout, /离开判定时间：5 分钟/u);
});
