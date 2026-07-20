import assert from "node:assert/strict";
import test from "node:test";

import { collectDoctorChecks } from "../src/cli/ilink.ts";
import {
  assessCodexVersionOutput,
  inspectCodexVersion,
} from "../src/windows/codex-version.ts";

test("the minimum supported Codex version is accepted", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli 0.144.2\n"), {
    detail: "0.144.2（已验证 0.144.x）",
    level: "ok",
    version: "0.144.2",
  });
});

test("another Codex patch in the verified minor is accepted", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli 0.144.4"), {
    detail: "0.144.4（已验证 0.144.x）",
    level: "ok",
    version: "0.144.4",
  });
});

test("a Codex version below the minimum is rejected", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli 0.144.1"), {
    detail: "0.144.1，低于最低支持版本 0.144.2",
    level: "error",
    version: "0.144.1",
  });
});

test("a prerelease of the minimum Codex version remains below the minimum", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli 0.144.2-beta.1"), {
    detail: "0.144.2-beta.1，低于最低支持版本 0.144.2",
    level: "error",
    version: "0.144.2-beta.1",
  });
});

test("a newer unverified Codex minor is warned without rejection", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli 0.145.0"), {
    detail: "0.145.0，尚未验证（已验证 0.144.x）",
    level: "warn",
    version: "0.145.0",
  });
});

test("a newer unverified Codex major is warned without rejection", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli 1.0.0"), {
    detail: "1.0.0，尚未验证（已验证 0.144.x）",
    level: "warn",
    version: "1.0.0",
  });
});

test("an unparseable Codex version is rejected", () => {
  assert.deepEqual(assessCodexVersionOutput("codex-cli unknown"), {
    detail: "无法读取 Codex 版本",
    level: "error",
    version: null,
  });
});

test("a failed Codex version command is reported as unreadable", () => {
  const assessment = inspectCodexVersion("D:\\Codex\\codex.exe", (executable, args) => {
    assert.equal(executable, "D:\\Codex\\codex.exe");
    assert.deepEqual(args, ["--version"]);
    return { status: null, stderr: "spawn failed", stdout: "" };
  });

  assert.deepEqual(assessment, {
    detail: "无法读取 Codex 版本：spawn failed",
    level: "error",
    version: null,
  });
});

test("an exception while reading Codex version is reported as an error", () => {
  assert.deepEqual(
    inspectCodexVersion("D:\\Codex\\codex.exe", () => {
      throw new Error("access denied");
    }),
    {
      detail: "无法读取 Codex 版本：access denied",
      level: "error",
      version: null,
    },
  );
});

test("doctor reports Codex version as a separate compatibility check", async () => {
  const checks = await collectDoctorChecks({}, {
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => "disabled",
    runCodex: () => ({
      status: 0,
      stderr: "",
      stdout: "codex-cli 0.145.0\n",
    }),
  });

  assert.deepEqual(
    checks.find((check) => check.name === "Codex 版本"),
    {
      detail: "0.145.0，尚未验证（已验证 0.144.x）",
      level: "warn",
      name: "Codex 版本",
    },
  );
});

test("doctor reports an expired WeChat login instead of a healthy Bridge", async () => {
  const checks = await collectDoctorChecks({}, {
    currentHostStatus: async () => ({
      ilinkAuthPausedUntilMs: Date.now() + 60_000,
      phase: "running",
      pid: 123,
      startedAtMs: Date.now() - 60_000,
    }),
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => "enabled",
    runCodex: () => ({
      status: 0,
      stderr: "",
      stdout: "codex-cli 0.144.2\n",
    }),
  });

  assert.deepEqual(
    checks.find((check) => check.name === "Bridge"),
    {
      detail: "微信登录已失效；请执行 ilink stop、ilink login --force、ilink start",
      level: "error",
      name: "Bridge",
    },
  );
});

test("doctor reports an installed and enabled Guard without claiming hook trust", async () => {
  const checks = await collectDoctorChecks({}, {
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => "disabled",
    runCodex: (_executable, args) =>
      args[0] === "--version"
        ? { status: 0, stderr: "", stdout: "codex-cli 0.144.2\n" }
        : {
            status: 0,
            stderr: "",
            stdout:
              "PLUGIN STATUS VERSION PATH\n" +
              "codex-ilink-probe@codex-ilink installed, enabled 0.1.3 C:\\plugin\n",
          },
  });

  assert.deepEqual(
    checks.find((check) => check.name === "Codex iLink Guard"),
    {
      detail: "已安装并启用 0.1.3",
      level: "ok",
      name: "Codex iLink Guard",
    },
  );
  assert.deepEqual(
    checks.find((check) => check.name === "Hooks 信任"),
    {
      detail: "需在 Codex Desktop 的 Hooks 页面人工审核；ilink 不自动读取或写入信任状态",
      level: "info",
      name: "Hooks 信任",
    },
  );
});

test("doctor rejects a missing or disabled Guard", async () => {
  const checks = await collectDoctorChecks({}, {
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => "disabled",
    runCodex: (_executable, args) =>
      args[0] === "--version"
        ? { status: 0, stderr: "", stdout: "codex-cli 0.144.2\n" }
        : { status: 0, stderr: "", stdout: "PLUGIN STATUS VERSION PATH\n" },
  });

  assert.deepEqual(
    checks.find((check) => check.name === "Codex iLink Guard"),
    {
      detail: "未安装或未启用，请运行 ilink setup",
      level: "error",
      name: "Codex iLink Guard",
    },
  );
});

test("doctor reports enabled login startup as healthy", async () => {
  const checks = await collectDoctorChecks({}, {
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => "enabled",
    runCodex: () => ({
      status: 0,
      stderr: "",
      stdout: "codex-cli 0.144.2\n",
    }),
  });

  assert.deepEqual(
    checks.find((check) => check.name === "登录启动"),
    { detail: "已启用", level: "ok", name: "登录启动" },
  );
});

test("doctor warns when login startup is disabled", async () => {
  const checks = await collectDoctorChecks({}, {
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => "disabled",
    runCodex: () => ({
      status: 0,
      stderr: "",
      stdout: "codex-cli 0.144.2\n",
    }),
  });

  assert.deepEqual(
    checks.find((check) => check.name === "登录启动"),
    { detail: "未启用", level: "warn", name: "登录启动" },
  );
});

test("doctor reports a login startup query failure as an error", async () => {
  const checks = await collectDoctorChecks({}, {
    findCodexExecutable: () => "D:\\Codex\\codex.exe",
    inspectStartupTask: () => {
      throw new Error("access denied");
    },
    runCodex: () => ({
      status: 0,
      stderr: "",
      stdout: "codex-cli 0.144.2\n",
    }),
  });

  assert.deepEqual(
    checks.find((check) => check.name === "登录启动"),
    {
      detail: "查询失败：access denied",
      level: "error",
      name: "登录启动",
    },
  );
});
