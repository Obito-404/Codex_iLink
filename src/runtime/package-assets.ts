import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { getAsset, isSea } from "node:sea";

const SEA_MANIFEST_ASSET = "codex-ilink/asset-manifest.json";

type SeaAssetManifest = {
  digest: string;
  files: Array<{
    asset: string;
    path: string;
    sha256: string;
  }>;
  version: string;
};

export type RuntimeEnvironment = {
  entrypoint: string;
  packageRoot: string;
  standalone: boolean;
};

export function prepareRuntimeEnvironment(
  entrypoint = process.argv[1],
): RuntimeEnvironment {
  const standalone = isSea();
  const packageRoot = standalone
    ? extractSeaAssets()
    : packageRootFromEntrypoint(entrypoint);
  const resolvedEntrypoint = standalone
    ? process.execPath
    : requireEntrypoint(entrypoint);
  process.env.CODEX_ILINK_PACKAGE_ROOT = packageRoot;
  process.env.CODEX_ILINK_ENTRYPOINT = resolvedEntrypoint;
  return { entrypoint: resolvedEntrypoint, packageRoot, standalone };
}

export function isStandaloneExecutable(): boolean {
  return isSea();
}

export function runtimeEntrypoint(): string {
  if (isSea()) return process.execPath;
  return requireEntrypoint(
    process.env.CODEX_ILINK_ENTRYPOINT ?? process.argv[1],
  );
}

export function runtimePackageRoot(): string {
  const configured = process.env.CODEX_ILINK_PACKAGE_ROOT;
  if (configured) return realpathOrResolved(configured);
  return isSea()
    ? extractSeaAssets()
    : packageRootFromEntrypoint(process.argv[1]);
}

function packageRootFromEntrypoint(entrypoint: string | undefined): string {
  return realpathOrResolved(
    resolve(dirname(requireEntrypoint(entrypoint)), "..", ".."),
  );
}

function requireEntrypoint(entrypoint: string | undefined): string {
  if (!entrypoint) throw new Error("E_RUNTIME_ENTRYPOINT_MISSING");
  return resolve(entrypoint);
}

function extractSeaAssets(): string {
  const manifest = parseManifest(getAsset(SEA_MANIFEST_ASSET, "utf8"));
  const baseDirectory = join(
    process.env.LOCALAPPDATA ?? homedir(),
    "Codex_iLink",
    "app",
  );
  const packageRoot = join(baseDirectory, manifest.version);
  const markerPath = join(packageRoot, ".asset-digest");
  if (
    existsSync(markerPath) &&
    readFileSync(markerPath, "utf8").trim() === manifest.digest
  ) {
    return realpathOrResolved(packageRoot);
  }

  mkdirSync(packageRoot, { recursive: true });
  for (const file of manifest.files) {
    const relativePath = safeRelativeAssetPath(file.path);
    const destination = join(packageRoot, relativePath);
    const bytes = Buffer.from(getAsset(file.asset));
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`E_SEA_ASSET_CHECKSUM:${file.path}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.${String(process.pid)}.tmp`;
    rmSync(temporary, { force: true });
    writeFileSync(temporary, bytes);
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
  }

  const markerTemporary = `${markerPath}.${String(process.pid)}.tmp`;
  writeFileSync(markerTemporary, `${manifest.digest}\n`, "utf8");
  rmSync(markerPath, { force: true });
  renameSync(markerTemporary, markerPath);
  return realpathOrResolved(packageRoot);
}

function parseManifest(raw: string): SeaAssetManifest {
  const value = JSON.parse(raw) as Partial<SeaAssetManifest>;
  if (
    typeof value.version !== "string" ||
    !/^[0-9A-Za-z.+-]+$/u.test(value.version) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("E_SEA_ASSET_MANIFEST_INVALID");
  }
  for (const file of value.files) {
    if (
      !file ||
      typeof file.asset !== "string" ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    ) {
      throw new Error("E_SEA_ASSET_MANIFEST_INVALID");
    }
  }
  return value as SeaAssetManifest;
}

function safeRelativeAssetPath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`E_SEA_ASSET_PATH:${value}`);
  }
  return value.split("/").join(sep);
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
