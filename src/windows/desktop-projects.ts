import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";

export type DesktopProject = {
  cwd: string;
  name: string;
};

const MAX_DESKTOP_PROJECT_STATE_BYTES = 1024 * 1024;

export function desktopProjectStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredHome = environment.CODEX_HOME?.trim();
  const codexHome = configuredHome ||
    win32.join(environment.USERPROFILE ?? homedir(), ".codex");
  return win32.join(codexHome, ".codex-global-state.json");
}

export function readDesktopProjects(primaryPath: string): DesktopProject[] {
  const errors: unknown[] = [];
  for (const path of [primaryPath, `${primaryPath}.bak`]) {
    try {
      const raw = readFileSync(path);
      if (raw.byteLength > MAX_DESKTOP_PROJECT_STATE_BYTES) {
        throw new Error("E_DESKTOP_PROJECT_STATE_TOO_LARGE");
      }
      return parseDesktopProjects(JSON.parse(raw.toString("utf8")) as unknown);
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "E_DESKTOP_PROJECT_STATE_UNAVAILABLE");
}

export function parseDesktopProjects(value: unknown): DesktopProject[] {
  if (!isRecord(value)) throw invalidDesktopProjectState();
  const savedRoots = value["electron-saved-workspace-roots"];
  if (!Array.isArray(savedRoots)) throw invalidDesktopProjectState();

  const roots = new Map<string, string>();
  for (const rawRoot of savedRoots) {
    const cwd = normalizeProjectPath(rawRoot);
    if (!cwd) throw invalidDesktopProjectState();
    if (!roots.has(pathKey(cwd))) roots.set(pathKey(cwd), cwd);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const projectOrder = value["project-order"];
  if (projectOrder !== undefined && !Array.isArray(projectOrder)) {
    throw invalidDesktopProjectState();
  }
  const localProjects = value["local-projects"];
  if (localProjects !== undefined && !isRecord(localProjects)) {
    throw invalidDesktopProjectState();
  }
  for (const orderEntry of projectOrder ?? []) {
    const orderedRoots = resolveOrderedRoots(orderEntry, localProjects);
    for (const cwd of orderedRoots) {
      const key = pathKey(cwd);
      const saved = roots.get(key);
      if (!saved || seen.has(key)) continue;
      ordered.push(saved);
      seen.add(key);
    }
  }
  for (const [key, cwd] of roots) {
    if (seen.has(key)) continue;
    ordered.push(cwd);
  }

  const projects = ordered.map((cwd) => ({
    cwd,
    name: win32.basename(cwd) || cwd,
  }));
  const names = new Set<string>();
  for (const project of projects) {
    const key = project.name.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error("E_DESKTOP_PROJECT_NAME_COLLISION");
    names.add(key);
  }
  return projects;
}

function resolveOrderedRoots(
  orderEntry: unknown,
  localProjects: Record<string, unknown> | undefined,
): string[] {
  const directRoot = normalizeProjectPath(orderEntry);
  if (directRoot) return [directRoot];
  if (typeof orderEntry !== "string" || !localProjects) {
    throw invalidDesktopProjectState();
  }
  const project = localProjects[orderEntry];
  if (!isRecord(project) || !Array.isArray(project.rootPaths)) {
    throw invalidDesktopProjectState();
  }
  return project.rootPaths.map((root) => {
    const cwd = normalizeProjectPath(root);
    if (!cwd) throw invalidDesktopProjectState();
    return cwd;
  });
}

function normalizeProjectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    !win32.isAbsolute(trimmed) ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return null;
  }
  const normalized = win32.normalize(trimmed);
  const root = win32.parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/u, "");
}

function pathKey(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidDesktopProjectState(): Error {
  return new Error("E_DESKTOP_PROJECT_STATE_INVALID");
}
