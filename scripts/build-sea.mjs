import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { inject } from "postject";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const SEA_MANIFEST_ASSET = "codex-ilink/asset-manifest.json";
const EXECUTABLE_NAME = "codex-ilink-x86_64-pc-windows-msvc.exe";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("build:sea currently requires Windows x64");
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactsDirectory = join(repositoryRoot, "artifacts");
const buildDirectory = join(artifactsDirectory, "sea");
const executablePath = join(artifactsDirectory, EXECUTABLE_NAME);
const checksumPath = `${executablePath}.sha256`;
assertGeneratedPath(buildDirectory);
assertGeneratedPath(executablePath);
rmSync(buildDirectory, { force: true, recursive: true });
rmSync(executablePath, { force: true });
rmSync(checksumPath, { force: true });
mkdirSync(buildDirectory, { recursive: true });

const bundlePath = join(buildDirectory, "main.cjs");
await build({
  bundle: true,
  define: {
    "import.meta.url": JSON.stringify("file:///__codex_ilink_sea__/main.cjs"),
  },
  entryPoints: [join(repositoryRoot, "src", "cli", "main.ts")],
  format: "cjs",
  logLevel: "info",
  outfile: bundlePath,
  platform: "node",
  target: "node22.13",
});

const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const runtimeFiles = [
  runtimeFile("package.json"),
  runtimeFile(".agents/plugins/marketplace.json"),
  runtimeFile("dist/windows/startup-host.vbs"),
  ...collectRuntimeFiles("plugins"),
  ...collectRuntimeFiles("dist/bridge/migrations"),
].sort((left, right) => left.path.localeCompare(right.path));
const manifestFiles = runtimeFiles.map((file) => ({
  asset: `codex-ilink/files/${file.path}`,
  path: file.path,
  sha256: sha256(readFileSync(file.absolutePath)),
}));
const digest = sha256(
  Buffer.from(
    manifestFiles.map((file) => `${file.path}\0${file.sha256}\n`).join(""),
    "utf8",
  ),
);
const manifestPath = join(buildDirectory, "asset-manifest.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    { digest, files: manifestFiles, version: packageJson.version },
    null,
    2,
  )}\n`,
  "utf8",
);

const assets = { [SEA_MANIFEST_ASSET]: manifestPath };
for (const file of runtimeFiles) {
  assets[`codex-ilink/files/${file.path}`] = file.absolutePath;
}
const blobPath = join(buildDirectory, "sea-prep.blob");
const configPath = join(buildDirectory, "sea-config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      assets,
      disableExperimentalSEAWarning: true,
      execArgv: ["--disable-warning=ExperimentalWarning"],
      execArgvExtension: "none",
      main: bundlePath,
      output: blobPath,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const prepare = spawnChecked(process.execPath, [
  "--experimental-sea-config",
  configPath,
]);
if (prepare !== 0) {
  throw new Error(`SEA preparation failed with exit code ${String(prepare)}`);
}
cpSync(process.execPath, executablePath);
await inject(executablePath, "NODE_SEA_BLOB", readFileSync(blobPath), {
  overwrite: true,
  sentinelFuse: SEA_FUSE,
});
const executableHash = sha256(readFileSync(executablePath));
writeFileSync(
  checksumPath,
  `${executableHash}  ${EXECUTABLE_NAME}\n`,
  "utf8",
);
console.log(`SEA built: ${executablePath}`);
console.log(`SHA-256: ${executableHash}`);

function runtimeFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const absolutePath = resolve(repositoryRoot, ...normalized.split("/"));
  if (!statSync(absolutePath).isFile()) {
    throw new Error(`Runtime asset is not a file: ${normalized}`);
  }
  return { absolutePath, path: normalized };
}

function collectRuntimeFiles(relativeDirectory) {
  const absoluteDirectory = resolve(
    repositoryRoot,
    ...relativeDirectory.split("/"),
  );
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const childRelative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectRuntimeFiles(childRelative));
    } else if (entry.isFile()) {
      files.push(runtimeFile(childRelative));
    }
  }
  return files;
}

function assertGeneratedPath(path) {
  const candidate = relative(repositoryRoot, path);
  if (
    !candidate ||
    isAbsolute(candidate) ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    (candidate !== "artifacts" && !candidate.startsWith(`artifacts${sep}`))
  ) {
    throw new Error(`Refusing to modify path outside artifacts: ${path}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function spawnChecked(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
