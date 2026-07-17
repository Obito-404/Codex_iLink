import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import readline from "node:readline";

const eofMethodOnceIndex = process.argv.indexOf("--eof-method-once");
const eofMethodOnce =
  eofMethodOnceIndex === -1
    ? null
    : {
        markerPath: process.argv[eofMethodOnceIndex + 2],
        method: process.argv[eofMethodOnceIndex + 1],
      };
const eofMethodAlwaysIndex = process.argv.indexOf("--eof-method-always");
const eofMethodAlways =
  eofMethodAlwaysIndex === -1
    ? null
    : process.argv[eofMethodAlwaysIndex + 1];
const hangMethodIndex = process.argv.indexOf("--hang-method");
const hangMethod =
  hangMethodIndex === -1 ? null : process.argv[hangMethodIndex + 1];
const hangMethodOnceIndex = process.argv.indexOf("--hang-method-once");
const hangMethodOnce =
  hangMethodOnceIndex === -1
    ? null
    : {
        markerPath: process.argv[hangMethodOnceIndex + 2],
        method: process.argv[hangMethodOnceIndex + 1],
      };
const countMethodIndex = process.argv.indexOf("--count-method");
const countMethod =
  countMethodIndex === -1
    ? null
    : {
        countPath: process.argv[countMethodIndex + 2],
        method: process.argv[countMethodIndex + 1],
      };
const countServerResponsesIndex = process.argv.indexOf(
  "--count-server-responses",
);
const countServerResponsesPath =
  countServerResponsesIndex === -1
    ? null
    : process.argv[countServerResponsesIndex + 1];
const recordStartIndex = process.argv.indexOf("--record-start");
if (recordStartIndex !== -1) {
  appendFileSync(process.argv[recordStartIndex + 1], `${process.pid}\n`);
}

let initializeCount = 0;
const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (countMethod && message.method === countMethod.method) {
    incrementFile(countMethod.countPath);
  }

  if (
    eofMethodOnce &&
    message.method === eofMethodOnce.method &&
    !existsSync(eofMethodOnce.markerPath)
  ) {
    writeFileSync(eofMethodOnce.markerPath, String(process.pid));
    process.exit(0);
    return;
  }
  if (message.method === eofMethodAlways) {
    process.exit(0);
    return;
  }
  if (message.method === hangMethod) return;
  if (
    hangMethodOnce &&
    message.method === hangMethodOnce.method &&
    !existsSync(hangMethodOnce.markerPath)
  ) {
    writeFileSync(hangMethodOnce.markerPath, String(process.pid));
    return;
  }

  if (message.method === undefined && message.result) {
    if (countServerResponsesPath) incrementFile(countServerResponsesPath);
    process.stdout.write(
      `${JSON.stringify({
        method: "fixture/serverRequestResponse",
        params: { result: message.result },
      })}\n`,
    );
    return;
  }

  if (message.method === "initialize") {
    initializeCount += 1;
    respond(message.id, { userAgent: "fake-codex-runtime" });
    return;
  }

  if (message.method === "initialized") return;

  if (message.method === "thread/list") {
    const blockedNames = new Set([
      "CODEX_API_KEY",
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
      "CODEX_THREAD_ID",
      "OPENAI_API_KEY",
    ]);
    const result = {
      data: [],
      nextCursor: null,
      fixture: {
        blockedVariables: Object.keys(process.env)
          .map((name) => name.toUpperCase())
          .filter((name) => blockedNames.has(name))
          .sort(),
        bridge: process.env.CODEX_ILINK_BRIDGE,
        bridgeInstance: process.env.CODEX_ILINK_BRIDGE_INSTANCE,
        initializeCount,
        pid: process.pid,
        threadListParams: message.params,
      },
    };
    if (process.argv.includes("--event-before-list")) {
      process.stdout.write(
        `${JSON.stringify({
          method: "fixture/listEvent",
          params: { pid: process.pid },
        })}\n`,
      );
    }
    if (process.argv.includes("--stderr-before-list")) {
      process.stderr.write("x".repeat(1_000_000), () => respond(message.id, result));
      return;
    }
    respond(message.id, result);
    return;
  }

  if (message.method === "thread/read") {
    if (!hasExactKeys(message.params, ["includeTurns", "threadId"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {
      thread: {
        id: message.params.threadId,
        includeTurns: message.params.includeTurns,
      },
    });
    return;
  }

  if (message.method === "thread/unarchive") {
    if (!hasExactKeys(message.params, ["threadId"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, { thread: { id: message.params.threadId } });
    return;
  }

  if (message.method === "thread/name/set") {
    if (!hasExactKeys(message.params, ["name", "threadId"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, { name: message.params.name });
    return;
  }

  if (message.method === "thread/resume") {
    if (!hasExactKeys(message.params, ["threadId"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, { thread: { id: message.params.threadId } });
    return;
  }

  if (message.method === "thread/start") {
    if (!hasExactKeys(message.params, ["cwd"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {
      thread: { cwd: message.params.cwd, id: "thread-new" },
    });
    return;
  }

  if (message.method === "turn/start") {
    if (
      !hasExactKeys(message.params, [
        "clientUserMessageId",
        "input",
        "threadId",
      ])
    ) {
      rejectUnexpectedParams(message);
      return;
    }
    if (process.argv.includes("--request-then-hang-turn-start")) {
      emitTurnEvents(message);
      return;
    }
    if (process.argv.includes("--hang-turn-start")) return;
    if (process.argv.includes("--eof-turn-start")) {
      process.exit(0);
      return;
    }
    emitTurnEvents(message);
    respond(message.id, {
      fixtureParams: message.params,
      turn: { id: "turn-new" },
    });
  }
});

function emitTurnEvents(message) {
  process.stdout.write(
    `${JSON.stringify({
      id: message.id,
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      method: "thread/status/changed",
      params: {
        status: { type: "active" },
        threadId: message.params.threadId,
      },
    })}\n`,
  );
}

function incrementFile(path) {
  const count = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
  writeFileSync(path, String(count + 1));
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function hasExactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.slice().sort())
  );
}

function rejectUnexpectedParams(message) {
  process.stdout.write(
    `${JSON.stringify({
      id: message.id,
      error: {
        code: -32602,
        message: `unexpected ${message.method} params: ${Object.keys(message.params ?? {}).sort().join(",")}`,
      },
    })}\n`,
  );
}
