import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runPolicy(version: string, tag: string, currentVersion?: string) {
  const args = [
    "scripts/release-policy.mjs",
    "--version",
    version,
    "--tag",
    tag,
    "--json",
  ];
  if (currentVersion) args.push("--current-version", currentVersion);
  return spawnSync(
    process.execPath,
    args,
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
  );
}

test("a stable package version maps to a signed latest release", () => {
  const result = runPolicy("1.2.3", "v1.2.3");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    githubPrerelease: false,
    npmTag: "latest",
    requiresAuthenticode: true,
    tag: "v1.2.3",
    version: "1.2.3",
  });
});

test("a prerelease package version maps to GitHub prerelease and npm next", () => {
  const result = runPolicy("1.2.3-beta.4", "v1.2.3-beta.4");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    githubPrerelease: true,
    npmTag: "next",
    requiresAuthenticode: false,
    tag: "v1.2.3-beta.4",
    version: "1.2.3-beta.4",
  });
});

test("the release tag must exactly match the v-prefixed package version", () => {
  const result = runPolicy("1.2.3", "v1.2.4");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /v1\.2\.3[\s\S]*v1\.2\.4/u);
});

test("release versions reject build metadata so the approval channel cannot diverge", () => {
  const result = runPolicy("1.2.3+build-1", "v1.2.3+build-1");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /禁止 \+build metadata/u);
});

test("a new publish cannot move its npm dist-tag backward", () => {
  const result = runPolicy("1.2.2", "v1.2.2", "1.2.3");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /不得从 1\.2\.3 回拨到 1\.2\.2/u);
});

test("prerelease numeric identifiers advance by SemVer precedence", () => {
  const result = runPolicy("1.3.0-beta.10", "v1.3.0-beta.10", "1.3.0-beta.9");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, "1.3.0-beta.10");
});

test("the release workflow serializes dist-tags and verifies public assets", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const advanceGate = workflow.indexOf("--current-version $currentVersion");
  const publish = workflow.indexOf("npm publish --access public");

  assert.match(workflow, /group: release-\$\{\{/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(
    workflow,
    /actions\/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3/u,
  );
  assert.match(workflow, /gh release download \$tag/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /--source-digest \$env:GITHUB_SHA/u);
  assert.match(workflow, /已公开稳定版的 Authenticode 签名无效/u);
  assert.match(workflow, /GitHub Release 已公开但 npm 版本不存在/u);
  assert.match(workflow, /这是用于正式验收的预发布候选版/u);
  assert.match(workflow, /Desktop → 微信 → 同会话 → Desktop 完整端到端闭环/u);
  assert.match(workflow, /\$releaseArgs \+= @\("--notes", \$previewNotes\)/u);
  assert.ok(advanceGate >= 0 && advanceGate < publish);
});

test("CI and release workflows pin every third-party action by commit", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    const workflow = readFileSync(path, "utf8");
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s+\S+@(\S+)/gmu)];
    assert.ok(uses.length > 0, `${path} must use at least one action`);
    for (const use of uses) {
      assert.match(use[1] ?? "", /^[0-9a-f]{40}$/u, use[0]);
    }
  }
});

test("the published package targets only the supported Windows x64 platform", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.deepEqual(packageJson.os, ["win32"]);
  assert.deepEqual(packageJson.cpu, ["x64"]);
});

test("the workflow CLI reads package.json and writes typed GitHub outputs", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const version = String(packageJson.version);
  const prerelease = version.includes("-");
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-release-policy-"));
  const output = join(directory, "github-output.txt");
  try {
    const result = spawnSync(process.execPath, ["scripts/release-policy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        RELEASE_TAG: `v${version}`,
      },
      windowsHide: true,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(output, "utf8"),
      [
        `version=${version}`,
        `tag=v${version}`,
        `github_prerelease=${String(prerelease)}`,
        `npm_tag=${prerelease ? "next" : "latest"}`,
        `requires_authenticode=${String(!prerelease)}`,
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runInstaller(...args: string[]) {
  return spawnSync(
    process.platform === "win32" ? "powershell.exe" : "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "scripts/install.ps1", ...args],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
  );
}

test("preview installation requires an explicit version before downloading", () => {
  const result = runInstaller("-Channel", "preview");

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /requires an explicit -Version/u);
});

test("preview installation rejects a stable version before downloading", () => {
  const result = runInstaller("-Channel", "preview", "-Version", "1.2.3");

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be a prerelease SemVer/u);
});

test("preview installation rejects empty prerelease identifiers before downloading", () => {
  const result = runInstaller("-Channel", "preview", "-Version", "1.2.3-..");

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be a prerelease SemVer/u);
});
