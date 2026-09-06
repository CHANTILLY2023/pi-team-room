export const PACKAGED_TEAM_ROLES = ["context-builder", "delegate", "oracle", "planner", "researcher", "reviewer", "scout", "worker"] as const;

export const NON_EDITING_TEAM_ROLES = new Set(["context-builder", "oracle", "planner", "researcher", "reviewer", "scout"]);

const PACKAGED_ROLE_NAMES = new Set<string>(PACKAGED_TEAM_ROLES);
const RESERVED_TEAM_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function canonicalPackagedTeamRole(role: string | undefined): string | undefined {
  const trimmed = role?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  return PACKAGED_ROLE_NAMES.has(lower) ? lower : trimmed;
}

export function isReservedTeamName(name: string): boolean {
  return RESERVED_TEAM_NAMES.has(name) || Object.hasOwn(Object.prototype, name);
}

export function isValidTeamName(name: string): boolean {
  if (!name || name.length > 80) return false;
  if (isReservedTeamName(name)) return false;
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(name);
}

export function isNonEditingTeamRole(role: string | undefined): boolean {
  const canonical = canonicalPackagedTeamRole(role);
  return !!canonical && NON_EDITING_TEAM_ROLES.has(canonical);
}
