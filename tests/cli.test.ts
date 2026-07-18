import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CLI_HELP, runCli, type CliCommands } from "../src/cli/ilink.ts";

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
    start: async () => {
      calls.push("start");
      return 12;
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

test("CLI exposes its six public commands", async () => {
  for (const [command, expectedCode] of [
    ["config", 9],
    ["doctor", 10],
    ["login", 11],
    ["start", 12],
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
  for (const command of ["config", "login", "start", "status", "doctor", "stop"]) {
    assert.match(CLI_HELP, new RegExp(`\\b${command}\\b`, "u"));
  }
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

test("published package exposes a runnable ilink executable", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.bin?.ilink, "./dist/cli/ilink.js");
  assert.match(packageJson.scripts?.ilink ?? "", /src\/cli\/ilink\.ts/u);

  const result = spawnSync(process.execPath, [packageJson.bin.ilink], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /用法: ilink <command>/u);
});

test("ilink config shows the default session and away timeouts", (t) => {
  const localAppData = mkdtempSync(join(tmpdir(), "codex-ilink-config-"));
  t.after(() => rmSync(localAppData, { force: true, recursive: true }));

  const result = spawnSync(process.execPath, ["dist/cli/ilink.js", "config"], {
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
    spawnSync(process.execPath, ["dist/cli/ilink.js", "config", ...args], {
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
    spawnSync(process.execPath, ["dist/cli/ilink.js", "config", ...args], {
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
    spawnSync(process.execPath, ["dist/cli/ilink.js", "config", ...args], {
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
