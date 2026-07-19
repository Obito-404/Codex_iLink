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
const recordServerResponsesIndex = process.argv.indexOf(
  "--record-server-responses",
);
const recordServerResponsesPath =
  recordServerResponsesIndex === -1
    ? null
    : process.argv[recordServerResponsesIndex + 1];
const delayControlRouterIndex = process.argv.indexOf(
  "--delay-control-router-ms",
);
const delayControlRouterMs =
  delayControlRouterIndex === -1
    ? 0
    : Number(process.argv[delayControlRouterIndex + 1]);
const delayControlRouterCountIndex = process.argv.indexOf(
  "--delay-control-router-count",
);
const delayControlRouterCount =
  delayControlRouterCountIndex === -1
    ? Number.POSITIVE_INFINITY
    : Number(process.argv[delayControlRouterCountIndex + 1]);
const controlRouterResultToolIndex = process.argv.indexOf(
  "--control-router-result-tool",
);
const controlRouterResultTool =
  controlRouterResultToolIndex === -1
    ? "route_ilink_control"
    : process.argv[controlRouterResultToolIndex + 1];
const uniqueControlRouterThreads = process.argv.includes(
  "--unique-control-router-threads",
);
const recordStartIndex = process.argv.indexOf("--record-start");
if (recordStartIndex !== -1) {
  appendFileSync(process.argv[recordStartIndex + 1], `${process.pid}\n`);
}

let initializeCount = 0;
let nextControlRouterThreadId = 1;
let controlRouterTurnCount = 0;
let experimentalApi = false;
const activePermissionProfiles = new Map();
const activeApprovalPolicies = new Map();
const activeApprovalsReviewers = new Map();
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
    if (recordServerResponsesPath) {
      appendFileSync(
        recordServerResponsesPath,
        `${JSON.stringify(message.result)}\n`,
      );
    }
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
    if (
      !hasExactKeys(message.params, ["developerInstructions", "threadId"])
    ) {
      rejectUnexpectedParams(message);
      return;
    }
    const activePermissionProfile = activePermissionProfiles.has(
      message.params.threadId,
    )
      ? activePermissionProfiles.get(message.params.threadId)
      : ":workspace";
    activePermissionProfiles.set(
      message.params.threadId,
      activePermissionProfile,
    );
    const approvalPolicy = activeApprovalPolicies.has(message.params.threadId)
      ? activeApprovalPolicies.get(message.params.threadId)
      : "on-request";
    const approvalsReviewer = activeApprovalsReviewers.has(message.params.threadId)
      ? activeApprovalsReviewers.get(message.params.threadId)
      : "user";
    activeApprovalPolicies.set(message.params.threadId, approvalPolicy);
    activeApprovalsReviewers.set(message.params.threadId, approvalsReviewer);
    respond(message.id, {
      activePermissionProfile: {
        id: activePermissionProfile,
      },
      approvalPolicy,
      approvalsReviewer,
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
    const isModelUpdate =
      hasExactKeys(message.params, ["model", "threadId"]) ||
      hasExactKeys(message.params, ["effort", "threadId"]) ||
      hasExactKeys(message.params, ["effort", "model", "threadId"]);
    if (!isModelUpdate) {
      rejectUnexpectedParams(message);
      return;
    }
    if (!activePermissionProfiles.has(message.params.threadId)) {
      respondError(message.id, -32602, "thread is not loaded");
      return;
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
    const isControlRouter = message.params.ephemeral === true;
    if (
      !hasExactKeys(
        message.params,
        isControlRouter
          ? ["cwd", "developerInstructions", "dynamicTools", "ephemeral"]
          : ["cwd", "developerInstructions", "dynamicTools"],
      )
    ) {
      rejectUnexpectedParams(message);
      return;
    }
    if (isControlRouter) {
      const tool = message.params.dynamicTools[0];
      const properties = tool?.inputSchema?.properties;
      if (
        tool?.name !== "route_ilink_control" ||
        !properties?.kind?.enum?.includes("controlSequence") ||
        properties?.intents?.maxItems !== 4
      ) {
        rejectUnexpectedParams(message);
        return;
      }
    }
    respond(message.id, {
      fixtureParams: message.params,
      thread: {
        cwd: message.params.cwd,
        id: isControlRouter
          ? uniqueControlRouterThreads
            ? `thread-control-router-${nextControlRouterThreadId++}`
            : "thread-control-router"
          : "thread-new",
      },
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
    if (message.params.threadId.startsWith("thread-control-router")) {
      const text = message.params.input[0]?.text;
      const control = text?.includes("返回")
        ? {
            intents: [{ kind: "exitSession" }, { kind: "status" }],
            kind: "controlSequence",
          }
        : { kind: "help" };
      const emitControlToolCall = () => {
        process.stdout.write(
          `${JSON.stringify({
            id: "control-router-tool-request",
            method: "item/tool/call",
            params: {
              arguments: control,
              callId: "control-router-call",
              namespace: null,
              threadId: message.params.threadId,
              tool: controlRouterResultTool,
              turnId: "turn-control-router",
            },
          })}\n`,
        );
      };
      const emitControlCompleted = () => {
        process.stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: message.params.threadId,
              turn: { id: "turn-control-router", status: "completed" },
            },
          })}\n`,
        );
      };
      if (
        delayControlRouterMs > 0 &&
        controlRouterTurnCount++ < delayControlRouterCount
      ) {
        respond(message.id, {
          fixtureParams: message.params,
          turn: { id: "turn-control-router" },
        });
        setTimeout(() => {
          emitControlToolCall();
          emitControlCompleted();
        }, delayControlRouterMs);
      } else {
        emitControlToolCall();
        respond(message.id, {
          fixtureParams: message.params,
          turn: { id: "turn-control-router" },
        });
        emitControlCompleted();
      }
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
