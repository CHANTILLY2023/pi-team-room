import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { TeamRuntimeError } from "./types.ts";

/** Persisted skills are always absolute paths; names are resolved at agent-add time. */
export type SkillPath = string;

export interface ResolveSkillRefsOptions {
  cwd: string;
  agentDir?: string;
}

/**
 * Resolve user-facing skill references to the paths accepted by PI's
 * `DefaultResourceLoader.additionalSkillPaths` option.
 *
 * A reference which names an existing file/directory is treated as a path.
 * Otherwise it is looked up by Agent Skills `name` using the same roots PI
 * discovers by default. Duplicate names use native first-wins precedence.
 */
export function resolveAgentSkillPaths(
  refs: readonly string[] | undefined,
  options: ResolveSkillRefsOptions,
): SkillPath[] {
  const references = refs ?? [];
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? join(homedir(), ".pi", "agent"));
  const discovered = discoverNativeSkills(cwd, agentDir);
  const byName = new Map<string, Skill>();
  for (const skill of discovered) {
    const key = normalizeSkillName(skill.name);
    if (!byName.has(key)) byName.set(key, skill);
  }

  const result: SkillPath[] = [];
  const seen = new Set<string>();
  for (const raw of references) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new TeamRuntimeError("conflict", "Skill references must be non-empty strings", { reference: raw });
    }
    const ref = raw.trim();
    const pathCandidate = resolveSkillPath(ref, cwd);
    const path = pathCandidate ? canonicalPath(pathCandidate) : byName.get(normalizeSkillName(ref))?.filePath;
    if (!path) {
      throw new TeamRuntimeError("not_found", `Skill ${JSON.stringify(ref)} was not found`, {
        skill: ref,
        cwd,
      });
    }
    const canonical = canonicalPath(path);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

/** Validate the persisted representation before handing it to PI. */
export function assertSkillPaths(paths: readonly string[] | undefined): SkillPath[] {
  if (!Array.isArray(paths)) {
    throw new TeamRuntimeError("conflict", "Persistent Agent skillPaths must be an array", { paths });
  }
  const result: SkillPath[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string" || !isAbsolute(raw)) {
      throw new TeamRuntimeError("conflict", `Persistent Agent skillPath must be absolute: ${JSON.stringify(raw)}`, {
        skillPath: raw,
      });
    }
    const canonical = canonicalPath(raw);
    if (!existsSync(canonical)) {
      throw new TeamRuntimeError("not_found", `Persistent Agent skillPath does not exist: ${canonical}`, {
        skillPath: canonical,
      });
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

function normalizeSkillName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function resolveSkillPath(reference: string, cwd: string): string | undefined {
  const expanded = reference === "~" || reference.startsWith("~/" )
    ? join(homedir(), reference === "~" ? "" : reference.slice(2))
    : reference;
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (!existsSync(candidate)) return undefined;
  try {
    const stats = statSync(candidate);
    if (!stats.isFile() && !stats.isDirectory()) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function discoverNativeSkills(cwd: string, agentDir: string): Skill[] {
  const skills: Skill[] = [];
  const seenRoots = new Set<string>();
  // PI gives project resources precedence over user resources. Within a
  // project, the nearest root wins, matching ancestor traversal semantics.
  addRoot(join(cwd, ".pi", "skills"), "project", skills, seenRoots, true);
  for (const directory of ancestorDirectories(cwd)) {
    addRoot(join(directory, ".agents", "skills"), "project", skills, seenRoots, false);
  }
  for (const root of [join(agentDir, "skills"), join(homedir(), ".agents", "skills")]) {
    addRoot(root, "user", skills, seenRoots, root.endsWith(join(".agents", "skills")) ? false : true);
  }
  return skills;
}

function addRoot(
  root: string,
  source: string,
  skills: Skill[],
  seenRoots: Set<string>,
  allowRootFiles: boolean,
): void {
  const canonicalRoot = canonicalPath(root);
  if (seenRoots.has(canonicalRoot) || !existsSync(canonicalRoot)) return;
  seenRoots.add(canonicalRoot);
  try {
    const loaded = loadSkillsFromDir({ dir: canonicalRoot, source }).skills;
    // Native PI ignores root-level markdown files under `.agents/skills`.
    // `loadSkillsFromDir` intentionally includes those files for `.pi/skills`
    // and `~/.pi/agent/skills`, so filter only the Agent Skills roots here.
    skills.push(...(allowRootFiles
      ? loaded
      : loaded.filter((skill) => resolve(dirname(skill.filePath)) !== canonicalRoot)));
  } catch {
    // PI treats unreadable skill roots as diagnostics rather than fatal errors;
    // a named reference still fails explicitly below if no readable winner exists.
  }
}

function ancestorDirectories(start: string): string[] {
  const result: string[] = [];
  let current = resolve(start);
  while (true) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}
