export type AtomicControlIntent =
  | { code: string | null; kind: "approve" }
  | { code: string | null; kind: "deny" }
  | { kind: "clearSession" }
  | { kind: "compactSession" }
  | { kind: "enterSession"; index: number }
  | { kind: "exitSession" }
  | { kind: "efforts" }
  | { kind: "help" }
  | { kind: "models" }
  | { kind: "newSession" }
  | { kind: "permissions" }
  | { kind: "projects" }
  | { kind: "selectPermission"; index: number }
  | { effort: string; kind: "selectEffort" }
  | { index: number; kind: "selectEffort" }
  | { id: string; kind: "selectModel" }
  | { index: number; kind: "selectModel" }
  | { kind: "selectProject"; index: number }
  | { kind: "sessions"; page: "archived" | "first" | "next" }
  | { kind: "status" }
  | { kind: "stopTurn" };

export type ControlSequenceIntent = {
  intents: readonly AtomicControlIntent[];
  kind: "controlSequence";
};

export type InboundIntent =
  | AtomicControlIntent
  | ControlSequenceIntent
  | { kind: "message"; text: string }
  | { kind: "unknownCommand"; text: string };

export type RoutedControlIntent = AtomicControlIntent | ControlSequenceIntent;

export const COMMAND_HELP = [
  "p — projects",
  "p<n> — select project",
  "s | s+ | sarc — sessions",
  "s<n> — enter session",
  "new — new session",
  "clear — clear context in a new session",
  "compact — compact current context",
  "stop — stop current turn",
  "exit — return to main",
  "st — status",
  "perm | perm<n> — permissions",
  "model | model<n> | model:<id> — model",
  "effort | effort<n> | effort:<level> — reasoning effort",
  "ok[code] | no[code] — approval",
  "help — commands",
  "也可直接说：查看项目、打开第2个任务、返回主会话",
].join("\n");

export function parseInboundText(text: string): InboundIntent {
  const command = text.trim();

  switch (command) {
    case "p":
      return { kind: "projects" };
    case "s":
      return { kind: "sessions", page: "first" };
    case "s+":
      return { kind: "sessions", page: "next" };
    case "sarc":
      return { kind: "sessions", page: "archived" };
    case "new":
      return { kind: "newSession" };
    case "clear":
      return { kind: "clearSession" };
    case "compact":
      return { kind: "compactSession" };
    case "stop":
      return { kind: "stopTurn" };
    case "exit":
      return { kind: "exitSession" };
    case "st":
      return { kind: "status" };
    case "perm":
      return { kind: "permissions" };
    case "model":
      return { kind: "models" };
    case "effort":
      return { kind: "efforts" };
    case "help":
      return { kind: "help" };
  }

  const direct = /^(model|effort):([a-z\d][a-z\d._-]*)$/u.exec(command);
  if (direct) {
    return direct[1] === "model"
      ? { id: direct[2] as string, kind: "selectModel" }
      : { effort: direct[2] as string, kind: "selectEffort" };
  }

  const approval = /^(ok|no)([a-f][a-f\d]{5})?$/iu.exec(command);
  if (approval) {
    return {
      code: approval[2]?.toUpperCase() ?? null,
      kind: approval[1]?.toLowerCase() === "ok" ? "approve" : "deny",
    };
  }

  const indexed = /^(p|s|perm|model|effort)([1-9]\d*)$/u.exec(command);
  if (indexed) {
    const index = Number(indexed[2]);
    if (!Number.isSafeInteger(index)) return { kind: "unknownCommand", text };

    switch (indexed[1]) {
      case "p":
        return { index, kind: "selectProject" };
      case "s":
        return { index, kind: "enterSession" };
      case "perm":
        return { index, kind: "selectPermission" };
      case "model":
        return { index, kind: "selectModel" };
      case "effort":
        return { index, kind: "selectEffort" };
      default:
        return { kind: "unknownCommand", text };
    }
  }

  const sequence = parseNaturalControlSequence(command);
  if (sequence) return sequence;
  const natural = parseNaturalControl(command);
  if (natural) return natural;
  return isReservedCommandShape(command)
    ? { kind: "unknownCommand", text }
    : { kind: "message", text };
}

export function looksLikeControlRequest(text: string): boolean {
  const normalized = normalizeNaturalControl(text);
  return (
    /(?:项目|任务|会话|上下文|回合|状态|权限|模型|推理强度|推理级别|审批|命令|帮助)/u.test(
      normalized,
    ) &&
    /(?:查看|显示|列出|切换|选择|进入|打开|返回|回到|退出|新建|创建|清空|清除|重置|压缩|停止|中止|终止|批准|同意|拒绝|否决|下一页|归档|帮助)/u.test(
      normalized,
    )
  );
}

export function routedControlIntent(value: unknown): RoutedControlIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  const index =
    typeof input.index === "number" &&
    Number.isSafeInteger(input.index) &&
    input.index > 0
      ? input.index
      : null;
  const code =
    typeof input.code === "string" && /^[a-f][a-f\d]{5}$/iu.test(input.code)
      ? input.code.toUpperCase()
      : null;

  if (kind === "controlSequence") {
    if (
      !Array.isArray(input.intents) ||
      input.intents.length < 2 ||
      input.intents.length > 4
    ) {
      return null;
    }
    const intents: AtomicControlIntent[] = [];
    for (const value of input.intents) {
      const intent = routedControlIntent(value);
      if (!intent || intent.kind === "controlSequence") return null;
      intents.push(intent);
    }
    return {
      intents,
      kind: "controlSequence",
    };
  }

  switch (kind) {
    case "approve":
    case "deny":
      if (input.code !== undefined && code === null) return null;
      return { code, kind };
    case "clearSession":
    case "compactSession":
    case "efforts":
    case "exitSession":
    case "help":
    case "models":
    case "newSession":
    case "permissions":
    case "projects":
    case "status":
    case "stopTurn":
      return { kind };
    case "enterSession":
    case "selectPermission":
    case "selectProject":
      return index === null ? null : { index, kind };
    case "selectModel":
      if (index !== null) return { index, kind };
      return typeof input.id === "string" && /^[a-z\d][a-z\d._-]*$/iu.test(input.id)
        ? { id: input.id.toLowerCase(), kind }
        : null;
    case "selectEffort":
      if (index !== null) return { index, kind };
      return typeof input.effort === "string" &&
        /^(?:low|medium|high|xhigh|max|ultra)$/iu.test(input.effort)
        ? { effort: input.effort.toLowerCase(), kind }
        : null;
    case "sessions":
      return input.page === "archived" ||
        input.page === "first" ||
        input.page === "next"
        ? { kind, page: input.page }
        : null;
    default:
      return null;
  }
}

const NATURAL_INDEX = "([1-9]\\d*|[零一二两三四五六七八九十百千]+)";

function parseNaturalControlSequence(
  command: string,
): ControlSequenceIntent | null {
  const parts = command.split(/\s*(?:，|,)?\s*(?:然后|接着|随后|再)\s*/u);
  if (parts.length < 2 || parts.length > 4) return null;
  const intents: AtomicControlIntent[] = [];
  for (const part of parts) {
    const intent = parseNaturalControl(part);
    if (!intent) return null;
    intents.push(intent);
  }
  return {
    intents,
    kind: "controlSequence",
  };
}

function parseNaturalControl(command: string): AtomicControlIntent | null {
  const normalized = normalizeNaturalControl(command);
  if (!normalized) return null;

  if (/^(?:帮助|查看帮助|命令列表|查看命令|有哪些命令)$/u.test(normalized)) {
    return { kind: "help" };
  }
  if (/^(?:查看|显示|列出)?(?:全部)?项目(?:列表|清单)?$|^有哪些项目$/u.test(normalized)) {
    return { kind: "projects" };
  }
  const project = new RegExp(
    `^(?:切换|进入|选择|打开)(?:到|至)?第?${NATURAL_INDEX}个?项目$`,
    "u",
  ).exec(normalized);
  if (project) return indexedNaturalIntent(project[1], "selectProject");

  if (/^(?:下一页|下页)(?:任务|会话)$|^(?:任务|会话)(?:下一页|下页)$/u.test(normalized)) {
    return { kind: "sessions", page: "next" };
  }
  if (/^(?:查看|显示|列出)?(?:已)?归档(?:的)?(?:任务|会话)(?:列表)?$|^(?:任务|会话)归档列表$/u.test(normalized)) {
    return { kind: "sessions", page: "archived" };
  }
  if (/^(?:查看|显示|列出)?(?:最近|当前)?(?:任务|会话)(?:列表|清单)?$|^(?:最近任务|最近会话|有哪些任务|有哪些会话)$/u.test(normalized)) {
    return { kind: "sessions", page: "first" };
  }
  const session = new RegExp(
    `^(?:切换|进入|选择|打开|回到|继续)(?:到|至)?第?${NATURAL_INDEX}个?(?:任务|会话)$`,
    "u",
  ).exec(normalized);
  if (session) return indexedNaturalIntent(session[1], "enterSession");
  const sessionSuffix = new RegExp(
    `^(?:切换|进入|选择|打开|回到|继续)(?:到|至)?(?:会话任务|任务会话|任务|会话)(?:编号)?第?${NATURAL_INDEX}$`,
    "u",
  ).exec(normalized);
  if (sessionSuffix) {
    return indexedNaturalIntent(sessionSuffix[1], "enterSession");
  }

  if (/^(?:新建|创建)(?:一个|新的?)?(?:任务|会话)$|^开一个新(?:任务|会话)$/u.test(normalized)) {
    return { kind: "newSession" };
  }
  if (/^(?:清空|清除|重置)(?:当前)?(?:任务|会话)?上下文$|^新建空白(?:任务|会话)$/u.test(normalized)) {
    return { kind: "clearSession" };
  }
  if (/^(?:压缩|整理)(?:当前)?(?:任务|会话)?上下文$/u.test(normalized)) {
    return { kind: "compactSession" };
  }
  if (/^(?:停止|中止|终止)(?:当前)?(?:微信|codex)(?:任务|回合)$/iu.test(normalized)) {
    return { kind: "stopTurn" };
  }
  if (
    /^(?:返回|回到|退出到)(?:微信)?主(?:任务|会话)(?:主(?:任务|会话))?$|^退出当前(?:任务|会话)$/u.test(
      normalized,
    )
  ) {
    return { kind: "exitSession" };
  }
  if (
    /^(?:查看|显示|看(?:一下)?)(?:当前)?(?:任务|会话|连接)?状态$|^(?:把|将)?(?:当前)?状态(?:查看|显示|看)$|^当前状态$/u.test(
      normalized,
    )
  ) {
    return { kind: "status" };
  }

  if (/^(?:查看|显示|列出)?(?:当前)?权限(?:列表|清单)?$|^有哪些权限$/u.test(normalized)) {
    return { kind: "permissions" };
  }
  const permission = new RegExp(
    `^(?:切换|选择|使用)(?:到|为)?第?${NATURAL_INDEX}个?权限(?:配置)?$`,
    "u",
  ).exec(normalized);
  if (permission) return indexedNaturalIntent(permission[1], "selectPermission");

  if (/^(?:查看|显示|列出)?(?:可用)?模型(?:列表|清单)?$|^有哪些模型$/u.test(normalized)) {
    return { kind: "models" };
  }
  const modelIndex = new RegExp(
    `^(?:切换|选择|使用)(?:到|为)?第?${NATURAL_INDEX}个?模型$`,
    "u",
  ).exec(normalized);
  if (modelIndex) return indexedNaturalIntent(modelIndex[1], "selectModel");
  const model = /^(?:把|将)?(?:当前任务)?模型(?:切换|换|改|设)(?:为|成|到)?\s*([a-z\d][a-z\d._-]*)$/iu.exec(normalized);
  if (model) return { id: model[1]!.toLowerCase(), kind: "selectModel" };

  if (/^(?:查看|显示|列出)?(?:可用)?(?:推理强度|推理级别|effort)(?:列表|清单)?$|^有哪些(?:推理强度|推理级别)$/iu.test(normalized)) {
    return { kind: "efforts" };
  }
  const effortIndex = new RegExp(
    `^(?:切换|选择|使用)(?:到|为)?第?${NATURAL_INDEX}个?(?:推理强度|推理级别)$`,
    "u",
  ).exec(normalized);
  if (effortIndex) return indexedNaturalIntent(effortIndex[1], "selectEffort");
  const effort = /^(?:把|将)?(?:当前任务)?(?:推理强度|推理级别|effort)(?:切换|调|改|设)(?:为|成|到)?\s*(low|medium|high|xhigh|max|ultra)$/iu.exec(normalized);
  if (effort) {
    return { effort: effort[1]!.toLowerCase(), kind: "selectEffort" };
  }

  const approval = /^(批准|同意|拒绝|否决)(?:当前)?审批(?:码)?\s*([a-f][a-f\d]{5})?$/iu.exec(normalized);
  if (approval) {
    return {
      code: approval[2]?.toUpperCase() ?? null,
      kind: /^(批准|同意)$/u.test(approval[1]!) ? "approve" : "deny",
    };
  }
  return null;
}

function normalizeNaturalControl(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .replace(/^(?:请你?|帮我|麻烦你?)\s*/u, "")
    .replace(/(?:一下吧?|看看|吧)[。！!？?]*$/u, "")
    .replace(/[。！!？?]+$/u, "")
    .replace(/\s+/gu, "")
    .trim();
}

function indexedNaturalIntent(
  value: string | undefined,
  kind:
    | "enterSession"
    | "selectEffort"
    | "selectModel"
    | "selectPermission"
    | "selectProject",
): AtomicControlIntent | null {
  const index = naturalNumber(value);
  if (index === null) return null;
  switch (kind) {
    case "enterSession":
      return { index, kind: "enterSession" };
    case "selectEffort":
      return { index, kind: "selectEffort" };
    case "selectModel":
      return { index, kind: "selectModel" };
    case "selectPermission":
      return { index, kind: "selectPermission" };
    case "selectProject":
      return { index, kind: "selectProject" };
  }
}

function naturalNumber(value: string | undefined): number | null {
  if (!value) return null;
  if (/^[1-9]\d*$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  let total = 0;
  let digit = 0;
  for (const character of value) {
    if (character in digits) {
      digit = digits[character]!;
      continue;
    }
    const unit = units[character];
    if (!unit) return null;
    total += (digit || 1) * unit;
    digit = 0;
  }
  const result = total + digit;
  return result > 0 && Number.isSafeInteger(result) ? result : null;
}

function isReservedCommandShape(command: string): boolean {
  return (
    command.startsWith("/") ||
    /^go(?:$|\s*\d+$)/iu.test(command) ||
    /^perm(?:\s|[+\-.\d])/iu.test(command) ||
    /^model(?::|[+\-.\d])/iu.test(command) ||
    /^model\s+\S*[\d._-]\S*$/iu.test(command) ||
    /^effort(?::|[+\-.\d])/iu.test(command) ||
    /^effort\s+(?:low|medium|high|xhigh|max|ultra)$/iu.test(command) ||
    /^(?:p|s)(?:\s|[+\-.\d])/u.test(command) ||
    /^(?:ok|no)(?:\s|[a-f\d]+$)/iu.test(command)
  );
}
