import readline from "node:readline";

const inheritedDesktopVariables = [
  "CODEX_API_KEY",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_THREAD_ID",
  "OPENAI_API_KEY",
].filter((name) => process.env[name]);

if (inheritedDesktopVariables.length > 0) {
  process.stderr.write(
    `sensitive parent variables were not sanitized: ${inheritedDesktopVariables.join(",")}\n`,
  );
  process.exit(23);
}

const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (process.argv.includes("--emit-null")) {
      process.stdout.write("null\n");
      return;
    }

    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        method: "item/tool/requestUserInput",
        params: { questions: [] },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { userAgent: "fake" } })}\n`,
    );
    return;
  }

  if (message.method === "initialized") {
    return;
  }

  if (message.method === "thread/resume") {
    const keys = Object.keys(message.params).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["threadId"])) {
      process.stdout.write(
        `${JSON.stringify({
          id: message.id,
          error: { code: -32602, message: `unexpected overrides: ${keys.join(",")}` },
        })}\n`,
      );
      return;
    }

    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          thread: { id: message.params.threadId },
          model: "gpt-fixture",
          modelProvider: "fixture-provider",
          cwd: "D:\\Fixture",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: {
            type: "workspaceWrite",
            networkAccess: false,
            writableRoots: [],
          },
          reasoningEffort: "high",
        },
      })}\n`,
    );
    return;
  }

  if (message.method === "thread/read") {
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            status: { type: "idle" },
          },
        },
      })}\n`,
    );
  }
});
