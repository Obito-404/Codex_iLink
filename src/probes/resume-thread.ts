import { AppServerClient } from "./app-server-client.ts";

type JsonObject = Record<string, unknown>;

function readThreadId(args: readonly string[]): string {
  const index = args.indexOf("--thread");
  const threadId = index >= 0 ? args[index + 1] : undefined;
  if (!threadId) {
    throw new Error("Usage: pnpm probe:resume -- --thread <thread_id>");
  }
  return threadId;
}

function readAppServerCommand(): [string, ...string[]] {
  const configured = process.env.CODEX_ILINK_APP_SERVER_COMMAND;
  if (!configured) {
    return process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", "codex app-server"]
      : ["codex", "app-server"];
  }

  const parsed = JSON.parse(configured) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("CODEX_ILINK_APP_SERVER_COMMAND must be a JSON string array");
  }

  return parsed as [string, ...string[]];
}

function requiredField(result: JsonObject, name: string): unknown {
  const value = result[name];
  if (value === undefined || value === null) {
    throw new Error(`thread/resume did not return ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const threadId = readThreadId(process.argv.slice(2));
  const client = new AppServerClient(readAppServerCommand());

  try {
    await client.initialize();

    // Deliberately send only threadId. Every other resume field is an override.
    const resumed = await client.request("thread/resume", { threadId });
    const read = await client.request("thread/read", {
      includeTurns: false,
      threadId,
    });
    const thread = requiredField(read, "thread") as JsonObject;

    const report = {
      ok: true,
      threadId,
      inherited: {
        model: requiredField(resumed, "model"),
        modelProvider: requiredField(resumed, "modelProvider"),
        cwd: requiredField(resumed, "cwd"),
        approvalPolicy: requiredField(resumed, "approvalPolicy"),
        approvalsReviewer: requiredField(resumed, "approvalsReviewer"),
        sandbox: requiredField(resumed, "sandbox"),
        reasoningEffort: requiredField(resumed, "reasoningEffort"),
      },
      status: requiredField(thread, "status"),
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
