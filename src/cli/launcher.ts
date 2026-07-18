#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("./main.js", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    mainPath,
    ...process.argv.slice(2),
  ],
  {
    shell: false,
    stdio: "inherit",
    windowsHide: false,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
