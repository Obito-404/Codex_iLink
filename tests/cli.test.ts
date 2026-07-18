import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CLI_HELP, runCli, type CliCommands } from "../src/cli/ilink.ts";

function fixtureCommands(calls: string[]): CliCommands {
  return {
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

test("CLI exposes only the five public lifecycle commands", async () => {
  for (const [command, expectedCode] of [
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
  for (const command of ["login", "start", "status", "doctor", "stop"]) {
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
