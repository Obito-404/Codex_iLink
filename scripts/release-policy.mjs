import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export function resolveReleasePolicy({ version, tag }) {
  const parsed = parseReleaseVersion(version);
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(`发布标签必须严格等于 ${expectedTag}，实际为 ${tag}`);
  }
  const githubPrerelease = parsed.prerelease !== null;
  return {
    githubPrerelease,
    npmTag: githubPrerelease ? "next" : "latest",
    requiresAuthenticode: !githubPrerelease,
    tag,
    version,
  };
}

export function assertReleaseAdvances(currentVersion, candidateVersion) {
  const current = parseReleaseVersion(currentVersion);
  const candidate = parseReleaseVersion(candidateVersion);
  if (compareParsedVersions(candidate, current) <= 0) {
    throw new Error(
      `npm dist-tag 不得从 ${currentVersion} 回拨到 ${candidateVersion}`,
    );
  }
}

function parseReleaseVersion(version) {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`无效或不支持的发布版本（禁止 +build metadata）：${version}`);
  }
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split(".") ?? null,
  };
}

function compareParsedVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const leftPart = BigInt(left.core[index]);
    const rightPart = BigInt(right.core[index]);
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runCli() {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version = readArgument("--version") ?? packageJson.version;
  const currentVersion = readArgument("--current-version");
  const tag =
    readArgument("--tag") ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
  if (!version || !tag) {
    throw new Error("缺少 package version 或发布 tag");
  }
  const policy = resolveReleasePolicy({ version, tag });
  if (currentVersion) assertReleaseAdvances(currentVersion, version);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(policy)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `version=${policy.version}`,
        `tag=${policy.tag}`,
        `github_prerelease=${String(policy.githubPrerelease)}`,
        `npm_tag=${policy.npmTag}`,
        `requires_authenticode=${String(policy.requiresAuthenticode)}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
