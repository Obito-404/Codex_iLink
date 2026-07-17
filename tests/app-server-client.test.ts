import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { AppServerClient } from "../src/probes/app-server-client.ts";

const fakeAppServer = resolve("tests/fixtures/fake-app-server.mjs");

test("server requests cannot consume a pending client response", async () => {
  const client = new AppServerClient([process.execPath, fakeAppServer]);
  try {
    await client.initialize();
  } finally {
    client.close();
  }
});

test("non-object JSON protocol messages fail fast", async () => {
  const client = new AppServerClient([
    process.execPath,
    fakeAppServer,
    "--emit-null",
  ]);
  try {
    await assert.rejects(
      client.initialize(),
      /app-server emitted a non-object JSON message/u,
    );
  } finally {
    client.close();
  }
});
