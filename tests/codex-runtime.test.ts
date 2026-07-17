import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import test from "node:test";

import {
  CodexOutcomeUnknownError,
  CodexRuntime,
} from "../src/codex/codex-runtime.ts";

const fakeRuntime = resolve("tests/fixtures/fake-codex-runtime.mjs");

test("one initialized App Server process serves subsequent requests", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-1",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const first = await runtime.listThreads();
    const second = await runtime.listThreads();
    const firstFixture = first.fixture as {
      initializeCount: number;
      pid: number;
    };
    const secondFixture = second.fixture as {
      initializeCount: number;
      pid: number;
    };

    assert.equal(firstFixture.initializeCount, 1);
    assert.equal(secondFixture.initializeCount, 1);
    assert.equal(firstFixture.pid, secondFixture.pid);
  } finally {
    runtime.close();
  }
});

test("a safe request reconnects once after App Server EOF", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-reconnect",
    command: [
      process.execPath,
      fakeRuntime,
      "--eof-method-once",
      "thread/list",
      join(directory, "eof.marker"),
    ],
    requestTimeoutMs: 1_000,
  });

  try {
    const listed = await runtime.listThreads();
    const fixture = listed.fixture as { pid: number };

    assert.equal(listed.nextCursor, null);
    assert.equal(typeof fixture.pid, "number");
  } finally {
    runtime.close();
  }
});

test("a safe request timeout leaves the App Server running", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const startsPath = join(directory, "process-starts.log");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-timeout-reconnect-safe-request",
    command: [
      process.execPath,
      fakeRuntime,
      "--hang-method-once",
      "thread/list",
      join(directory, "list-hang.marker"),
      "--record-start",
      startsPath,
    ],
    requestTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(runtime.listThreads(), /thread\/list timed out/u);
    const listed = await runtime.listThreads();

    assert.equal(listed.nextCursor, null);
    assert.equal(
      readFileSync(startsPath, "utf8").trim().split(/\r?\n/u).length,
      1,
    );
  } finally {
    runtime.close();
  }
});

test("a timed out thread read does not terminate an otherwise live App Server", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const startsPath = join(directory, "process-starts.log");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-read-timeout-stays-live",
    command: [
      process.execPath,
      fakeRuntime,
      "--hang-method-once",
      "thread/read",
      join(directory, "read-hang.marker"),
      "--record-start",
      startsPath,
    ],
    requestTimeoutMs: 250,
  });

  try {
    const before = await runtime.listThreads();
    await assert.rejects(
      runtime.readThread({ includeTurns: true, threadId: "thread-live" }),
      /thread\/read timed out/u,
    );
    const after = await runtime.listThreads();

    assert.equal(
      (before.fixture as { pid: number }).pid,
      (after.fixture as { pid: number }).pid,
    );
    assert.equal(
      readFileSync(startsPath, "utf8").trim().split(/\r?\n/u).length,
      1,
    );
  } finally {
    runtime.close();
  }
});

test("concurrent safe and unsafe timeouts do not replace the App Server", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const listHangMarker = join(directory, "list-hang.marker");
  const startsPath = join(directory, "process-starts.log");
  const turnStartCountPath = join(directory, "turn-start.count");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-timeout-concurrent-unsafe",
    command: [
      process.execPath,
      fakeRuntime,
      "--hang-method-once",
      "thread/list",
      listHangMarker,
      "--hang-turn-start",
      "--count-method",
      "turn/start",
      turnStartCountPath,
      "--record-start",
      startsPath,
    ],
    requestTimeoutMs: 1_000,
  });

  try {
    const safeRequest = runtime.listThreads();
    for (let attempt = 0; attempt < 50 && !existsSync(listHangMarker); attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.equal(existsSync(listHangMarker), true);

    const safeOutcome = assert.rejects(safeRequest, /thread\/list timed out/u);
    const unsafeOutcome = assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:timeout-concurrent-unsafe",
        text: "并发等待中的提交不得被归类为普通断链",
        threadId: "thread-timeout-concurrent-unsafe",
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexOutcomeUnknownError);
        assert.equal(error.method, "turn/start");
        assert.equal(error.reason, "timeout");
        return true;
      },
    );

    await Promise.all([safeOutcome, unsafeOutcome]);
    const listed = await runtime.listThreads();

    assert.equal(listed.nextCursor, null);
    assert.equal(Number(readFileSync(turnStartCountPath, "utf8")), 1);
    assert.equal(
      readFileSync(startsPath, "utf8").trim().split(/\r?\n/u).length,
      1,
    );
  } finally {
    runtime.close();
  }
});

const reconnectableOperations: ReadonlyArray<{
  appServerMethod: string;
  invoke: (runtime: CodexRuntime) => Promise<unknown>;
  name: string;
}> = [
  {
    appServerMethod: "thread/read",
    invoke: (runtime) =>
      runtime.readThread({ includeTurns: false, threadId: "thread-read" }),
    name: "readThread",
  },
  {
    appServerMethod: "thread/resume",
    invoke: (runtime) => runtime.resumeThread("thread-resume"),
    name: "resumeThread",
  },
  {
    appServerMethod: "thread/name/set",
    invoke: (runtime) =>
      runtime.setThreadName({ name: "重连任务", threadId: "thread-name" }),
    name: "setThreadName",
  },
  {
    appServerMethod: "thread/unarchive",
    invoke: (runtime) => runtime.unarchiveThread("thread-unarchive"),
    name: "unarchiveThread",
  },
];

for (const operation of reconnectableOperations) {
  test(`${operation.name} reconnects once after App Server EOF`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const runtime = await CodexRuntime.create({
      bridgeInstanceId: `bridge-instance-reconnect-${operation.name}`,
      command: [
        process.execPath,
        fakeRuntime,
        "--eof-method-once",
        operation.appServerMethod,
        join(directory, "eof.marker"),
      ],
      requestTimeoutMs: 1_000,
    });

    try {
      assert.ok(await operation.invoke(runtime));
    } finally {
      runtime.close();
    }
  });
}

for (const outcome of [
  {
    args: ["--hang-method", "thread/start"],
    name: "timeout",
    timeoutMs: 400,
  },
  {
    args: ["--eof-method-always", "thread/start"],
    name: "EOF",
    timeoutMs: 1_000,
  },
] as const) {
  test(`thread/start ${outcome.name} is unknown and is not retried`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const countPath = join(directory, "thread-start.count");
    const runtime = await CodexRuntime.create({
      bridgeInstanceId: `bridge-instance-thread-start-${outcome.name}`,
      command: [
        process.execPath,
        fakeRuntime,
        ...outcome.args,
        "--count-method",
        "thread/start",
        countPath,
      ],
      requestTimeoutMs: outcome.timeoutMs,
    });

    try {
      await assert.rejects(
        runtime.startThread("D:\\No Duplicate Project"),
        (error: unknown) => {
          assert.ok(error instanceof CodexOutcomeUnknownError);
          assert.equal(error.method, "thread/start");
          assert.equal(error.reason, outcome.name.toLowerCase());
          return true;
        },
      );
      await runtime.listThreads();

      assert.equal(Number(readFileSync(countPath, "utf8")), 1);
    } finally {
      runtime.close();
    }
  });
}

test("event subscriptions continue on the replacement App Server", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-reconnect-events",
    command: [
      process.execPath,
      fakeRuntime,
      "--eof-turn-start",
      "--event-before-list",
    ],
    requestTimeoutMs: 1_000,
  });
  const events: unknown[] = [];
  runtime.onEvent((event) => {
    if (event.method === "fixture/listEvent") events.push(event.params);
  });

  try {
    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:reconnect-events",
        text: "触发断链",
        threadId: "thread-reconnect-events",
      }),
      CodexOutcomeUnknownError,
    );
    const listed = await runtime.listThreads();

    assert.deepEqual(events, [
      { pid: (listed.fixture as { pid: number }).pid },
    ]);
  } finally {
    runtime.close();
  }
});

test("concurrent safe requests share one reconnect", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const eofMarker = join(directory, "turn-eof.marker");
  const startsPath = join(directory, "process-starts.log");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-single-flight",
    command: [
      process.execPath,
      fakeRuntime,
      "--eof-method-once",
      "turn/start",
      eofMarker,
      "--record-start",
      startsPath,
    ],
    requestTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:single-flight",
        text: "触发断链",
        threadId: "thread-single-flight",
      }),
      CodexOutcomeUnknownError,
    );
    const listed = await Promise.all([
      runtime.listThreads(),
      runtime.listThreads(),
      runtime.listThreads(),
    ]);

    assert.equal(
      new Set(
        listed.map((result) => (result.fixture as { pid: number }).pid),
      ).size,
      1,
    );
    assert.equal(readFileSync(startsPath, "utf8").trim().split(/\r?\n/u).length, 2);
  } finally {
    runtime.close();
  }
});

test("overlapping timeouts leave the App Server usable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-overlapping-reconnect",
    command: [
      process.execPath,
      fakeRuntime,
      "--hang-turn-start",
      "--hang-method-once",
      "thread/list",
      join(directory, "list-hang.marker"),
    ],
    requestTimeoutMs: 1_500,
  });

  try {
    const unknownTurn = runtime.startTurn({
      clientUserMessageId: "wx:overlapping-reconnect",
      text: "让连接进入待重建状态",
      threadId: "thread-overlapping-reconnect",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    const overlappingList = runtime.listThreads();
    await Promise.all([
      assert.rejects(unknownTurn, CodexOutcomeUnknownError),
      assert.rejects(overlappingList, /thread\/list timed out/u),
    ]);
    const trigger = await runtime.listThreads();
    assert.equal(trigger.nextCursor, null);
  } finally {
    runtime.close();
  }
});

test("one safe call rebuilds the App Server at most once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const startsPath = join(directory, "process-starts.log");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-reconnect-limit",
    command: [
      process.execPath,
      fakeRuntime,
      "--eof-method-always",
      "thread/list",
      "--record-start",
      startsPath,
    ],
    requestTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(runtime.listThreads());
    assert.equal(readFileSync(startsPath, "utf8").trim().split(/\r?\n/u).length, 2);
  } finally {
    runtime.close();
  }
});

test("a closed runtime never reconnects", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const startsPath = join(directory, "process-starts.log");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-closed-runtime",
    command: [
      process.execPath,
      fakeRuntime,
      "--record-start",
      startsPath,
    ],
  });

  runtime.close();
  await assert.rejects(runtime.listThreads(), /Codex runtime is closed/);
  assert.equal(readFileSync(startsPath, "utf8").trim().split(/\r?\n/u).length, 1);
});

test("thread list forwards only public archive pagination fields", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-list-params",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const listed = await runtime.listThreads({
      archived: true,
      cursor: "next-page",
    });
    const fixture = listed.fixture as { threadListParams: unknown };
    assert.deepEqual(fixture.threadListParams, {
      archived: true,
      cursor: "next-page",
    });
  } finally {
    runtime.close();
  }
});

test("the child receives a controlled Bridge environment", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-controlled",
    command: [process.execPath, fakeRuntime],
    environment: {
      ...process.env,
      Codex_Api_Key: "must-not-leak",
      codex_internal_originator_override: "desktop-parent",
      codex_thread_id: "desktop-thread",
      openai_api_key: "must-not-leak-either",
    },
  });

  try {
    const listed = await runtime.listThreads();
    const fixture = listed.fixture as {
      blockedVariables: string[];
      bridge: string | undefined;
      bridgeInstance: string | undefined;
    };

    assert.deepEqual(fixture.blockedVariables, []);
    assert.equal(fixture.bridge, "1");
    assert.equal(fixture.bridgeInstance, "bridge-instance-controlled");
  } finally {
    runtime.close();
  }
});

test("thread metadata operations use the stable public methods", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-metadata",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const read = await runtime.readThread({
      includeTurns: true,
      threadId: "thread-existing",
    });
    const unarchived = await runtime.unarchiveThread("thread-existing");
    const named = await runtime.setThreadName({
      name: "来自微信的任务",
      threadId: "thread-existing",
    });

    assert.deepEqual(read.thread, {
      id: "thread-existing",
      includeTurns: true,
    });
    assert.deepEqual(unarchived.thread, { id: "thread-existing" });
    assert.deepEqual(named, { name: "来自微信的任务" });
  } finally {
    runtime.close();
  }
});

test("existing threads inherit settings and new threads override only cwd", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-thread-start",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const resumed = await runtime.resumeThread("thread-existing");
    const started = await runtime.startThread("D:\\Allowed Project");

    assert.deepEqual(resumed.thread, { id: "thread-existing" });
    assert.deepEqual(started.thread, {
      cwd: "D:\\Allowed Project",
      id: "thread-new",
    });
  } finally {
    runtime.close();
  }
});

test("a freshly started thread can run its first turn without an impossible resume", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-new-turn-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const resumeCountPath = join(directory, "thread-resume.count");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-new-turn",
    command: [
      process.execPath,
      fakeRuntime,
      "--count-method",
      "thread/resume",
      resumeCountPath,
    ],
  });

  try {
    const started = await runtime.startThread("D:\\New Project");
    await runtime.ensureThread(started.thread.id);
    await runtime.startTurn({
      clientUserMessageId: "wx:new-thread:first-message",
      text: "first message",
      threadId: started.thread.id,
    });

    assert.equal(existsSync(resumeCountPath), false);
  } finally {
    runtime.close();
  }
});

test("turn submission carries the durable client id without configuration overrides", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-turn",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const started = await runtime.startTurn({
      clientUserMessageId: "wx:controller-1:message-42",
      text: "继续检查这个项目",
      threadId: "thread-existing",
    });

    assert.deepEqual(started.turn, { id: "turn-new" });
    assert.deepEqual(started.fixtureParams, {
      clientUserMessageId: "wx:controller-1:message-42",
      input: [
        {
          text: "继续检查这个项目",
          text_elements: [],
          type: "text",
        },
      ],
      threadId: "thread-existing",
    });
  } finally {
    runtime.close();
  }
});

test("turn submission maps WeChat media to stable App Server inputs", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-media-turn",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const started = await runtime.startTurn({
      attachments: [
        {
          kind: "image",
          name: "photo.jpg",
          path: "C:\\Codex_iLink\\media\\photo.jpg",
        },
        {
          kind: "file",
          name: "report.pdf",
          path: "C:\\Codex_iLink\\media\\report.pdf",
        },
        {
          kind: "video",
          name: "clip.mp4",
          path: "C:\\Codex_iLink\\media\\clip.mp4",
        },
      ],
      clientUserMessageId: "wx:controller-1:media-42",
      text: "请查看附件",
      threadId: "thread-existing",
    });

    assert.deepEqual(started.fixtureParams, {
      clientUserMessageId: "wx:controller-1:media-42",
      input: [
        {
          text: "请查看附件",
          text_elements: [],
          type: "text",
        },
        {
          path: "C:\\Codex_iLink\\media\\photo.jpg",
          type: "localImage",
        },
        {
          name: "report.pdf",
          path: "C:\\Codex_iLink\\media\\report.pdf",
          type: "mention",
        },
        {
          name: "clip.mp4",
          path: "C:\\Codex_iLink\\media\\clip.mp4",
          type: "mention",
        },
      ],
      threadId: "thread-existing",
    });
  } finally {
    runtime.close();
  }
});

test("attachment-only turns do not add a synthetic text input", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-image-only-turn",
    command: [process.execPath, fakeRuntime],
  });

  try {
    const started = await runtime.startTurn({
      attachments: [
        {
          kind: "image",
          name: "photo.png",
          path: "D:\\Inbox\\photo.png",
        },
      ],
      clientUserMessageId: "wx:controller-1:image-only",
      text: "",
      threadId: "thread-existing",
    });

    assert.deepEqual(started.fixtureParams, {
      clientUserMessageId: "wx:controller-1:image-only",
      input: [{ path: "D:\\Inbox\\photo.png", type: "localImage" }],
      threadId: "thread-existing",
    });
  } finally {
    runtime.close();
  }
});

test("App Server notifications and requests are exposed as runtime events", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-events",
    command: [process.execPath, fakeRuntime],
  });
  const events: unknown[] = [];
  const unsubscribe = runtime.onEvent((event) => events.push(event));

  try {
    const started = await runtime.startTurn({
      clientUserMessageId: "wx:event-message",
      text: "触发事件",
      threadId: "thread-events",
    });

    assert.equal(started.turn.id, "turn-new");
    const [serverRequest, statusEvent] = events as Array<{
      id?: number | string;
      method: string;
      params: Record<string, unknown>;
    }>;
    assert.match(String(serverRequest?.id), /^codex-runtime-request:/);
    assert.deepEqual(
      { method: serverRequest?.method, params: serverRequest?.params },
      {
        method: "item/tool/requestUserInput",
        params: { questions: [] },
      },
    );
    assert.deepEqual(statusEvent, {
      method: "thread/status/changed",
      params: {
        status: { type: "active" },
        threadId: "thread-events",
      },
    });
  } finally {
    unsubscribe();
    runtime.close();
  }
});

test("server requests can be answered through the persistent runtime", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-server-response",
    command: [process.execPath, fakeRuntime],
  });
  let requestId: number | string | undefined;
  const responseSeen = new Promise<Record<string, unknown>>((resolveResponse) => {
    runtime.onEvent((event) => {
      if (event.method === "item/tool/requestUserInput") {
        requestId = event.id;
      } else if (event.method === "fixture/serverRequestResponse") {
        resolveResponse(event.params);
      }
    });
  });

  try {
    await runtime.startTurn({
      clientUserMessageId: "wx:approval-message",
      text: "触发审批",
      threadId: "thread-approval",
    });
    assert.match(String(requestId), /^codex-runtime-request:/);

    assert.equal(
      runtime.respondToServerRequest(requestId!, {
        answers: { permission: "allow" },
      }),
      true,
    );
    assert.deepEqual(await responseSeen, {
      result: { answers: { permission: "allow" } },
    });
  } finally {
    runtime.close();
  }
});

test("a server request remains live after its turn start response times out", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const responseCountPath = join(directory, "server-responses.count");
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-stale-server-request",
    command: [
      process.execPath,
      fakeRuntime,
      "--request-then-hang-turn-start",
      "--count-server-responses",
      responseCountPath,
    ],
    requestTimeoutMs: 400,
  });
  let requestId: number | string | undefined;
  runtime.onEvent((event) => {
    if (event.method === "item/tool/requestUserInput") requestId = event.id;
  });

  try {
    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:stale-server-request",
        text: "触发旧连接请求",
        threadId: "thread-stale-server-request",
      }),
      CodexOutcomeUnknownError,
    );
    assert.notEqual(requestId, undefined);

    await runtime.listThreads();
    assert.equal(
      runtime.respondToServerRequest(requestId!, { decision: "decline" }),
      true,
    );
    await runtime.listThreads();

    assert.equal(
      existsSync(responseCountPath)
        ? Number(readFileSync(responseCountPath, "utf8"))
        : 0,
      1,
    );
  } finally {
    runtime.close();
  }
});

test("a turn/start timeout is an unknown submission outcome", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-timeout",
    command: [process.execPath, fakeRuntime, "--hang-turn-start"],
    requestTimeoutMs: 250,
  });

  try {
    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:timeout-message",
        text: "可能已经被接受",
        threadId: "thread-timeout",
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexOutcomeUnknownError);
        assert.equal(error.kind, "outcome-unknown");
        assert.equal(error.method, "turn/start");
        assert.equal(error.reason, "timeout");
        return true;
      },
    );
  } finally {
    runtime.close();
  }
});

test("the next safe request keeps the live process after a turn/start timeout", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-timeout-reconnect",
    command: [process.execPath, fakeRuntime, "--hang-turn-start"],
    requestTimeoutMs: 400,
  });

  try {
    const before = await runtime.listThreads();
    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:timeout-then-reconnect",
        text: "可能已经被接受",
        threadId: "thread-timeout-reconnect",
      }),
      CodexOutcomeUnknownError,
    );
    const after = await runtime.listThreads();

    assert.equal(
      (before.fixture as { pid: number }).pid,
      (after.fixture as { pid: number }).pid,
    );
  } finally {
    runtime.close();
  }
});

test("stdout EOF during turn/start is an unknown submission outcome", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-eof",
    command: [process.execPath, fakeRuntime, "--eof-turn-start"],
    requestTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(
      runtime.startTurn({
        clientUserMessageId: "wx:eof-message",
        text: "断链前可能已经提交",
        threadId: "thread-eof",
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexOutcomeUnknownError);
        assert.equal(error.kind, "outcome-unknown");
        assert.equal(error.method, "turn/start");
        assert.equal(error.reason, "eof");
        return true;
      },
    );
  } finally {
    runtime.close();
  }
});

for (const previousOutcome of [
  {
    args: (markerPath: string) => [
      "--hang-method-once",
      "turn/start",
      markerPath,
    ],
    name: "timeout",
    timeoutMs: 400,
  },
  {
    args: (markerPath: string) => [
      "--eof-method-once",
      "turn/start",
      markerPath,
    ],
    name: "EOF",
    timeoutMs: 1_000,
  },
] as const) {
  test(`a new turn proceeds once after a previous ${previousOutcome.name}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const countPath = join(directory, "turn-start.count");
    const runtime = await CodexRuntime.create({
      bridgeInstanceId: `bridge-instance-turn-preflight-${previousOutcome.name}`,
      command: [
        process.execPath,
        fakeRuntime,
        ...previousOutcome.args(join(directory, "first-attempt.marker")),
        "--count-method",
        "turn/start",
        countPath,
      ],
      requestTimeoutMs: previousOutcome.timeoutMs,
    });

    try {
      await assert.rejects(
        runtime.startTurn({
          clientUserMessageId: `wx:preflight-first-${previousOutcome.name}`,
          text: "第一次提交结果未知",
          threadId: "thread-turn-preflight",
        }),
        CodexOutcomeUnknownError,
      );
      const second = await runtime.startTurn({
        clientUserMessageId: `wx:preflight-second-${previousOutcome.name}`,
        text: "这是明确的第二次提交",
        threadId: "thread-turn-preflight",
      });

      assert.equal(second.turn.id, "turn-new");
      assert.equal(Number(readFileSync(countPath, "utf8")), 2);
    } finally {
      runtime.close();
    }
  });
}

for (const outcome of [
  { flag: "--hang-turn-start", name: "timeout", timeoutMs: 400 },
  { flag: "--eof-turn-start", name: "EOF", timeoutMs: 1_000 },
] as const) {
  test(`turn/start ${outcome.name} is never retried`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codex-ilink-runtime-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const countPath = join(directory, "turn-start.count");
    const runtime = await CodexRuntime.create({
      bridgeInstanceId: `bridge-instance-no-turn-retry-${outcome.name}`,
      command: [
        process.execPath,
        fakeRuntime,
        outcome.flag,
        "--count-method",
        "turn/start",
        countPath,
      ],
      requestTimeoutMs: outcome.timeoutMs,
    });

    try {
      await assert.rejects(
        runtime.startTurn({
          clientUserMessageId: `wx:no-retry-${outcome.name}`,
          text: "只允许提交一次",
          threadId: "thread-no-turn-retry",
        }),
        CodexOutcomeUnknownError,
      );
      await runtime.listThreads();

      assert.equal(Number(readFileSync(countPath, "utf8")), 1);
    } finally {
      runtime.close();
    }
  });
}

test("stderr output cannot backpressure the persistent App Server", async () => {
  const runtime = await CodexRuntime.create({
    bridgeInstanceId: "bridge-instance-stderr",
    command: [process.execPath, fakeRuntime, "--stderr-before-list"],
    requestTimeoutMs: 500,
  });

  try {
    const listed = await runtime.listThreads();
    assert.deepEqual(listed.data, []);
  } finally {
    runtime.close();
  }
});
