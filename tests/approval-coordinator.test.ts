import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalCoordinator } from "../src/bridge/approval-coordinator.ts";
import {
  CREDENTIAL_COMMANDS,
  LOCAL_PATH_COMMANDS,
  SAFE_COMMANDS,
} from "./approval-security-vectors.ts";

test("one live approval uses bare y or n and is answered once", async () => {
  const sent: Array<{ clientId: string; text: string }> = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text, clientId) {
      sent.push({ clientId, text });
    },
    now: () => 1_000,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  assert.equal(
    await approvals.ingest({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm test",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }),
    true,
  );
  const code = approvals.list()[0]?.code;
  assert.match(code ?? "", /^[A-F][A-F\d]{5}$/u);
  assert.match(sent[0]?.text ?? "", /需要批准[\s\S]*pnpm test[\s\S]*回复：y 或 n/u);
  assert.doesNotMatch(sent[0]?.text ?? "", new RegExp(code ?? "missing", "u"));
  assert.deepEqual(approvals.decide(null, true), { code, kind: "decided" });
  assert.deepEqual(responses, [{ id: 41, result: { decision: "accept" } }]);
  assert.deepEqual(approvals.decide(code ?? "", true), {
    code,
    kind: "not-found",
  });
});

test("a live Desktop Hook approval uses the same y/n decision queue", async () => {
  const decisions: boolean[] = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_250,
    respond() {},
  });

  assert.equal(
    await approvals.ingestCallback({
      isLive: () => true,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "shutdown /s /t 0",
        itemId: "desktop-request-1",
        threadId: "desktop-thread",
        turnId: "desktop-turn",
      },
      respond: (approved) => {
        decisions.push(approved);
      },
    }),
    true,
  );

  assert.match(approvals.list()[0]?.summary ?? "", /shutdown \/s \/t 0/u);
  assert.deepEqual(approvals.decide(null, true).kind, "decided");
  assert.deepEqual(decisions, [true]);
});

test("multiple approvals require their immutable short codes", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_500,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  for (const [id, itemId, command] of [
    [51, "item-a", "pnpm test"],
    [52, "item-b", "pnpm typecheck"],
  ] as const) {
    await approvals.ingest({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        command,
        itemId,
        threadId: `thread-${itemId}`,
        turnId: `turn-${itemId}`,
      },
    });
  }

  const [first, second] = approvals.list();
  assert.match(first?.code ?? "", /^[A-F][A-F\d]{5}$/u);
  assert.match(second?.code ?? "", /^[A-F][A-F\d]{5}$/u);
  assert.notEqual(first?.code, second?.code);
  assert.match(sent[0] ?? "", /回复：y 或 n/u);
  assert.match(sent[1] ?? "", /当前有多个待审批/u);
  assert.match(
    sent[1] ?? "",
    new RegExp(`${first?.code}：Command: pnpm test`, "u"),
  );
  assert.match(
    sent[1] ?? "",
    new RegExp(`${second?.code}：Command: pnpm typecheck`, "u"),
  );
  assert.match(
    sent[1] ?? "",
    /逐条：y<code> \/ n<code>；批量：ya \/ na（需确认）/u,
  );
  assert.deepEqual(approvals.decide(null, true), {
    approvals: [first, second],
    kind: "ambiguous",
  });
  assert.deepEqual(responses, []);

  assert.deepEqual(approvals.decide(second?.code ?? "", false), {
    code: second?.code,
    kind: "decided",
  });
  assert.deepEqual(responses, [{ id: 52, result: { decision: "decline" } }]);
});

test("batch decisions snapshot current approvals and exclude later requests", async () => {
  const decisions: string[] = [];
  const live = new Map<string, boolean>();
  let spawned: Promise<boolean> | null = null;
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_550,
    respond() {},
  });
  const ingest = (
    itemId: string,
    respond: (approved: boolean) => boolean | void,
  ) => {
    live.set(itemId, true);
    return approvals.ingestCallback({
      isLive: () => live.get(itemId) === true,
      method: "item/commandExecution/requestApproval",
      params: {
        command: itemId,
        itemId,
        threadId: `thread-${itemId}`,
        turnId: `turn-${itemId}`,
      },
      respond,
    });
  };

  try {
    await ingest("first", (approved) => {
      decisions.push(`first:${String(approved)}`);
      spawned = ingest("later", (laterApproved) => {
        decisions.push(`later:${String(laterApproved)}`);
      });
    });
    await ingest("second", (approved) => {
      decisions.push(`second:${String(approved)}`);
    });

    const codes = approvals.list().map((approval) => approval.code);
    live.set("second", false);
    assert.deepEqual(approvals.decideMany(codes, true), {
      attempted: 2,
      decided: 1,
    });
    await spawned;
    assert.deepEqual(decisions, ["first:true"]);
    assert.deepEqual(
      approvals.list().map((approval) => approval.summary),
      ["Command: later"],
    );
  } finally {
    approvals.close();
  }
});

test("approval summaries preserve both the reason and concrete command", async () => {
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_600,
    respond() {},
  });

  await approvals.ingest({
    id: 53,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "shutdown /s /t 0",
      itemId: "item-shutdown",
      reason: "是否允许我立即关闭这台电脑？",
      threadId: "thread-shutdown",
      turnId: "turn-shutdown",
    },
  });

  assert.match(
    approvals.list()[0]?.summary ?? "",
    /是否允许我立即关闭这台电脑？[\s\S]*shutdown \/s \/t 0/u,
  );
});

test("secret-bearing or semantically unsafe summaries stay in the native client", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_650,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  await approvals.ingest({
    id: 54,
    method: "item/commandExecution/requestApproval",
    params: {
      command:
        "curl https://user:password@example.com -H 'Authorization: Bearer top-secret' " +
        "-H \"Cookie: session=prod-session\" " +
        "--cookie cli-cookie-secret --cookie-jar cookie-file-secret " +
        "--data '{\"api_key\":\"json-secret\",\"password\":\"json-password\"}' " +
        "ACCESS_TOKEN=env-secret AWS_SECRET_ACCESS_KEY=aws-secret " +
        "psql postgresql://admin:database-secret@db/prod",
      cwd: "D:\\Users\\alice\\Secret Project",
      itemId: "item-sanitized",
      reason: "publish release",
      threadId: "thread-sanitized",
      turnId: "turn-sanitized",
    },
  });
  for (const [id, command] of [
    [55, "echo safe\nshutdown /s /t 0"],
    [56, '$env:API_KEY="$(Remove-Item -Recurse C:\\important)"; npm publish'],
    [57, "API_KEY=x&&format C: /Q"],
    [58, "echo safe\u202E"],
    [
      59,
      "curl -u admin:prod-password -b SID=prod-cookie https://example.com",
    ],
    [60, "echo safe\u2028shutdown /s /t 0"],
  ] as const) {
    await approvals.ingest({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        command,
        itemId: `item-unsafe-${String(id)}`,
        threadId: "thread-unsafe",
        turnId: `turn-unsafe-${String(id)}`,
      },
    });
  }

  assert.deepEqual(sent, []);
  assert.deepEqual(
    responses,
    [54, 55, 56, 57, 58, 59, 60].map((id) => ({
      id,
      result: { decision: "decline" },
    })),
  );
  assert.deepEqual(approvals.list(), []);
});

test("common credential-bearing commands stay in the native client", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_660,
    respond(id, result) {
      responses.push({ id, result });
    },
  });
  const commands = CREDENTIAL_COMMANDS;

  try {
    for (const [index, command] of commands.entries()) {
      await approvals.ingest({
        id: 100 + index,
        method: "item/commandExecution/requestApproval",
        params: {
          command,
          itemId: `credential-item-${String(index)}`,
          threadId: "credential-thread",
          turnId: `credential-turn-${String(index)}`,
        },
      });
    }

    assert.deepEqual(sent, []);
    assert.deepEqual(
      responses,
      commands.map((_command, index) => ({
        id: 100 + index,
        result: { decision: "decline" },
      })),
    );
    assert.deepEqual(approvals.list(), []);
  } finally {
    approvals.close();
  }
});

test("App Server approvals show only a verified cwd project name", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_665,
    respond(id, result) {
      responses.push({ id, result });
    },
  });
  const unverifiableContexts = [
    { cwd: "Codex_iLink" },
    { cwd: "C:\\" },
    { cwd: "\\\\server\\share\\Codex_iLink" },
    { cwd: "\\\\?\\C:\\Codex_iLink" },
    { cwd: "C:\\Users\\alice\\..\\Codex_iLink" },
    { cwd: "C:\\Work\\CONIN$" },
    { cwd: "C:\\Work\\CONOUT$" },
    { cwd: "C:\\Work\\CLOCK$" },
    { cwd: "C:\\Work\\COM¹" },
    { cwd: "C:\\Work\\LPT³" },
    { environment_id: "production" },
    { permission_suggestions: [{ scope: "session" }] },
    { futureSemanticContext: { elevated: true } },
  ] as const;

  try {
    for (const [index, context] of unverifiableContexts.entries()) {
      await approvals.ingest({
        id: 200 + index,
        method: "item/commandExecution/requestApproval",
        params: {
          command: "npm test",
          ...context,
          itemId: `context-item-${String(index)}`,
          threadId: "context-thread",
          turnId: `context-turn-${String(index)}`,
        },
      });
    }
    await approvals.ingest({
      id: 299,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "npm test",
        cwd: "D:\\Workspaces\\Codex_iLink",
        itemId: "verified-context-item",
        threadId: "verified-context-thread",
        turnId: "verified-context-turn",
      },
    });

    assert.equal(sent.length, 1);
    assert.match(
      sent[0] ?? "",
      /Command: npm test[\s\S]*Project: Codex_iLink/u,
    );
    assert.doesNotMatch(sent[0] ?? "", /D:\\Workspaces|Users\\alice/u);
    assert.deepEqual(
      responses,
      unverifiableContexts.map((_context, index) => ({
        id: 200 + index,
        result: { decision: "decline" },
      })),
    );
    assert.equal(approvals.decide(null, true).kind, "decided");
    assert.deepEqual(responses.at(-1), {
      id: 299,
      result: { decision: "accept" },
    });
  } finally {
    approvals.close();
  }
});

test("commands containing absolute local paths stay in the native client", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_667,
    respond(id, result) {
      responses.push({ id, result });
    },
  });
  const commands = LOCAL_PATH_COMMANDS;

  try {
    for (const [index, command] of commands.entries()) {
      await approvals.ingest({
        id: 300 + index,
        method: "item/commandExecution/requestApproval",
        params: {
          command,
          cwd: "D:\\Workspaces\\Codex_iLink",
          itemId: `local-path-item-${String(index)}`,
          threadId: "local-path-thread",
          turnId: `local-path-turn-${String(index)}`,
        },
      });
    }

    assert.deepEqual(sent, []);
    assert.deepEqual(
      responses,
      commands.map((_command, index) => ({
        id: 300 + index,
        result: { decision: "decline" },
      })),
    );
  } finally {
    approvals.close();
  }
});

test("safe URLs and relative paths remain remotely approvable", async () => {
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_668,
    respond() {},
  });
  const commands = SAFE_COMMANDS;

  try {
    for (const [index, command] of commands.entries()) {
      await approvals.ingest({
        id: 400 + index,
        method: "item/commandExecution/requestApproval",
        params: {
          command,
          cwd: "D:\\Workspaces\\Codex_iLink",
          itemId: `safe-path-item-${String(index)}`,
          threadId: "safe-path-thread",
          turnId: `safe-path-turn-${String(index)}`,
        },
      });
    }

    assert.deepEqual(
      approvals.list().map((approval) => approval.summary),
      commands.map((command) => `Command: ${command} | Project: Codex_iLink`),
    );
  } finally {
    approvals.close();
  }
});

test("approval requests that cannot be shown in full are declined", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) {
      sent.push(text);
    },
    now: () => 1_675,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  assert.equal(
    await approvals.ingest({
      id: 55,
      method: "item/commandExecution/requestApproval",
      params: {
        command: `echo ${"A".repeat(510)} && format C: /Q`,
        itemId: "item-too-long",
        threadId: "thread-too-long",
        turnId: "turn-too-long",
      },
    }),
    true,
  );

  assert.deepEqual(responses, [{ id: 55, result: { decision: "decline" } }]);
  assert.deepEqual(sent, []);
  assert.deepEqual(approvals.list(), []);
});

test("replayed approval events keep one request while distinct item ids stay separate", async () => {
  const sent: string[] = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) { sent.push(text); },
    now: () => 1_700,
    respond() {},
  });
  const event = {
    id: 54,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "shutdown /s /t 0",
      itemId: "item-a",
      threadId: "thread-a",
      turnId: "turn-a",
    },
  } as const;

  await approvals.ingest(event);
  await approvals.ingest(event);
  await approvals.ingest({
    ...event,
    id: 55,
    params: { ...event.params, itemId: "item-b" },
  });

  assert.equal(approvals.list().length, 2);
  assert.equal(sent.length, 2);
});

test("replayed live callbacks share one approval decision", async () => {
  const decisions: string[] = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_725,
    respond() {},
  });
  const request = {
    method: "item/commandExecution/requestApproval" as const,
    params: {
      command: "npm publish",
      itemId: "shared-item",
      threadId: "shared-thread",
      turnId: "shared-turn",
    },
  };

  await approvals.ingestCallback({
    ...request,
    isLive: () => true,
    respond: (approved) => { decisions.push(`first:${String(approved)}`); },
  });
  await approvals.ingestCallback({
    ...request,
    isLive: () => true,
    respond: (approved) => { decisions.push(`second:${String(approved)}`); },
  });

  assert.equal(approvals.list().length, 1);
  approvals.decide(null, true);
  assert.deepEqual(decisions, ["first:true", "second:true"]);
});

test("replayed request identities reject changed commands and permissions", async () => {
  const callbackDecisions: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_740,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  const identity = {
    itemId: "shared-item",
    threadId: "shared-thread",
    turnId: "shared-turn",
  };
  await approvals.ingestCallback({
    isLive: () => true,
    method: "item/commandExecution/requestApproval",
    params: { ...identity, command: "npm test" },
    respond: (approved) => {
      callbackDecisions.push(`first:${String(approved)}`);
    },
  });
  await approvals.ingestCallback({
    isLive: () => true,
    method: "item/commandExecution/requestApproval",
    params: { ...identity, command: "format C: /Q" },
    respond: (approved) => {
      callbackDecisions.push(`changed:${String(approved)}`);
    },
  });

  assert.deepEqual(callbackDecisions, ["changed:false"]);
  assert.equal(approvals.list().length, 1);
  approvals.decide(null, true);
  assert.deepEqual(callbackDecisions, ["changed:false", "first:true"]);

  const permissionIdentity = {
    itemId: "permission-item",
    threadId: "permission-thread",
    turnId: "permission-turn",
  };
  await approvals.ingest({
    id: 71,
    method: "item/permissions/requestApproval",
    params: {
      ...permissionIdentity,
      permissions: { network: { enabled: false } },
    },
  });
  await approvals.ingest({
    id: 72,
    method: "item/permissions/requestApproval",
    params: {
      ...permissionIdentity,
      permissions: { network: { enabled: true } },
    },
  });
  approvals.decide(null, true);

  assert.deepEqual(responses, [
    { id: 72, result: { permissions: {}, scope: "turn" } },
    {
      id: 71,
      result: {
        permissions: { network: { enabled: false } },
        scope: "turn",
      },
    },
  ]);
});

test("approvalId distinguishes subcommand callbacks and rejects changed replays", async () => {
  const sent: string[] = [];
  const decisions: string[] = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) { sent.push(text); },
    now: () => 1_745,
    respond() {},
  });
  const identity = {
    itemId: "parent-item",
    threadId: "subcommand-thread",
    turnId: "subcommand-turn",
  };
  const first = {
    approvalId: "approval-a",
    command: "npm test",
    ...identity,
  };

  await approvals.ingestCallback({
    isLive: () => true,
    method: "item/commandExecution/requestApproval",
    params: first,
    respond: (approved) => { decisions.push(`first:${String(approved)}`); },
  });
  await approvals.ingestCallback({
    isLive: () => true,
    method: "item/commandExecution/requestApproval",
    params: first,
    respond: (approved) => { decisions.push(`replay:${String(approved)}`); },
  });
  await approvals.ingestCallback({
    isLive: () => true,
    method: "item/commandExecution/requestApproval",
    params: { ...first, command: "format C: /Q" },
    respond: (approved) => { decisions.push(`changed:${String(approved)}`); },
  });
  await approvals.ingestCallback({
    isLive: () => true,
    method: "item/commandExecution/requestApproval",
    params: {
      ...identity,
      approvalId: "approval-b",
      command: "shutdown /s /t 0",
    },
    respond: (approved) => { decisions.push(`distinct:${String(approved)}`); },
  });

  assert.deepEqual(decisions, ["changed:false"]);
  assert.equal(sent.length, 2);
  const [firstApproval, secondApproval] = approvals.list();
  approvals.decide(firstApproval?.code ?? "", true);
  approvals.decide(secondApproval?.code ?? "", false);
  assert.deepEqual(decisions, [
    "changed:false",
    "first:true",
    "replay:true",
    "distinct:false",
  ]);
});

test("permission grants are explicit, strictly validated, and snapshotted", async () => {
  const sent: string[] = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text) { sent.push(text); },
    now: () => 1_748,
    respond(id, result) { responses.push({ id, result }); },
  });
  const permissions = {
    fileSystem: {
      entries: [
        {
          access: "write",
          path: {
            type: "special",
            value: { kind: "project_roots", subpath: null },
          },
        },
      ],
    },
    network: { enabled: true },
  };

  await approvals.ingest({
    id: 81,
    method: "item/permissions/requestApproval",
    params: {
      itemId: "permission-explicit",
      permissions,
      threadId: "permission-explicit-thread",
      turnId: "permission-explicit-turn",
    },
  });
  assert.match(sent[0] ?? "", /network access enabled/u);
  assert.match(sent[0] ?? "", /filesystem write: project roots/u);
  permissions.network.enabled = false;
  approvals.decide(null, true);

  for (const [id, invalidPermissions] of [
    [
      82,
      { network: { enabled: true, futureMode: "unreviewed" } },
    ],
    [
      83,
      {
        fileSystem: {
          entries: [
            {
              access: "write",
              path: { path: "C:\\Users\\alice\\private", type: "path" },
            },
          ],
        },
      },
    ],
    [84, {}],
  ] as const) {
    await approvals.ingest({
      id,
      method: "item/permissions/requestApproval",
      params: {
        itemId: `permission-invalid-${String(id)}`,
        permissions: invalidPermissions,
        threadId: "permission-invalid-thread",
        turnId: `permission-invalid-turn-${String(id)}`,
      },
    });
  }
  await approvals.ingest({
    id: 85,
    method: "item/commandExecution/requestApproval",
    params: {
      additionalPermissions: {
        fileSystem: { write: ["C:\\Users\\alice\\private"] },
      },
      command: "write report",
      itemId: "command-private-path",
      threadId: "command-private-thread",
      turnId: "command-private-turn",
    },
  });
  await approvals.ingest({
    id: 86,
    method: "item/fileChange/requestApproval",
    params: {
      grantRoot: "C:\\Users\\alice\\private",
      itemId: "file-session-grant",
      reason: "write report",
      threadId: "file-session-thread",
      turnId: "file-session-turn",
    },
  });
  await approvals.ingest({
    id: 87,
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "file-unverifiable-change",
      reason: "write report",
      threadId: "file-unverifiable-thread",
      turnId: "file-unverifiable-turn",
    },
  });
  for (const [id, fields] of [
    [88, { command: null, reason: "routine maintenance" }],
    [89, { command: "deploy", environmentId: "production" }],
    [
      90,
      {
        command: "curl service",
        networkApprovalContext: {
          host: "private.example",
          protocol: "https",
        },
      },
    ],
    [92, { command: "npm test", commandActions: [] }],
    [93, { command: "npm test", proposedExecpolicyAmendment: [] }],
    [94, { command: "npm test", proposedNetworkPolicyAmendments: [] }],
  ] as const) {
    await approvals.ingest({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        ...fields,
        itemId: `command-unverifiable-${String(id)}`,
        threadId: "command-unverifiable-thread",
        turnId: `command-unverifiable-turn-${String(id)}`,
      },
    });
  }
  await approvals.ingest({
    id: 91,
    method: "item/permissions/requestApproval",
    params: {
      environmentId: "production",
      itemId: "permission-environment",
      permissions: { network: { enabled: true } },
      threadId: "permission-environment-thread",
      turnId: "permission-environment-turn",
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(responses, [
    {
      id: 81,
      result: {
        permissions: {
          fileSystem: {
            entries: [
              {
                access: "write",
                path: {
                  type: "special",
                  value: { kind: "project_roots", subpath: null },
                },
              },
            ],
          },
          network: { enabled: true },
        },
        scope: "turn",
      },
    },
    ...[82, 83, 84].map((id) => ({
      id,
      result: { permissions: {}, scope: "turn" },
    })),
    { id: 85, result: { decision: "decline" } },
    { id: 86, result: { decision: "decline" } },
    { id: 87, result: { decision: "decline" } },
    ...[88, 89, 90, 92, 93, 94].map((id) => ({
      id,
      result: { decision: "decline" },
    })),
    { id: 91, result: { permissions: {}, scope: "turn" } },
  ]);
});

test("approval delivery ids include the full request identity", async () => {
  const clientIds: string[] = [];
  const approvals = new ApprovalCoordinator({
    async notify(_text, clientId) { clientIds.push(clientId); },
    now: () => 1_750,
    respond() {},
  });

  for (const [method, threadId] of [
    ["item/commandExecution/requestApproval", "thread-command"],
    ["item/fileChange/requestApproval", "thread-file"],
  ] as const) {
    await approvals.ingestCallback({
      isLive: () => true,
      method,
      params: {
        ...(method === "item/commandExecution/requestApproval"
          ? { command: "npm test" }
          : {
              command: "apply_patch: update src/report.ts",
              requestFingerprint: "a".repeat(64),
            }),
        itemId: "same-item",
        threadId,
        turnId: "same-turn",
      },
      respond() {},
    });
  }

  assert.equal(clientIds.length, 2);
  assert.notEqual(clientIds[0], clientIds[1]);
});

test("a completed approval code cannot decide a later request", async () => {
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 1_750,
    respond(id, result) {
      responses.push({ id, result });
    },
  });

  await approvals.ingest({
    id: 61,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "write old file",
      itemId: "item-old",
      threadId: "thread-old",
      turnId: "turn-old",
    },
  });
  const staleCode = approvals.list()[0]?.code ?? "";
  approvals.decide(null, true);
  await approvals.ingest({
    id: 62,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "write new file",
      itemId: "item-new",
      threadId: "thread-new",
      turnId: "turn-new",
    },
  });

  assert.deepEqual(approvals.decide(staleCode, true), {
    code: staleCode,
    kind: "not-found",
  });
  assert.equal(approvals.list().length, 1);
  assert.deepEqual(responses, [{ id: 61, result: { decision: "accept" } }]);
});

test("permissions are scoped to one turn and expiry denies stale callbacks", async () => {
  let now = 2_000;
  const expired: Array<{ code: string; reason: string }> = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => now,
    onExpired(approval, reason) {
      expired.push({ code: approval.code, reason });
    },
    respond(id, result) {
      responses.push({ id, result });
    },
    timeoutMs: 100,
  });

  await approvals.ingest({
    id: "permission-1",
    method: "item/permissions/requestApproval",
    params: {
      itemId: "item-2",
      permissions: { network: { enabled: true } },
      threadId: "thread-2",
      turnId: "turn-2",
    },
  });
  const code = approvals.list()[0]?.code ?? "";
  now = 2_101;
  assert.equal(approvals.expire(), 1);
  assert.deepEqual(responses, [
    {
      id: "permission-1",
      result: { permissions: {}, scope: "turn" },
    },
  ]);
  assert.deepEqual(expired, [{ code, reason: "timeout" }]);
  assert.deepEqual(approvals.list(), []);
});

test("notification failure keeps the live approval and retries with one client id", async () => {
  const attempts: Array<{ clientId: string; text: string }> = [];
  const retryDelays: number[] = [];
  const retryResolvers: Array<() => void> = [];
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text, clientId) {
      attempts.push({ clientId, text });
      if (attempts.length === 1) throw new Error("offline");
    },
    now: () => 3_000,
    respond(id, result) {
      responses.push({ id, result });
    },
    sleep(milliseconds) {
      retryDelays.push(milliseconds);
      return new Promise((resolve) => retryResolvers.push(resolve));
    },
  });

  await approvals.ingest({
    id: 43,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "write outside workspace",
      itemId: "item-3",
      threadId: "thread-3",
      turnId: "turn-3",
    },
  });
  assert.deepEqual(responses, []);
  assert.equal(approvals.list()[0]?.deliveryStatus, "retrying");
  assert.deepEqual(retryDelays, [1_000]);

  retryResolvers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.clientId, attempts[1]?.clientId);
  assert.equal(approvals.list()[0]?.deliveryStatus, "delivered");
  assert.deepEqual(responses, []);
});

test("an unanswered approval sends bounded reminders with distinct stable ids", async () => {
  const sent: Array<{ clientId: string; text: string }> = [];
  const reminderDelays: number[] = [];
  const reminderResolvers: Array<() => void> = [];
  const approvals = new ApprovalCoordinator({
    async notify(text, clientId) {
      sent.push({ clientId, text });
    },
    now: () => 3_250,
    reminderSleep(milliseconds) {
      reminderDelays.push(milliseconds);
      return new Promise((resolve) => reminderResolvers.push(resolve));
    },
    respond() {},
  });

  await approvals.ingest({
    id: 44,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "npm publish",
      itemId: "item-reminder",
      threadId: "thread-reminder",
      turnId: "turn-reminder",
    },
  });

  assert.deepEqual(reminderDelays, [60_000, 5 * 60_000]);
  reminderResolvers[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 2);
  assert.match(sent[1]?.text ?? "", /仍在等待审批[\s\S]*npm publish/u);
  assert.notEqual(sent[0]?.clientId, sent[1]?.clientId);
  assert.match(sent[1]?.clientId ?? "", /:reminder:1$/u);
  assert.equal(approvals.list()[0]?.reminderCount, 1);

  approvals.decide(null, false);
  reminderResolvers[1]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
});

test("a lost Codex callback cancels notification retries with an explicit reason", async () => {
  let live = true;
  const expired: string[] = [];
  const retryResolvers: Array<() => void> = [];
  const approvals = new ApprovalCoordinator({
    isLive: () => live,
    async notify() {
      throw new Error("offline");
    },
    now: () => 3_500,
    onExpired(_approval, reason) {
      expired.push(reason);
    },
    respond() {
      assert.fail("a lost callback cannot be answered");
    },
    sleep() {
      return new Promise((resolve) => retryResolvers.push(resolve));
    },
  });

  await approvals.ingest({
    id: 45,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "write project file",
      itemId: "item-lost",
      threadId: "thread-lost",
      turnId: "turn-lost",
    },
  });
  live = false;
  retryResolvers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(expired, ["request-lost"]);
  assert.deepEqual(approvals.list(), []);
});

test("closing the bridge declines every still-live request", async () => {
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const expired: string[] = [];
  const approvals = new ApprovalCoordinator({
    async notify() {},
    now: () => 4_000,
    onExpired(_approval, reason) {
      expired.push(reason);
    },
    respond(id, result) {
      responses.push({ id, result });
    },
  });
  await approvals.ingest({
    id: 44,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "write project file",
      itemId: "item-4",
      threadId: "thread-4",
      turnId: "turn-4",
    },
  });

  approvals.close();
  assert.deepEqual(responses, [{ id: 44, result: { decision: "decline" } }]);
  assert.deepEqual(expired, ["request-lost"]);
  assert.deepEqual(approvals.list(), []);
});
