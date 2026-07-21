import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SPOOL_BYTES = 5 * 1024 * 1024;
const MAX_SPOOL_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_APPROVAL_SUMMARY_CODE_POINTS = 500;
const MAX_PATCH_OPERATIONS = 8;
const COMMAND_TOOLS = new Map([
  ["bash", "Bash"],
  ["cmd", "Command Prompt"],
  ["exec_command", "Command"],
  ["powershell", "PowerShell"],
  ["shell", "Shell"],
  ["shell_command", "Shell"],
  ["unified_exec", "Command"],
]);
const PERMISSION_REQUEST_ENVELOPE_KEYS = [
  "agent_id",
  "agent_type",
  "cwd",
  "hook_event_name",
  "model",
  "permission_mode",
  "request_id",
  "session_id",
  "source",
  "tool_call_id",
  "tool_input",
  "tool_name",
  "tool_use_id",
  "transcript_path",
  "turn_id",
];

export function createHookEvent(input, capturedAtMs = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const eventName = nullableString(input.hook_event_name);
  const sessionId = nullableString(input.session_id);
  if (!eventName || !sessionId) return null;
  return {
    capturedAtMs,
    cwd: nullableString(input.cwd),
    eventName,
    model: nullableString(input.model),
    permissionMode: nullableString(input.permission_mode),
    ...(eventName === "PermissionRequest"
      ? {
          requestId:
            nullableString(input.request_id) ??
            nullableString(input.tool_use_id) ??
            nullableString(input.tool_call_id),
          requestFingerprint: permissionFingerprint(input),
          requestSummary: permissionSummary(input),
        }
      : {}),
    schemaVersion: 1,
    sessionId,
    source: nullableString(input.source),
    toolName: nullableString(input.tool_name),
    turnId: nullableString(input.turn_id),
  };
}

function permissionFingerprint(input) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function permissionSummary(input) {
  if (!hasOnlyKeys(input, PERMISSION_REQUEST_ENVELOPE_KEYS)) return null;
  const projectName = windowsProjectName(input.cwd);
  if (!projectName) return null;
  const toolInput =
    input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
      ? input.tool_input
      : null;
  if (!toolInput) return null;
  const toolName = nullableString(input.tool_name)?.toLowerCase() ?? "";
  if (COMMAND_TOOLS.has(toolName)) {
    if (!hasOnlyKeys(toolInput, ["command"])) return null;
    const command = toolInput.command;
    const value =
      typeof command === "string" && command
        ? command
        : null;
    if (
      value &&
      containsNonDisplayableCommand(value)
    ) {
      return null;
    }
    return value
      ? boundedSummary(
          `${COMMAND_TOOLS.get(toolName)}: ${value} | Project: ${projectName}`,
        )
      : null;
  }
  if (toolName === "apply_patch") {
    if (!hasOnlyKeys(toolInput, ["patch"])) return null;
    const summary =
      typeof toolInput.patch === "string"
        ? patchSummary(toolInput.patch)
        : null;
    return summary
      ? boundedSummary(`${summary} | Project: ${projectName}`)
      : null;
  }
  return null;
}

function windowsProjectName(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^[A-Za-z]:[\\/]/u.test(value)
  ) {
    return null;
  }
  const segments = value.slice(3).split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment !== segment.trim() ||
        segment === "." ||
        segment === ".." ||
        /[ .]$/u.test(segment) ||
        /[<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(segment) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(
          segment,
        ),
    )
  ) {
    return null;
  }
  return segments.at(-1) ?? null;
}

function patchSummary(patch) {
  const lines = patch.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    return null;
  }
  const operations = [];
  let currentUpdate = null;
  for (const line of lines.slice(1, -1)) {
    const operation = /^\*\*\* (Add|Delete|Update) File:\s*(.+)$/u.exec(line);
    if (operation) {
      const action = operation[1];
      const path = patchPath(operation[2]);
      if (!path) return null;
      currentUpdate = action === "Update" ? { action, path } : null;
      operations.push(currentUpdate ?? { action, path });
      if (operations.length > MAX_PATCH_OPERATIONS) return null;
      continue;
    }
    const move = /^\*\*\* Move to:\s*(.+)$/u.exec(line);
    if (move) {
      if (!currentUpdate || "destination" in currentUpdate) return null;
      const destination = patchPath(move[1]);
      if (!destination) return null;
      currentUpdate.destination = destination;
      continue;
    }
    if (line === "*** End of File") continue;
    if (line.startsWith("*** ")) return null;
  }
  if (operations.length === 0) return null;
  const details = operations.map((operation) => {
    const source = JSON.stringify(operation.path);
    if (operation.action === "Add") return `add ${source}`;
    if (operation.action === "Delete") return `delete ${source}`;
    if (operation.destination) {
      return `move ${source} -> ${JSON.stringify(operation.destination)}`;
    }
    return `update ${source}`;
  });
  return boundedSummary(`apply_patch: ${details.join(", ")}`);
}

function patchPath(value) {
  if (
    !value ||
    value !== value.trim() ||
    /^[A-Za-z]:[\\/]|^[\\/]/u.test(value) ||
    /[\\:]|\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    hasMoreThanCodePoints(value, MAX_APPROVAL_SUMMARY_CODE_POINTS)
  ) {
    return null;
  }
  return value;
}

function hasOnlyKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function boundedSummary(value) {
  if (
    hasMoreThanCodePoints(value, MAX_APPROVAL_SUMMARY_CODE_POINTS) ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    containsNonDisplayableCredential(value) ||
    redactionCouldHideExecution(value)
  ) {
    return null;
  }
  const sanitized = sanitizeSummary(value);
  return sanitized === value &&
    !hasMoreThanCodePoints(sanitized, MAX_APPROVAL_SUMMARY_CODE_POINTS)
      ? sanitized
      : null;
}

function sanitizeSummary(value) {
  return value
    .replace(/\p{Cc}/gu, " ")
      .replace(/\p{Cf}/gu, "")
      .replace(
        /(\b(?:(?:proxy-)?authorization|x-auth(?:entication)?(?:-[a-z0-9-]+)?|x-api-key)\s*[:=]\s*)[^\s&|,'";}<>]+/giu,
        "$1[REDACTED]",
      )
      .replace(
        /((?:--)?[A-Z0-9_-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|KEY|COOKIE|SESSION)["']?\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s&|,'";}<>]+)/giu,
        "$1[REDACTED]",
      )
      .replace(
        /(\b(?:set-cookie|cookie)\s*:\s*)[^\s&|;<>"']+/giu,
        "$1[REDACTED]",
      )
      .replace(
        /(^|\s)(--cookie(?:-jar)?(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s&|,'";}<>]+)/gimu,
        "$1$2[REDACTED]",
      )
      .replace(
        /(^|\s)((?:-u|--user|-b)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s&|,'";}<>]+)/gimu,
        "$1$2[REDACTED]",
      )
      .replace(
        /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gu,
        "$1[REDACTED]@",
      )
      .replace(
        /(?:回复|答复)\s*[:：]?\s*(?:y|n)(?:\s*(?:或|\/)\s*(?:y|n))?/giu,
        "[REDACTED]",
      )
      .replace(/\breply\s*[:：]?\s*(?:y|n)\b/giu, "[REDACTED]")
      .replace(/【(?:请求内容|系统操作)】/gu, "[REDACTED]");
}

function containsNonDisplayableCredential(value) {
  return (
    /\b(?:(?:proxy-)?authorization|x-auth(?:entication)?(?:-[a-z0-9-]+)?|x-api-key)\s*[:=]/iu.test(
      value,
    ) ||
    /(?:^|\s)--proxy-user(?:=|\s+)/u.test(value) ||
    executableUsesArgument(
      value,
      "docker",
      /\blogin\b[^\r\n]*(?:^|\s)(?:-p(?:=|\s|(?=\S)|$)|--password(?:-stdin)?(?:=|\s|$))/mu,
    ) ||
    executableUsesArgument(
      value,
      "mysql(?:admin|check|dump|import|pump|show|slap)?|mariadb(?:-(?:admin|check|dump|import|show))?",
      /(?:^|\s)(?:-p(?:=|\s|(?=\S)|$)|--password(?:=|\s|$))/mu,
    ) ||
    executableUsesArgument(value, "sshpass", /(?:^|\s)-p(?:=|\s|(?=\S)|$)/mu) ||
    executableUsesArgument(
      value,
      "redis-cli",
      /(?:^|\s)(?:-a|--pass)(?:=|\s|(?=\S)|$)/mu,
    ) ||
    executableUsesArgument(value, "sqlcmd|bcp", /(?:^|\s)-P(?:=|\s|(?=\S)|$)/mu) ||
    executableUsesArgument(value, "gpg2?", /(?:^|\s)--passphrase(?:=|\s|$)/mu) ||
    executableUsesArgument(value, "7z(?:a|r)?|rar|unrar", /(?:^|\s)-[pP](?:=|\s|(?=\S)|$)/mu) ||
    executableUsesArgument(value, "zip|unzip", /(?:^|\s)-P(?:=|\s|(?=\S)|$)/mu) ||
    executableUsesArgument(value, "plink|pscp|psftp|putty", /(?:^|\s)-[pP][wW](?:=|\s|(?=\S)|$)/mu) ||
    executableUsesArgument(value, "ldapsearch", /(?:^|\s)-w(?:=|\s|(?=\S)|$)/mu) ||
    executableUsesArgument(
      value,
      "sqlplus|rman|expdp|impdp|sqlldr",
      /(?:^|\s)(?:"[^"\r\n\s/]+\/[^"\r\n\s]+"|'[^'\r\n\s/]+\/[^'\r\n\s]+'|[^\s"'&|;<>/]+\/[^\s"'&|;<>]+)/mu,
    )
  );
}

function executableUsesArgument(value, executablePattern, argumentPattern) {
  const executable = new RegExp(
    `\\b(?:${executablePattern})(?:\\.exe)?\\b`,
    "giu",
  );
  for (const match of value.matchAll(executable)) {
    const start = (match.index ?? 0) + match[0].length;
    argumentPattern.lastIndex = 0;
    if (argumentPattern.test(value.slice(start))) return true;
  }
  return false;
}

function containsCredentialContext(value) {
  return (
    containsNonDisplayableCredential(value) ||
    /(?:^|[^A-Z0-9])(?:AUTH(?:ENTICATION|ORIZATION)?|OAUTH\d*|BEARER|CREDENTIALS?|LOGIN|PASSWORD|PASSWD|PASSPHRASE|PASS|SECRET|TOKEN|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|COOKIE|SESSION|CERT(?:IFICATE)?|NETRC)(?:[^A-Z0-9]|$)/iu.test(
      value,
    ) ||
    /(?:^|[^A-Z0-9])(?:[A-Z0-9_-]*(?:PWD|PASS|AUTH|CREDENTIALS?))\s*(?:=|:)/iu.test(
      value,
    )
  );
}

function containsNonDisplayableLocalPath(value) {
  if (/^\s*shutdown(?:\.exe)?\s+\/(?:s|r|l|h)(?:\s+\/f)?(?:\s+\/t\s+\d+)?\s*$/iu.test(value)) {
    return false;
  }
  return (
    /(?<![\p{L}\p{N}_])[A-Za-z]:[\\/]/u.test(value) ||
    /(?:^|[\s"'=([{,;:])\\\\/u.test(value) ||
    /(?:^|[\s"'=([{,;:])\\(?!\\)[^\s"'<>|:]*/u.test(value) ||
    /(?:^|[\s"'=([{,;])\/(?!\/)[^\s"'<>|:]*/u.test(value) ||
    /\bfile:\/{3}/iu.test(value) ||
    /\b(?:HKLM|HKCU|HKCR|HKU|CERT|REGISTRY):[\\/]/iu.test(value)
  );
}

function redactionCouldHideExecution(value) {
  if (!containsPotentialSecret(value)) return false;
  return /\$\(|`|[&|;<>^()]|%[^%]+%|![^!]+!/u.test(value);
}

function containsNonDisplayableCommand(value) {
  // The Hook payload does not identify the shell. Dynamic evaluation is
  // therefore unverifiable, while lexical escape variants are checked as
  // additional candidates and fall back to the native client on any match.
  if (containsUnverifiableShellExpansion(value)) return true;
  return shellDetectionCandidates(value).some(
    (candidate) =>
      containsCredentialContext(candidate) ||
      containsNonDisplayableLocalPath(candidate),
  );
}

function containsUnverifiableShellExpansion(value) {
  return (
    /[$`]|%[A-Za-z_][A-Za-z0-9_]*(?::[^%\r\n]*)?%|![A-Za-z_][A-Za-z0-9_]*(?::[^!\r\n]*)?!/u.test(
      value,
    ) ||
    /(?:^|[\s"'=([{,;])~(?=$|[\\/])/u.test(value) ||
    /(?:^|[;&|])\s*[.&]\s*\(/u.test(value) ||
    /(?:^|[\s;&|])[^\s"'{}]*\{[^{}\s"',]*,[^{}\s"',]*\}[^\s"'{}]*(?=\s|$)/u.test(
      value,
    ) ||
    /\b(?:iex|invoke-expression|start-process)\b/iu.test(value) ||
    /\b(?:system|exec|spawn|popen)\s*\(/iu.test(value) ||
    /(?:^|[\s;&|])(?:bash|bun|cmd|deno|fish|lua|luajit|node|perl|php|powershell|pwsh|py|python(?:\d+(?:\.\d+)*)?|ruby|rscript|sh|zsh)(?:\.exe)?\b[^\r\n]*(?:\s-(?:c|e|command|encodedcommand)\b|\s--(?:eval|execute)\b|\s\/[ck]\b)/iu.test(
      value,
    )
  );
}

function shellDetectionCandidates(value) {
  const candidates = [value];
  const withoutCaretEscapes = value.replace(/\^/gu, "");
  candidates.push(withoutCaretEscapes);
  const withoutLiteralConcatenation = withoutCaretEscapes.replace(
    /["']\s*\+\s*["']/gu,
    "",
  );
  candidates.push(withoutLiteralConcatenation);
  const withoutQuotes = withoutLiteralConcatenation.replace(/["']/gu, "");
  candidates.push(withoutQuotes);
  candidates.push(
    withoutQuotes.replace(
      /(?<=[\p{L}\p{N}_-])\\(?=[\p{L}\p{N}_-])/gu,
      "",
    ),
  );
  return [...new Set(candidates)];
}

function containsPotentialSecret(value) {
  return (
    /\b(?:(?:proxy-)?authorization|x-auth(?:entication)?(?:-[a-z0-9-]+)?|x-api-key)\s*[:=]/iu.test(
      value,
    ) ||
    /(?:--)?[A-Z0-9_-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|KEY|COOKIE|SESSION)["']?\s*(?:=|:|\s)/iu.test(
      value,
    ) ||
    /\b(?:set-cookie|cookie)\s*:/iu.test(value) ||
    /(^|\s)--cookie(?:-jar)?(?:=|\s+)/imu.test(value) ||
    /(^|\s)(?:-u|--user|-b)(?:=|\s+)/imu.test(value) ||
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value)
  );
}

function hasMoreThanCodePoints(value, limit) {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

export function resolveSpoolDirectory() {
  return (
    process.env.CODEX_ILINK_SPOOL_DIR ??
    join(process.env.LOCALAPPDATA ?? homedir(), "Codex_iLink", "spool")
  );
}

export function spoolHookEvent(input) {
  const event = createHookEvent(input);
  if (!event) return false;
  spoolPayload(resolveSpoolDirectory(), `${JSON.stringify(event)}\n`);
  return true;
}

export function spoolPayload(directory, payload) {
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  let totalBytes = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
    const path = join(directory, name);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs > MAX_SPOOL_AGE_MS) {
        unlinkSync(path);
        continue;
      }
      totalBytes += stat.size;
    } catch {
      // A concurrent drain may have removed the file.
    }
  }
  if (totalBytes + Buffer.byteLength(payload, "utf8") > MAX_SPOOL_BYTES) return;

  const stem = `${now}-${randomUUID()}`;
  const temporaryPath = join(directory, `${stem}.tmp`);
  const finalPath = join(directory, `${stem}.json`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, payload, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  renameSync(temporaryPath, finalPath);
}

function nullableString(value) {
  return typeof value === "string" ? value : null;
}
