import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";

test("Desktop and Bridge cannot both acquire the same thread lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-lease-"));
  const databasePath = join(directory, "coordination.sqlite");
  const desktop = new SqliteTurnLeaseStore(databasePath);
  const bridge = new SqliteTurnLeaseStore(databasePath);

  try {
    const createdAtMs = Date.UTC(2026, 6, 15, 15, 40, 0);

    assert.deepEqual(
      desktop.tryAcquire({
        createdAtMs,
        instanceId: "desktop",
        operationId: "desktop-turn",
        owner: "desktop",
        threadId: "019f6663-3fa7-7581-93d6-f8a5aee9a067",
        turnId: "desktop-turn",
      }),
      {
        acquired: true,
        lease: {
          createdAtMs,
          instanceId: "desktop",
          operationId: "desktop-turn",
          owner: "desktop",
          schemaVersion: 1,
          threadId: "019f6663-3fa7-7581-93d6-f8a5aee9a067",
          turnId: "desktop-turn",
        },
      },
    );
    assert.deepEqual(
      bridge.tryAcquire({
        createdAtMs: createdAtMs + 1,
        instanceId: "bridge-instance",
        operationId: "bridge-dispatch",
        owner: "bridge",
        threadId: "019f6663-3fa7-7581-93d6-f8a5aee9a067",
        turnId: null,
      }),
      {
        acquired: false,
        heldBy: {
          createdAtMs,
          instanceId: "desktop",
          operationId: "desktop-turn",
          owner: "desktop",
          schemaVersion: 1,
          threadId: "019f6663-3fa7-7581-93d6-f8a5aee9a067",
          turnId: "desktop-turn",
        },
      },
    );
  } finally {
    desktop.close();
    bridge.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("leases can be read and enumerated with their exact release tokens", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-lease-read-"));
  const store = new SqliteTurnLeaseStore(join(directory, "state.sqlite"));

  try {
    assert.equal(
      store.tryAcquire({
        createdAtMs: 10,
        instanceId: "old-bridge",
        operationId: "operation-a",
        owner: "bridge",
        threadId: "thread-a",
        turnId: "turn-a",
      }).acquired,
      true,
    );
    assert.equal(
      store.tryAcquire({
        createdAtMs: 11,
        instanceId: "desktop",
        operationId: "turn-b",
        owner: "desktop",
        threadId: "thread-b",
        turnId: "turn-b",
      }).acquired,
      true,
    );

    assert.deepEqual(store.getLease("thread-a"), {
      createdAtMs: 10,
      instanceId: "old-bridge",
      operationId: "operation-a",
      owner: "bridge",
      schemaVersion: 1,
      threadId: "thread-a",
      turnId: "turn-a",
    });
    assert.deepEqual(
      store.listLeases().map(({ threadId }) => threadId),
      ["thread-a", "thread-b"],
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("only the matching owner and operation can release a lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-lease-"));
  const store = new SqliteTurnLeaseStore(join(directory, "coordination.sqlite"));

  try {
    const threadId = "019f6663-3fa7-7581-93d6-f8a5aee9a067";
    store.tryAcquire({
      createdAtMs: 1,
      instanceId: "bridge-instance",
      operationId: "bridge-dispatch",
      owner: "bridge",
      threadId,
      turnId: null,
    });

    assert.equal(
      store.release({
        operationId: "wrong-dispatch",
        owner: "bridge",
        threadId,
        instanceId: "bridge-instance",
        turnId: null,
      }),
      false,
    );
    assert.equal(
      store.release({
        operationId: "bridge-dispatch",
        owner: "desktop",
        threadId,
        instanceId: "bridge-instance",
        turnId: null,
      }),
      false,
    );
    assert.equal(
      store.release({
        operationId: "bridge-dispatch",
        owner: "bridge",
        threadId,
        instanceId: "bridge-instance",
        turnId: null,
      }),
      true,
    );
    assert.equal(
      store.tryAcquire({
        createdAtMs: 2,
        instanceId: "desktop",
        operationId: "desktop-turn",
        owner: "desktop",
        threadId,
        turnId: "desktop-turn",
      }).acquired,
      true,
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a duplicate release cannot delete a replacement lease", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-lease-"));
  const store = new SqliteTurnLeaseStore(join(directory, "coordination.sqlite"));
  const threadId = "019f6663-3fa7-7581-93d6-f8a5aee9a067";

  try {
    assert.equal(
      store.tryAcquire({
        createdAtMs: 1,
        instanceId: "desktop",
        operationId: "desktop-turn-a",
        owner: "desktop",
        threadId,
        turnId: "desktop-turn-a",
      }).acquired,
      true,
    );
    assert.equal(
      store.release({
        operationId: "desktop-turn-a",
        owner: "desktop",
        threadId,
        instanceId: "desktop",
        turnId: "desktop-turn-a",
      }),
      true,
    );
    assert.equal(
      store.tryAcquire({
        createdAtMs: 2,
        instanceId: "bridge-instance",
        operationId: "bridge-turn-b",
        owner: "bridge",
        threadId,
        turnId: null,
      }).acquired,
      true,
    );

    assert.equal(
      store.release({
        operationId: "desktop-turn-a",
        owner: "desktop",
        threadId,
        instanceId: "desktop",
        turnId: "desktop-turn-a",
      }),
      false,
    );
    assert.deepEqual(
      store.tryAcquire({
        createdAtMs: 3,
        instanceId: "desktop",
        operationId: "desktop-turn-c",
        owner: "desktop",
        threadId,
        turnId: "desktop-turn-c",
      }),
      {
        acquired: false,
        heldBy: {
          createdAtMs: 2,
          instanceId: "bridge-instance",
          operationId: "bridge-turn-b",
          owner: "bridge",
          schemaVersion: 1,
          threadId,
          turnId: null,
        },
      },
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Bridge turn claim and Desktop stop require exact tokens", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-lease-"));
  const store = new SqliteTurnLeaseStore(join(directory, "coordination.sqlite"));
  const threadId = "019f6663-3fa7-7581-93d6-f8a5aee9a067";

  try {
    store.tryAcquire({
      createdAtMs: 1,
      instanceId: "bridge-instance-a",
      operationId: "dispatch-a",
      owner: "bridge",
      threadId,
      turnId: null,
    });
    assert.equal(
      store.claimBridgeTurn({
        instanceId: "bridge-instance-b",
        threadId,
        turnId: "bridge-turn-a",
      }),
      false,
    );
    assert.equal(
      store.claimBridgeTurn({
        instanceId: "bridge-instance-a",
        threadId,
        turnId: "bridge-turn-a",
      }),
      true,
    );
    assert.equal(
      store.isHeldBy({
        instanceId: "bridge-instance-a",
        operationId: "dispatch-a",
        owner: "bridge",
        threadId,
        turnId: "bridge-turn-a",
      }),
      true,
    );
    assert.equal(
      store.claimBridgeTurn({
        instanceId: "bridge-instance-a",
        threadId,
        turnId: "bridge-turn-b",
      }),
      false,
    );
    assert.equal(
      store.release({
        instanceId: "bridge-instance-a",
        operationId: "dispatch-a",
        owner: "bridge",
        threadId,
        turnId: "bridge-turn-a",
      }),
      true,
    );

    store.tryAcquire({
      createdAtMs: 2,
      instanceId: "desktop",
      operationId: "desktop-turn-a",
      owner: "desktop",
      threadId,
      turnId: "desktop-turn-a",
    });
    assert.equal(
      store.markDesktopStop({ stoppedAtMs: 3, threadId, turnId: "wrong" }),
      false,
    );
    assert.equal(
      store.markDesktopStop({
        stoppedAtMs: 4,
        threadId,
        turnId: "desktop-turn-a",
      }),
      true,
    );
    assert.equal(
      store.releaseStoppedDesktop({ threadId, turnId: "wrong" }),
      false,
    );
    assert.equal(
      store.releaseStoppedDesktop({
        threadId,
        turnId: "desktop-turn-a",
      }),
      true,
    );
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
