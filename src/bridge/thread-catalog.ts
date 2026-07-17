import { win32 } from "node:path";

export type ProjectCatalogEntry = {
  cwd: string;
  threadCount: number;
  updatedAt: number;
};

export type ThreadCatalogEntry = {
  archived: boolean;
  cwd: string | null;
  id: string;
  status: string | null;
  title: string | null;
  updatedAt: number;
};

export type ThreadCatalogPage = {
  archived: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  items: ThreadCatalogEntry[];
  page: number;
  pageSize: 10;
  total: number;
};

export type ThreadPreview = {
  finalAgentText: string | null;
  id: string;
  latestUserText: string | null;
  model: string | null;
  permissionMode: string | null;
  status: string | null;
  title: string | null;
};

type ProjectAccumulator = ProjectCatalogEntry & {
  key: string;
};

export function discoverProjects(
  rawThreadLists: readonly unknown[],
  options: { inboxCwd: string; mainThreadId?: string | null },
): ProjectCatalogEntry[] {
  const inboxKey = pathKey(options.inboxCwd);
  const projects = new Map<string, ProjectAccumulator>();

  for (const rawList of rawThreadLists) {
    for (const thread of threadData(rawList)) {
      if (stringField(thread, "id") === options.mainThreadId) {
        continue;
      }

      const cwd = stringField(thread, "cwd");
      if (cwd === null) {
        continue;
      }

      const normalizedCwd = normalizeWindowsPath(cwd);
      const key = pathKey(normalizedCwd);
      if (key === inboxKey) {
        continue;
      }

      const updatedAt = numberField(thread, "updatedAt") ?? 0;
      const existing = projects.get(key);
      if (existing === undefined) {
        projects.set(key, {
          cwd: normalizedCwd,
          key,
          threadCount: 1,
          updatedAt,
        });
        continue;
      }

      existing.threadCount += 1;
      if (updatedAt > existing.updatedAt) {
        existing.cwd = normalizedCwd;
        existing.updatedAt = updatedAt;
      }
    }
  }

  return [...projects.values()]
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.key.localeCompare(right.key),
    )
    .map(({ key: _key, ...project }) => project);
}

export function paginateThreads(
  rawThreadLists: readonly unknown[],
  options: {
    archived: boolean;
    inboxCwd: string;
    mainThreadId?: string | null;
    page: number;
    projectCwd: string | null;
  },
): ThreadCatalogPage {
  const inboxKey = pathKey(options.inboxCwd);
  const selectedProjectKey =
    options.projectCwd === null ? null : pathKey(options.projectCwd);
  const matchingThreads: ThreadCatalogEntry[] = [];

  for (const rawList of rawThreadLists) {
    for (const thread of threadData(rawList)) {
      const id = stringField(thread, "id");
      if (id === null || id === options.mainThreadId) {
        continue;
      }

      const rawCwd = stringField(thread, "cwd");
      const cwd = rawCwd === null ? null : normalizeWindowsPath(rawCwd);
      const cwdKey = cwd === null || pathKey(cwd) === inboxKey ? null : pathKey(cwd);
      if (cwdKey !== selectedProjectKey) {
        continue;
      }

      matchingThreads.push({
        archived: options.archived,
        cwd,
        id,
        status: threadStatus(thread),
        title: stringField(thread, "name") ?? stringField(thread, "preview"),
        updatedAt: numberField(thread, "updatedAt") ?? 0,
      });
    }
  }

  matchingThreads.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );

  const pageSize = 10;
  const start = (options.page - 1) * pageSize;
  const items = matchingThreads.slice(start, start + pageSize);

  return {
    archived: options.archived,
    hasNext: start + pageSize < matchingThreads.length,
    hasPrevious: options.page > 1,
    items,
    page: options.page,
    pageSize,
    total: matchingThreads.length,
  };
}

export function listActiveThreads(
  rawThreadLists: readonly unknown[],
): ThreadCatalogEntry[] {
  const active = new Map<string, ThreadCatalogEntry>();
  for (const rawList of rawThreadLists) {
    for (const thread of threadData(rawList)) {
      const id = stringField(thread, "id");
      if (id === null || threadStatus(thread) !== "active") continue;
      const rawCwd = stringField(thread, "cwd");
      const candidate: ThreadCatalogEntry = {
        archived: false,
        cwd: rawCwd === null ? null : normalizeWindowsPath(rawCwd),
        id,
        status: "active",
        title: stringField(thread, "name") ?? stringField(thread, "preview"),
        updatedAt: numberField(thread, "updatedAt") ?? 0,
      };
      const current = active.get(id);
      if (!current || candidate.updatedAt > current.updatedAt) {
        active.set(id, candidate);
      }
    }
  }
  return [...active.values()].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
}

export function buildThreadPreview(
  rawThreadRead: unknown,
  rawThreadMetadata?: unknown,
): ThreadPreview | null {
  if (!isRecord(rawThreadRead) || !isRecord(rawThreadRead.thread)) {
    return null;
  }

  const thread = rawThreadRead.thread;
  const id = stringField(thread, "id");
  if (id === null) {
    return null;
  }

  let latestUserText: string | null = null;
  let finalAgentText: string | null = null;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const rawTurn of turns) {
    if (!isRecord(rawTurn) || !Array.isArray(rawTurn.items)) {
      continue;
    }

    for (const rawItem of rawTurn.items) {
      if (!isRecord(rawItem)) {
        continue;
      }

      if (rawItem.type === "userMessage") {
        const text = userMessageText(rawItem);
        if (text !== null) {
          latestUserText = text;
        }
      } else if (rawItem.type === "agentMessage") {
        const phase = rawItem.phase;
        const text = stringField(rawItem, "text");
        if (text !== null && phase === "final_answer") {
          finalAgentText = text;
        }
      }
    }
  }

  const metadata = isRecord(rawThreadMetadata) ? rawThreadMetadata : {};
  return {
    finalAgentText: truncatePreviewText(finalAgentText),
    id,
    latestUserText: truncatePreviewText(latestUserText),
    model: truncatePreviewText(
      stringField(metadata, "model") ??
        stringField(rawThreadRead, "model") ??
        stringField(thread, "model"),
    ),
    permissionMode: truncatePreviewText(
      stringField(metadata, "permissionMode") ??
        stringField(metadata, "approvalPolicy") ??
        stringField(rawThreadRead, "permissionMode") ??
        stringField(thread, "permissionMode"),
    ),
    status: truncatePreviewText(threadStatus(thread)),
    title: truncatePreviewText(
      stringField(thread, "name") ?? stringField(thread, "preview"),
    ),
  };
}

function pathKey(path: string): string {
  return normalizeWindowsPath(path).toLocaleLowerCase("en-US");
}

function normalizeWindowsPath(path: string): string {
  const normalized = win32.normalize(path);
  const root = win32.parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/u, "");
}

function threadData(rawList: unknown): Record<string, unknown>[] {
  if (!isRecord(rawList) || !Array.isArray(rawList.data)) {
    return [];
  }

  return rawList.data.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function threadStatus(thread: Record<string, unknown>): string | null {
  const status = thread.status;
  if (typeof status === "string" && status.length > 0) {
    return status;
  }

  return isRecord(status) ? stringField(status, "type") : null;
}

function truncatePreviewText(text: string | null): string | null {
  if (text === null) {
    return null;
  }

  return [...text].slice(0, 800).join("");
}

function userMessageText(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.content)) {
    return null;
  }

  const blocks: string[] = [];
  for (const rawContent of item.content) {
    if (!isRecord(rawContent) || rawContent.type !== "text") {
      continue;
    }

    const text = stringField(rawContent, "text");
    if (text !== null) {
      blocks.push(text);
    }
  }

  return blocks.length === 0 ? null : blocks.join("\n");
}
