import { prepareRuntimeEnvironment } from "../runtime/package-assets.ts";
import { runCli } from "./ilink.ts";

prepareRuntimeEnvironment();

void runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
