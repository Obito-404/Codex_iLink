import { cpSync } from "node:fs";

cpSync(
  new URL("../src/bridge/migrations/", import.meta.url),
  new URL("../dist/bridge/migrations/", import.meta.url),
  { recursive: true },
);
