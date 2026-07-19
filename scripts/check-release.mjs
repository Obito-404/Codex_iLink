import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { resolveReleasePolicy } from "./release-policy.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const errors = [];

if (packageJson.private === true) {
  errors.push("package.json 仍设置 private: true");
}
if (packageJson.version === "0.0.0") {
  errors.push("必须设置正式或预览版本号");
}
try {
  resolveReleasePolicy({
    version: packageJson.version,
    tag: process.env.RELEASE_TAG ?? `v${packageJson.version}`,
  });
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}
if (packageJson.bin?.ilink !== "./dist/cli/launcher.js") {
  errors.push("bin.ilink 必须指向 ./dist/cli/launcher.js");
}
if (
  !Array.isArray(packageJson.os) ||
  packageJson.os.length !== 1 ||
  packageJson.os[0] !== "win32"
) {
  errors.push("os 必须严格限定为 win32");
}
if (
  !Array.isArray(packageJson.cpu) ||
  packageJson.cpu.length !== 1 ||
  packageJson.cpu[0] !== "x64"
) {
  errors.push("cpu 必须严格限定为 x64");
}
if (packageJson.engines?.node !== ">=22.13.0") {
  errors.push("engines.node 必须包含已完整验证的 Node.js 22 LTS");
}
if (!packageJson.author) {
  errors.push("缺少 author；请填写 npm 发布者或组织");
}
if (!packageJson.repository) {
  errors.push("缺少 repository；请填写公开源码仓库地址");
}
if (!packageJson.homepage) {
  errors.push("缺少 homepage；请填写项目主页");
}
if (!packageJson.bugs) {
  errors.push("缺少 bugs；请填写问题反馈地址");
}
if (!packageJson.license || packageJson.license === "UNLICENSED") {
  errors.push("尚未选择开源许可证；请先完成法律授权决定");
}

const gitStatus = spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
});
if (gitStatus.status !== 0) {
  errors.push("无法确认 Git 工作树状态");
} else if (gitStatus.stdout.trim()) {
  errors.push("Git 工作树不干净；请从已提交的干净版本发布");
}

if (errors.length > 0) {
  console.error("npm 发布元数据未完成：");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("npm 发布元数据检查通过");
}
