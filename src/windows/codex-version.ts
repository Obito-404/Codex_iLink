export type CodexVersionAssessment = {
  detail: string;
  level: "error" | "ok" | "warn";
  version: string | null;
};

const MIN_SUPPORTED_PARTS = [0, 144, 2] as const;
export const MIN_SUPPORTED_CODEX_VERSION = MIN_SUPPORTED_PARTS.join(".");
export const VERIFIED_CODEX_MINOR = MIN_SUPPORTED_PARTS.slice(0, 2).join(".");

export type CodexVersionCommandResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

export type CodexVersionCommandRunner = (
  executable: string,
  args: readonly string[],
) => CodexVersionCommandResult;

export function inspectCodexVersion(
  executable: string,
  runCommand: CodexVersionCommandRunner,
): CodexVersionAssessment {
  let result: CodexVersionCommandResult;
  try {
    result = runCommand(executable, ["--version"]);
  } catch (error) {
    return {
      detail: `无法读取 Codex 版本：${error instanceof Error ? error.message : String(error)}`,
      level: "error",
      version: null,
    };
  }
  if (result.status === 0) return assessCodexVersionOutput(result.stdout);
  const detail = result.stderr.trim() || result.stdout.trim();
  return {
    detail: detail
      ? `无法读取 Codex 版本：${detail}`
      : "无法读取 Codex 版本",
    level: "error",
    version: null,
  };
}

export function assessCodexVersionOutput(
  output: string,
): CodexVersionAssessment {
  const match = /\b(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\b/u.exec(
    output,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return {
      detail: "无法读取 Codex 版本",
      level: "error",
      version: null,
    };
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const prerelease = match[4];
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    return {
      detail: "无法读取 Codex 版本",
      level: "error",
      version: null,
    };
  }
  const version = match[0];
  const comparison = compareVersionParts(parts, MIN_SUPPORTED_PARTS);
  if (comparison < 0 || (comparison === 0 && prerelease)) {
    return {
      detail: `${version}，低于最低支持版本 ${MIN_SUPPORTED_CODEX_VERSION}`,
      level: "error",
      version,
    };
  }
  if (prerelease) {
    return {
      detail: `${version}，尚未验证（已验证 ${VERIFIED_CODEX_MINOR}.x）`,
      level: "warn",
      version,
    };
  }
  if (
    parts[0] !== MIN_SUPPORTED_PARTS[0] ||
    parts[1] !== MIN_SUPPORTED_PARTS[1]
  ) {
    return {
      detail: `${version}，尚未验证（已验证 ${VERIFIED_CODEX_MINOR}.x）`,
      level: "warn",
      version,
    };
  }
  return {
    detail: `${version}（已验证 ${VERIFIED_CODEX_MINOR}.x）`,
    level: "ok",
    version,
  };
}

function compareVersionParts(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
