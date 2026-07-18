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
let experimentalApi = false;
const activePermissionProfiles = new Map();
const activeModels = new Map();
const activeReasoningEfforts = new Map();
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
    experimentalApi = message.params?.capabilities?.experimentalApi === true;
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

  if (message.method === "permissionProfile/list") {
    if (!experimentalApi) {
      respondError(message.id, -32600, "experimentalApi capability required");
      return;
    }
    if (!hasExactKeys(message.params, ["cwd"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {
      data: [
        { allowed: true, description: null, id: ":read-only" },
        { allowed: true, description: null, id: ":workspace" },
        { allowed: true, description: null, id: ":danger-full-access" },
      ],
      nextCursor: null,
    });
    return;
  }

  if (message.method === "model/list") {
    if (!hasExactKeys(message.params, [])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {
      data: [
        {
          defaultReasoningEffort: "medium",
          displayName: "GPT-5.6 Sol",
          hidden: false,
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: [
            { description: "Fast", reasoningEffort: "high" },
            { description: "Deep", reasoningEffort: "xhigh" },
          ],
        },
      ],
      nextCursor: null,
    });
    return;
  }

  if (message.method === "thread/resume") {
    if (message.params.permissions && !experimentalApi) {
      respondError(message.id, -32600, "experimentalApi capability required");
      return;
    }
    if (
      !hasExactKeys(message.params, ["developerInstructions", "threadId"]) &&
      !hasExactKeys(message.params, [
        "developerInstructions",
        "permissions",
        "threadId",
      ])
    ) {
      rejectUnexpectedParams(message);
      return;
    }
    const activePermissionProfile = activePermissionProfiles.has(
      message.params.threadId,
    )
      ? activePermissionProfiles.get(message.params.threadId)
      : (message.params.permissions ?? ":workspace");
    activePermissionProfiles.set(
      message.params.threadId,
      activePermissionProfile,
    );
    respond(message.id, {
      activePermissionProfile: {
        id: activePermissionProfile,
      },
      approvalPolicy:
        activePermissionProfile === ":danger-full-access"
          ? "never"
          : "on-request",
      cwd: "D:\\Fixture",
      model: activeModels.get(message.params.threadId) ?? "gpt-fixture",
      reasoningEffort:
        activeReasoningEfforts.get(message.params.threadId) ?? "medium",
      sandbox: {
        type:
          activePermissionProfile === ":danger-full-access"
            ? "dangerFullAccess"
            : "workspaceWrite",
      },
      fixtureParams: message.params,
      thread: { id: message.params.threadId },
    });
    return;
  }

  if (message.method === "thread/settings/update") {
    if (!experimentalApi) {
      respondError(message.id, -32600, "experimentalApi capability required");
      return;
    }
    const isPermissionUpdate = hasExactKeys(message.params, [
      "permissions",
      "threadId",
    ]);
    const isModelUpdate =
      hasExactKeys(message.params, ["model", "threadId"]) ||
      hasExactKeys(message.params, ["effort", "threadId"]) ||
      hasExactKeys(message.params, ["effort", "model", "threadId"]);
    if (!isPermissionUpdate && !isModelUpdate) {
      rejectUnexpectedParams(message);
      return;
    }
    if (!activePermissionProfiles.has(message.params.threadId)) {
      respondError(message.id, -32602, "thread is not loaded");
      return;
    }
    if (isPermissionUpdate) {
      activePermissionProfiles.set(
        message.params.threadId,
        message.params.permissions,
      );
    }
    if (message.params.model) {
      activeModels.set(message.params.threadId, message.params.model);
    }
    if (message.params.effort) {
      activeReasoningEfforts.set(message.params.threadId, message.params.effort);
    }
    respond(message.id, {});
    return;
  }

  if (message.method === "thread/start") {
    if (
      !hasExactKeys(message.params, [
        "cwd",
        "developerInstructions",
        "dynamicTools",
      ])
    ) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {
      fixtureParams: message.params,
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
    return;
  }

  if (message.method === "turn/interrupt") {
    if (!hasExactKeys(message.params, ["threadId", "turnId"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {});
    return;
  }

  if (message.method === "thread/compact/start") {
    if (!hasExactKeys(message.params, ["threadId"])) {
      rejectUnexpectedParams(message);
      return;
    }
    respond(message.id, {});
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

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
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
