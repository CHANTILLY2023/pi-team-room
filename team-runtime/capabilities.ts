import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";

export type RuntimeClientId = "pi" | "kimi-code" | "claude-code" | "codex-cli" | "grok-build" | "grok-pi" | "kimi-pi";

export interface TeamRuntimeModelOption {
  clientId: RuntimeClientId;
  provider: string;
  model: string;
  name: string;
  thinking?: string;
  thinkingLevels: string[];
  scoped: boolean;
  verified?: boolean;
  note?: string;
  modelRef?: string;
  isDefault?: boolean;
  defaultSource?: "config" | "environment" | "catalog" | "cli";
  source?: "config" | "cache" | "fallback";
  stale?: boolean;
  fingerprint?: string;
}

export interface TeamRuntimeClientCapability {
  clientId: RuntimeClientId;
  label: string;
  modelOptions: TeamRuntimeModelOption[];
  thinkingLevels: string[];
  verified: boolean;
  note?: string;
}

export type RuntimeCliModelOptions = Partial<Record<RuntimeClientId, readonly TeamRuntimeModelOption[]>>;

export type RuntimeConnectorAuthMode = "local-cli" | "pi-provider";
export type RuntimeConnectorSessionMode =
  | "pi-agent-session"
  | "kimi-session"
  | "claude-resume"
  | "codex-thread"
  | "grok-build-session";

export interface TeamRuntimeConnectorDefinition {
  clientId: RuntimeClientId;
  label: string;
  authMode: RuntimeConnectorAuthMode;
  sessionMode: RuntimeConnectorSessionMode;
  defaultCommand?: string;
  commandEnv?: string;
  thinkingLevels: readonly string[];
  note: string;
}

export const TEAM_RUNTIME_THINKING_LEVEL_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const KIMI_CLI_THINKING_LEVEL_OPTIONS = ["", "off", "low", "high", "max"] as const;
export const CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS = ["", "low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_CLI_THINKING_LEVEL_OPTIONS = ["", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const GROK_BUILD_CLI_THINKING_LEVEL_OPTIONS = ["", "low", "medium", "high"] as const;
export const GROK_PI_THINKING_LEVEL_OPTIONS = ["", "low", "medium", "high"] as const;
export const GROK_CLI_THINKING_LEVEL_OPTIONS = GROK_BUILD_CLI_THINKING_LEVEL_OPTIONS;

export const TEAM_RUNTIME_CLIENT_LABELS: Record<RuntimeClientId, string> = {
  pi: "PI Agent",
  "kimi-code": "Kimi Code CLI",
  "claude-code": "Claude Code CLI",
  "codex-cli": "Codex CLI",
  "grok-build": "Grok Build CLI",
  "grok-pi": "Grok API via PI",
  "kimi-pi": "Kimi API via PI",
};

export const TEAM_RUNTIME_CONNECTORS: readonly TeamRuntimeConnectorDefinition[] = [
  {
    clientId: "pi",
    label: TEAM_RUNTIME_CLIENT_LABELS.pi,
    authMode: "pi-provider",
    sessionMode: "pi-agent-session",
    thinkingLevels: TEAM_RUNTIME_THINKING_LEVEL_OPTIONS,
    note: "Uses the current PI Agent provider/model configuration; no Team Runtime secret storage.",
  },
  {
    clientId: "kimi-code",
    label: TEAM_RUNTIME_CLIENT_LABELS["kimi-code"],
    authMode: "local-cli",
    sessionMode: "kimi-session",
    defaultCommand: "kimi",
    commandEnv: "PI_TEAM_KIMI_COMMAND",
    thinkingLevels: KIMI_CLI_THINKING_LEVEL_OPTIONS,
    note: "Uses the user's installed and logged-in Kimi Code CLI.",
  },
  {
    clientId: "claude-code",
    label: TEAM_RUNTIME_CLIENT_LABELS["claude-code"],
    authMode: "local-cli",
    sessionMode: "claude-resume",
    defaultCommand: "claude",
    commandEnv: "PI_TEAM_CLAUDE_COMMAND",
    thinkingLevels: CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS,
    note: "Uses the user's installed and logged-in Claude Code CLI.",
  },
  {
    clientId: "codex-cli",
    label: TEAM_RUNTIME_CLIENT_LABELS["codex-cli"],
    authMode: "local-cli",
    sessionMode: "codex-thread",
    defaultCommand: "codex",
    commandEnv: "PI_TEAM_CODEX_COMMAND",
    thinkingLevels: CODEX_CLI_THINKING_LEVEL_OPTIONS,
    note: "Uses the user's installed and logged-in Codex CLI.",
  },
  {
    clientId: "grok-build",
    label: TEAM_RUNTIME_CLIENT_LABELS["grok-build"],
    authMode: "local-cli",
    sessionMode: "grok-build-session",
    defaultCommand: "grok",
    commandEnv: "PI_TEAM_GROK_COMMAND",
    thinkingLevels: GROK_BUILD_CLI_THINKING_LEVEL_OPTIONS,
    note: "Uses the user's installed and logged-in Grok Build CLI; only this connector injects the Grok proxy env.",
  },
  {
    clientId: "grok-pi",
    label: TEAM_RUNTIME_CLIENT_LABELS["grok-pi"],
    authMode: "pi-provider",
    sessionMode: "pi-agent-session",
    thinkingLevels: GROK_PI_THINKING_LEVEL_OPTIONS,
    note: "Uses the current PI provider configuration for Grok-compatible API/base URL access.",
  },
  {
    clientId: "kimi-pi",
    label: TEAM_RUNTIME_CLIENT_LABELS["kimi-pi"],
    authMode: "pi-provider",
    sessionMode: "pi-agent-session",
    thinkingLevels: TEAM_RUNTIME_THINKING_LEVEL_OPTIONS,
    note: "Reserved for Kimi API/base URL access through PI provider configuration.",
  },
] as const;

export function runtimeConnectorDefinitions(options: { includeReserved?: boolean } = {}): TeamRuntimeConnectorDefinition[] {
  return TEAM_RUNTIME_CONNECTORS
    .filter((connector) => options.includeReserved || connector.clientId !== "kimi-pi")
    .map((connector) => ({ ...connector, thinkingLevels: [...connector.thinkingLevels] }));
}

export function runtimeConnectorForClient(clientId: string | undefined): TeamRuntimeConnectorDefinition {
  const normalized = normalizeRuntimeClientId(clientId);
  return runtimeConnectorDefinitions({ includeReserved: true }).find((connector) => connector.clientId === normalized) ??
    runtimeConnectorDefinitions({ includeReserved: true })[0]!;
}

export function runtimeConnectorCommand(clientId: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const connector = runtimeConnectorForClient(clientId);
  if (connector.authMode !== "local-cli") return undefined;
  const configured = connector.commandEnv ? env[connector.commandEnv]?.trim() : undefined;
  return configured || connector.defaultCommand;
}

function configuredHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || homedir();
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function readTomlFile(path: string): Record<string, any> {
  const text = readTextFile(path);
  if (text === undefined) return {};
  try { return record(parseToml(text)); } catch { return {}; }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codexConfig(env: NodeJS.ProcessEnv): Record<string, any> {
  const config = readTomlFile(join(env.CODEX_HOME || join(configuredHomeDir(env), ".codex"), "config.toml"));
  return { ...config, ...record(record(config.profiles)[config.profile]) };
}

function levelsWithDefault(levels: readonly string[]): string[] {
  return uniqueLevels(["", ...levels.filter(Boolean)]);
}

function supportedThinkingDefault(levels: readonly string[], value: unknown): string | undefined {
  const thinking = typeof value === "string" ? value.trim() : "";
  return thinking && levels.includes(thinking) ? thinking : undefined;
}

function codexCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME || join(configuredHomeDir(env), ".codex");
  const catalog = stringField(codexConfig(env).model_catalog_json);
  return catalog ? resolve(codexHome, catalog) : join(codexHome, "models_cache.json");
}

export function discoverCodexCliModelOptions(env: NodeJS.ProcessEnv = process.env): TeamRuntimeModelOption[] {
  const catalog = readJsonFile(codexCatalogPath(env));
  const models = (catalog && typeof catalog === "object" && Array.isArray((catalog as { models?: unknown }).models))
    ? (catalog as { models: unknown[] }).models
    : [];
  const options: TeamRuntimeModelOption[] = [];
  const configuredEffort = stringField(codexConfig(env).model_reasoning_effort);
  for (const value of models) {
    if (!value || typeof value !== "object") continue;
    const model = value as {
      slug?: unknown;
      display_name?: unknown;
      visibility?: unknown;
      default_reasoning_level?: unknown;
      supported_reasoning_levels?: unknown;
    };
    if (typeof model.slug !== "string" || !model.slug) continue;
    if (model.visibility === "hide") continue;
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map((item) => item && typeof item === "object" ? (item as { effort?: unknown }).effort : undefined)
          .filter((effort): effort is string => typeof effort === "string" && !!effort)
      : [];
    const thinkingLevels = efforts.length > 0 ? levelsWithDefault(efforts) : [...CODEX_CLI_THINKING_LEVEL_OPTIONS];
    options.push({
      clientId: "codex-cli",
      provider: "codex-cli",
      model: model.slug,
      isDefault: model.slug === codexConfig(env).model,
      name: typeof model.display_name === "string" && model.display_name ? `${model.display_name} (Codex CLI)` : `${model.slug} (Codex CLI)`,
      thinking: configuredEffort ?? supportedThinkingDefault(thinkingLevels, model.default_reasoning_level),
      defaultSource: configuredEffort ? "config" : "catalog",
      source: "cache",
      thinkingLevels,
      scoped: false,
      verified: false,
      note: "Discovered from the local Codex model catalog.",
    });
  }
  return options;
}

export function discoverKimiCliModelOptions(env: NodeJS.ProcessEnv = process.env): TeamRuntimeModelOption[] {
  const config = readTomlFile(join(env.KIMI_CODE_HOME || join(configuredHomeDir(env), ".kimi-code"), "config.toml"));
  const options: TeamRuntimeModelOption[] = [];
  for (const [ref, value] of Object.entries(record(config.models))) {
    const base = record(value);
    const section = { ...base, ...record(base.overrides) };
    const slash = ref.indexOf("/");
    const provider = stringField(section.provider) ?? (slash > 0 ? ref.slice(0, slash) : undefined);
    const modelId = slash > 0 ? ref.slice(slash + 1) : ref;
    if (!provider || !modelId) continue;
    const displayName = stringField(section.display_name ?? section.displayName);
    const supportEfforts = (Array.isArray(section.support_efforts ?? section.supportEfforts) ? section.support_efforts ?? section.supportEfforts : []).filter((value: unknown): value is string => typeof value === "string" && !!value);
    const defaultEffort = stringField(section.default_effort ?? section.defaultEffort);
    const capabilities = Array.isArray(section.capabilities) ? section.capabilities : undefined;
    const alwaysThinking = capabilities?.includes("always_thinking") === true;
    const supportsThinking = alwaysThinking || capabilities?.includes("thinking") === true || section.adaptive_thinking === true;
    const thinkingLevels = supportEfforts.length > 0 ? levelsWithDefault(supportEfforts) : capabilities ? supportsThinking ? alwaysThinking ? ["", "on"] : ["", "off", "on"] : [""] : [...KIMI_CLI_THINKING_LEVEL_OPTIONS];
    const configured = config.thinking?.enabled === false ? "off" : stringField(config.thinking?.effort);
    const kimiProvider = provider === "kimi-code" || record(record(config.providers)[provider]).type === "kimi";
    const envEffort = kimiProvider && configured !== "off" ? stringField(env.KIMI_MODEL_THINKING_EFFORT) : undefined;
    const modelDefault = supportedThinkingDefault(thinkingLevels, defaultEffort) ?? (supportEfforts.length ? supportEfforts[Math.floor(supportEfforts.length / 2)] : capabilities ? supportsThinking ? "on" : "off" : undefined);
    options.push({
      clientId: "kimi-code",
      provider,
      model: modelId,
      modelRef: ref,
      isDefault: ref === config.default_model,
      name: displayName || modelId,
      thinking: envEffort ?? (alwaysThinking && configured === "off" ? modelDefault : configured) ?? modelDefault,
      defaultSource: envEffort ? "environment" : configured ? "config" : "catalog",
      source: "config",
      thinkingLevels,
      scoped: false,
      verified: false,
      note: "Discovered from the local Kimi Code CLI config.",
    });
  }
  return options;
}

export function discoverGrokBuildCliModelOptions(env: NodeJS.ProcessEnv = process.env): TeamRuntimeModelOption[] {
  const cache = readJsonFile(join(configuredHomeDir(env), ".grok", "models_cache.json"));
  const models = cache && typeof cache === "object" && (cache as { models?: unknown }).models;
  if (!models || typeof models !== "object") return [];
  const options: TeamRuntimeModelOption[] = [];
  for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
    const info = value && typeof value === "object" ? (value as { info?: unknown }).info : undefined;
    if (!info || typeof info !== "object") continue;
    const model = info as {
      id?: unknown;
      model?: unknown;
      name?: unknown;
      hidden?: unknown;
      supports_reasoning_effort?: unknown;
      reasoning_effort?: unknown;
      reasoning_efforts?: unknown;
    };
    const id = typeof model.id === "string" && model.id ? model.id : typeof model.model === "string" && model.model ? model.model : key;
    if (!id || model.hidden === true) continue;
    const efforts = Array.isArray(model.reasoning_efforts)
      ? model.reasoning_efforts
          .map((item) => typeof item === "string" ? item : item && typeof item === "object" ? ((item as { value?: unknown; id?: unknown }).value ?? (item as { id?: unknown }).id) : undefined)
          .filter((effort): effort is string => typeof effort === "string" && !!effort)
      : [];
    const thinkingLevels = model.supports_reasoning_effort === false
      ? [""]
      : efforts.length > 0 ? levelsWithDefault(efforts) : [...GROK_BUILD_CLI_THINKING_LEVEL_OPTIONS];
    options.push({
      clientId: "grok-build",
      provider: "grok-build",
      model: id,
      isDefault: id === readTomlFile(join(configuredHomeDir(env), ".grok", "config.toml")).model,
      name: typeof model.name === "string" && model.name ? `${model.name} (Build CLI)` : `${id} (Build CLI)`,
      thinking: model.supports_reasoning_effort === false ? undefined : stringField(readTomlFile(join(configuredHomeDir(env), ".grok", "config.toml")).reasoning_effort) ?? supportedThinkingDefault(thinkingLevels, model.reasoning_effort),
      source: "cache",
      defaultSource: stringField(readTomlFile(join(configuredHomeDir(env), ".grok", "config.toml")).reasoning_effort) ? "config" : "catalog",
      thinkingLevels,
      scoped: false,
      verified: false,
      note: "Discovered from the local Grok Build model cache.",
    });
  }
  return options;
}

export function discoverRuntimeCliModelOptions(env: NodeJS.ProcessEnv = process.env): RuntimeCliModelOptions {
  return {
    "codex-cli": discoverCodexCliModelOptions(env),
    "kimi-code": discoverKimiCliModelOptions(env),
    "grok-build": discoverGrokBuildCliModelOptions(env),
    "claude-code": discoverClaudeCliModelOptions(env),
  };
}

export function discoverClaudeCliModelOptions(env: NodeJS.ProcessEnv = process.env): TeamRuntimeModelOption[] {
  const result = spawnSync(runtimeConnectorCommand("claude-code", env)!, ["--help"], { env, encoding: "utf8", timeout: 3_000, maxBuffer: 256_000 });
  const help = result.status === 0 ? result.stdout : "";
  const effortHelp = help.match(/--effort[^\n]*(?:\n {10,}[^\n]*)*/)?.[0] ?? "";
  const levels = ["low", "medium", "high", "xhigh", "max", "ultracode"].filter(level => new RegExp(`\\b${level}\\b`).test(effortHelp));
  const config = record(readJsonFile(join(configuredHomeDir(env), ".claude", "settings.json")));
  const effort = stringField(env.CLAUDE_CODE_EFFORT_LEVEL) ?? stringField(config.effortLevel);
  const aliases = ["sonnet", "opus", "haiku", "fable"].filter(alias => new RegExp(`\\b${alias}\\b`).test(help));
  const configuredModel = stringField(env.ANTHROPIC_MODEL) ?? stringField(config.model);
  return [...new Set(["default", ...aliases, ...(configuredModel ? [configuredModel] : [])])].map(model => ({
    clientId: "claude-code", provider: "claude-code", model,
    name: model === "default" ? "Local CLI default (Claude Code)" : `${model} (Claude Code)`,
    thinking: effort, defaultSource: env.CLAUDE_CODE_EFFORT_LEVEL ? "environment" : effort ? "config" : "cli",
    thinkingLevels: levelsWithDefault(levels), scoped: false, verified: false, source: "fallback",
    note: "Local CLI aliases, not an account model catalog. Custom model IDs are accepted; availability is unverified.",
  }));
}

export class RuntimeCapabilityDiscovery {
  private readonly cache = new Map<RuntimeClientId, { fingerprint: string; configurationFingerprint: string; options: TeamRuntimeModelOption[] }>();

  fingerprint(clientId: RuntimeClientId): string | undefined { return this.cache.get(clientId)?.configurationFingerprint; }

  discover(env: NodeJS.ProcessEnv = process.env, onlyClient?: RuntimeClientId): RuntimeCliModelOptions {
    const home = configuredHomeDir(env);
    const readers: Partial<Record<RuntimeClientId, () => TeamRuntimeModelOption[]>> = {
      "codex-cli": () => discoverCodexCliModelOptions(env),
      "kimi-code": () => discoverKimiCliModelOptions(env),
      "grok-build": () => discoverGrokBuildCliModelOptions(env),
      "claude-code": () => discoverClaudeCliModelOptions(env),
    };
    const paths: Partial<Record<RuntimeClientId, string[]>> = {
      "codex-cli": [join(env.CODEX_HOME || join(home, ".codex"), "config.toml"), codexCatalogPath(env)],
      "kimi-code": [join(env.KIMI_CODE_HOME || join(home, ".kimi-code"), "config.toml")],
      "grok-build": [join(home, ".grok", "config.toml"), join(home, ".grok", "models_cache.json")],
      "claude-code": [join(home, ".claude", "settings.json")],
    };
    const result: RuntimeCliModelOptions = {};
    for (const client of Object.keys(readers) as RuntimeClientId[]) {
      if (onlyClient && client !== onlyClient) continue;
      const previous = this.cache.get(client);
      try {
        const files = paths[client]!.map(path => ({ path, text: existsSync(path) ? readFileSync(path, "utf8") : undefined }));
        const fingerprint = createHash("sha256").update(JSON.stringify({ files, command: runtimeConnectorCommand(client, env), path: env.PATH, effort: client === "kimi-code" ? env.KIMI_MODEL_THINKING_EFFORT : client === "claude-code" ? env.CLAUDE_CODE_EFFORT_LEVEL : undefined, model: client === "claude-code" ? env.ANTHROPIC_MODEL : undefined })).digest("hex");
        if (previous?.fingerprint === fingerprint) { result[client] = previous.options; continue; }
        for (const file of files) {
          if (file.text !== undefined) file.path.endsWith(".toml") ? parseToml(file.text) : JSON.parse(file.text);
        }
        const options = readers[client]!().map(option => ({ ...option, fingerprint, stale: false }));
        const config = client === "codex-cli" ? codexConfig(env) : files[0]?.text ? files[0].path.endsWith(".toml") ? record(parseToml(files[0].text)) : record(JSON.parse(files[0].text)) : {};
        const executionKeys = client === "codex-cli" ? ["model", "model_provider", "model_reasoning_effort", "profile", "model_providers"] : client === "kimi-code" ? ["default_model", "thinking", "models", "providers"] : client === "claude-code" ? ["model", "effortLevel", "env"] : ["model", "reasoning_effort"];
        const executionConfig = Object.fromEntries(executionKeys.map(key => [key, config[key]]));
        const configurationFingerprint = createHash("sha256").update(JSON.stringify({ executionConfig, command: runtimeConnectorCommand(client, env), path: env.PATH })).digest("hex");
        this.cache.set(client, { fingerprint, configurationFingerprint, options });
        result[client] = options;
      } catch {
        result[client] = (previous?.options ?? []).map(option => ({ ...option, stale: true, note: "Local capability files are temporarily unreadable; showing the last successful snapshot." }));
      }
    }
    return result;
  }
}

export interface RuntimeModelLike {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

export function normalizeRuntimeClientId(value: string | undefined): RuntimeClientId {
  const normalized = value?.trim().toLocaleLowerCase();
  if (normalized === "kimi" || normalized === "kimi-code") return "kimi-code";
  if (normalized === "claude" || normalized === "claude-code") return "claude-code";
  if (normalized === "codex" || normalized === "codex-cli") return "codex-cli";
  if (normalized === "grok" || normalized === "grok-build") return "grok-build";
  if (normalized === "grok-pi") return "grok-pi";
  if (normalized === "kimi-pi") return "kimi-pi";
  return "pi";
}

export function runtimeModelKey(option: Pick<TeamRuntimeModelOption, "clientId" | "provider" | "model" | "thinking">): string {
  return `${option.clientId}:${option.provider}/${option.model}:${option.thinking ?? ""}`;
}

export function isGrokModelRef(provider: string | undefined, model: string | undefined): boolean {
  const ref = `${provider ?? ""}/${model ?? ""}`.toLocaleLowerCase();
  return ref.includes("grok") || ref.includes("/xai/");
}

export function isKimiModelRef(provider: string | undefined, model: string | undefined): boolean {
  const ref = `${provider ?? ""}/${model ?? ""}`.toLocaleLowerCase();
  return ref.includes("kimi") || ref.includes("moonshot");
}

function isCodexGpt55(provider: string, model: string): boolean {
  return provider.toLocaleLowerCase() === "codex-chatgptclub" && model.toLocaleLowerCase() === "gpt-5.5";
}

function isDeepSeek(provider: string, model: string): boolean {
  return `${provider}/${model}`.toLocaleLowerCase().includes("deepseek");
}

function isGpt(provider: string, model: string): boolean {
  return `${provider}/${model}`.toLocaleLowerCase().includes("gpt");
}

function uniqueLevels(levels: readonly string[]): string[] {
  return levels.filter((level, index, all) => all.indexOf(level) === index);
}

export function piThinkingLevelsForModel(input: {
  provider: string;
  model: string;
  modelConfig?: Partial<RuntimeModelLike>;
}): string[] {
  const { provider, model, modelConfig } = input;
  if (modelConfig?.reasoning === false) return ["", "off"];

  if (isDeepSeek(provider, model)) {
    return ["", "off", "high", "xhigh"];
  }

  if (isGpt(provider, model)) {
    return isCodexGpt55(provider, model)
      ? TEAM_RUNTIME_THINKING_LEVEL_OPTIONS.filter((level) => level !== "max")
      : [...TEAM_RUNTIME_THINKING_LEVEL_OPTIONS];
  }

  const mappedLevels = modelConfig?.thinkingLevelMap
    ? TEAM_RUNTIME_THINKING_LEVEL_OPTIONS.filter((level) => !level || Object.prototype.hasOwnProperty.call(modelConfig.thinkingLevelMap, level))
    : ["", "off", "low", "medium", "high"];
  return uniqueLevels(mappedLevels);
}

export function createPiModelOption(input: {
  model: RuntimeModelLike;
  thinking?: string;
  scoped: boolean;
}): TeamRuntimeModelOption | undefined {
  if (isGrokModelRef(input.model.provider, input.model.id)) return undefined;
  if (isKimiModelRef(input.model.provider, input.model.id)) return undefined;
  if (isCodexGpt55(input.model.provider, input.model.id)) return undefined;
  const thinkingLevels = piThinkingLevelsForModel({
    provider: input.model.provider,
    model: input.model.id,
    modelConfig: input.model,
  });
  const thinking = input.thinking && thinkingLevels.includes(input.thinking) ? input.thinking : undefined;
  return {
    clientId: "pi",
    provider: input.model.provider,
    model: input.model.id,
    name: input.model.name || input.model.id,
    thinking,
    thinkingLevels,
    scoped: input.scoped,
    verified: true,
  };
}

export const KIMI_CLI_MODEL_OPTIONS: readonly TeamRuntimeModelOption[] = [
  {
    clientId: "kimi-code",
    provider: "kimi-code",
    model: "kimi-for-coding",
    name: "K2.7 Coding",
    thinking: "high",
    thinkingLevels: [...KIMI_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: true,
  },
  {
    clientId: "kimi-code",
    provider: "kimi-code",
    model: "k3-256k",
    name: "K3-256k Long Context",
    thinking: "high",
    thinkingLevels: [...KIMI_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: true,
  },
] as const;

export const CLAUDE_CODE_CLI_MODEL_OPTIONS: readonly TeamRuntimeModelOption[] = [
  {
    clientId: "claude-code", provider: "claude-code", model: "default", name: "Local CLI default (Claude Code)",
    thinkingLevels: [""], scoped: false, verified: false, source: "fallback", defaultSource: "cli",
    note: "No local model catalog. Inherits the CLI default; custom model IDs are also accepted.",
  },
  {
    clientId: "claude-code",
    provider: "claude-code",
    model: "sonnet",
    name: "Sonnet (Claude Code)",
    thinkingLevels: [...CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: false,
    note: "Runs through the local logged-in Claude Code CLI; this host must have `claude` installed and authenticated.",
  },
  {
    clientId: "claude-code",
    provider: "claude-code",
    model: "opus",
    name: "Opus (Claude Code)",
    thinkingLevels: [...CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: false,
    note: "Runs through the local logged-in Claude Code CLI; this host must have `claude` installed and authenticated.",
  },
  {
    clientId: "claude-code",
    provider: "claude-code",
    model: "haiku",
    name: "Haiku (Claude Code)",
    thinkingLevels: [...CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: false,
    note: "Runs through the local logged-in Claude Code CLI; this host must have `claude` installed and authenticated.",
  },
] as const;

export const CODEX_CLI_MODEL_OPTIONS: readonly TeamRuntimeModelOption[] = [
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.6-sol",
    name: "GPT-5.6 Sol (Codex CLI)",
    thinking: "low",
    thinkingLevels: [...CODEX_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.6-terra",
    name: "GPT-5.6 Terra (Codex CLI)",
    thinking: "medium",
    thinkingLevels: [...CODEX_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.6-luna",
    name: "GPT-5.6 Luna (Codex CLI)",
    thinking: "medium",
    thinkingLevels: CODEX_CLI_THINKING_LEVEL_OPTIONS.filter((level) => level !== "ultra"),
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.5",
    name: "GPT-5.5 (Codex CLI)",
    thinking: "medium",
    thinkingLevels: ["", "low", "medium", "high", "xhigh"],
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.4",
    name: "GPT-5.4 (Codex CLI)",
    thinking: "medium",
    thinkingLevels: ["", "low", "medium", "high", "xhigh"],
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.4-mini",
    name: "GPT-5.4 Mini (Codex CLI)",
    thinking: "medium",
    thinkingLevels: ["", "low", "medium", "high", "xhigh"],
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
  {
    clientId: "codex-cli",
    provider: "codex-cli",
    model: "gpt-5.2",
    name: "GPT-5.2 (Codex CLI)",
    thinking: "medium",
    thinkingLevels: ["", "low", "medium", "high", "xhigh"],
    scoped: false,
    verified: false,
    note: "Runs through the local Codex CLI account/config; selectable, but not all model/effort combinations have been fully live-probed.",
  },
] as const;

export const GROK_BUILD_CLI_MODEL_OPTIONS: readonly TeamRuntimeModelOption[] = [
  {
    clientId: "grok-build",
    provider: "grok-build",
    model: "grok-4.6",
    name: "grok-4.6 (Build CLI)",
    thinking: "high",
    thinkingLevels: [...GROK_BUILD_CLI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: false,
    note: "Grok Build CLI uses the local logged-in account and requires the local proxy/auth state to be healthy.",
  },
] as const;

export const GROK_CLI_MODEL_OPTIONS = GROK_BUILD_CLI_MODEL_OPTIONS;

export const GROK_PI_MODEL_OPTIONS: readonly TeamRuntimeModelOption[] = [
  {
    clientId: "grok-pi",
    provider: "grok-newapi",
    model: "grok-4.5",
    name: "Grok 4.5 (NewAPI via PI)",
    thinkingLevels: [...GROK_PI_THINKING_LEVEL_OPTIONS],
    scoped: false,
    verified: true,
    note: "Runs through the PI SDK provider configuration; no Grok Build proxy is injected.",
  },
] as const;

export const KIMI_PI_MODEL_OPTIONS: readonly TeamRuntimeModelOption[] = [] as const;

export function buildRuntimeCapabilities(
  piModelOptions: readonly TeamRuntimeModelOption[],
  cliModelOptions: RuntimeCliModelOptions = {},
): TeamRuntimeClientCapability[] {
  const connector = (clientId: RuntimeClientId) => runtimeConnectorForClient(clientId);
  const modelsFor = (clientId: RuntimeClientId, fallback: readonly TeamRuntimeModelOption[]) => (
    cliModelOptions[clientId] === undefined ? fallback : cliModelOptions[clientId]!.length ? cliModelOptions[clientId]! : [{
      clientId, provider: clientId, model: "default", name: "Local CLI default", thinkingLevels: [""], scoped: false,
      verified: false, source: "fallback" as const, defaultSource: "cli" as const,
      note: "No local catalog is available. Uses the CLI default; custom model IDs remain supported.",
    }]
  ).map((option) => ({ ...option, verified: false, source: option.source ?? "fallback" as const, thinkingLevels: [...option.thinkingLevels] }));
  const kimiModels = modelsFor("kimi-code", KIMI_CLI_MODEL_OPTIONS);
  const codexModels = modelsFor("codex-cli", CODEX_CLI_MODEL_OPTIONS);
  const grokBuildModels = modelsFor("grok-build", GROK_BUILD_CLI_MODEL_OPTIONS);
  const levelsFromModels = (models: readonly TeamRuntimeModelOption[], fallback: readonly string[]) => {
    const levels = uniqueLevels(models.flatMap((option) => option.thinkingLevels));
    return levels.length > 0 ? levels : [...fallback];
  };
  return [
    {
      clientId: "pi",
      label: connector("pi").label,
      modelOptions: [...piModelOptions],
      thinkingLevels: [...connector("pi").thinkingLevels],
      verified: true,
      note: connector("pi").note,
    },
    {
      clientId: "kimi-code",
      label: connector("kimi-code").label,
      modelOptions: kimiModels,
      thinkingLevels: levelsFromModels(kimiModels, connector("kimi-code").thinkingLevels),
      verified: true,
      note: connector("kimi-code").note,
    },
    {
      clientId: "claude-code",
      label: connector("claude-code").label,
      modelOptions: modelsFor("claude-code", CLAUDE_CODE_CLI_MODEL_OPTIONS),
      thinkingLevels: [...connector("claude-code").thinkingLevels],
      verified: false,
      note: "Claude Code CLI is selectable after the local `claude` command is installed and logged in.",
    },
    {
      clientId: "codex-cli",
      label: connector("codex-cli").label,
      modelOptions: codexModels,
      thinkingLevels: levelsFromModels(codexModels, connector("codex-cli").thinkingLevels),
      verified: false,
      note: "Codex CLI is selectable through the local `codex exec` account/config; live probing currently depends on the configured provider being healthy.",
    },
    {
      clientId: "grok-build",
      label: connector("grok-build").label,
      modelOptions: grokBuildModels,
      thinkingLevels: levelsFromModels(grokBuildModels, connector("grok-build").thinkingLevels),
      verified: false,
      note: "Grok Build CLI is selectable but only treated as all-green when local proxy and account token refresh work.",
    },
    {
      clientId: "grok-pi",
      label: connector("grok-pi").label,
      modelOptions: GROK_PI_MODEL_OPTIONS.map((option) => ({ ...option, thinkingLevels: [...option.thinkingLevels] })),
      thinkingLevels: [...connector("grok-pi").thinkingLevels],
      verified: true,
      note: connector("grok-pi").note,
    },
    ...(KIMI_PI_MODEL_OPTIONS.length > 0
      ? [{
        clientId: "kimi-pi" as const,
        label: connector("kimi-pi").label,
        modelOptions: KIMI_PI_MODEL_OPTIONS.map((option) => ({ ...option, thinkingLevels: [...option.thinkingLevels] })),
        thinkingLevels: [...connector("kimi-pi").thinkingLevels],
        verified: false,
        note: "Kimi via PI is reserved until API/base URL configuration is added.",
      }]
      : []),
  ];
}
