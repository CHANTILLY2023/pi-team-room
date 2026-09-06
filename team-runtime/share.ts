import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { isAbsolute, join } from "node:path";

export const TEAM_WEB_SHARE_DEFAULT_LOGIN_TTL_MS = 5 * 60 * 1000;
export const TEAM_WEB_SHARE_DEFAULT_SESSION_TTL_HOURS = 12;
export const TEAM_WEB_SHARE_LOCAL_CONFIG_PATH = ".pi/messenger/team-web-share.json";
export const TEAM_WEB_SHARE_USER_CONFIG_PATH = "~/.pi/messenger/team-web-share.json";
export const TEAM_WEB_SHARE_HTTP_WARNING = "WARNING: Team Web mobile share is using plain HTTP. QR token, PIN, and session cookie can be observed on the network; use HTTPS for untrusted networks.";

export const TEAM_WEB_SHARE_PROVIDER_IDS = ["frp", "rathole"] as const;
export type TeamWebShareProviderId = typeof TEAM_WEB_SHARE_PROVIDER_IDS[number];
export type TeamWebShareConfigSource = "action" | "local" | "user" | "env" | "mixed";

export interface TeamWebShareInput {
  cwd?: string;
  provider?: string;
  publicUrl?: string;
  command?: string;
  configPath?: string;
  localPort?: number;
  autoStart?: boolean;
  env?: Record<string, string | undefined>;
}

export interface TeamWebShareProviderContract {
  id: TeamWebShareProviderId;
  label: string;
  binary: string;
  configHint: string;
}

export interface TeamWebShareProviderConfig {
  provider: TeamWebShareProviderId;
  contract: TeamWebShareProviderContract;
  publicUrl: string;
  command?: string;
  configPath?: string;
  localPort?: number;
  autoStart: boolean;
  configSource: TeamWebShareConfigSource;
  localConfigPath?: string;
  userConfigPath?: string;
  localPortSource?: TeamWebShareConfigSource;
  httpWarning?: string;
}

export interface TeamWebShareConfigIssue {
  code:
    | "missing_provider"
    | "invalid_provider"
    | "missing_public_url"
    | "invalid_public_url"
    | "invalid_local_config"
    | "invalid_local_port";
  message: string;
  provider?: string;
  publicUrl?: string;
  configPath?: string;
}

export type TeamWebShareConfigResult =
  | { ok: true; config: TeamWebShareProviderConfig }
  | { ok: false; issue: TeamWebShareConfigIssue };

export interface TeamWebShareLocalConfig {
  provider?: string;
  publicUrl?: string;
  command?: string;
  configPath?: string;
  localPort?: number;
  autoStart?: boolean;
}

export interface TeamWebShareDoctorInspection {
  binaryFound: boolean;
  binaryPath?: string;
  configExists?: boolean;
  canAutoStart: boolean;
  issues: string[];
}

interface SourcedValue<T> {
  value: T;
  source: Exclude<TeamWebShareConfigSource, "mixed">;
}

export const TEAM_WEB_SHARE_PROVIDER_CONTRACTS: Record<TeamWebShareProviderId, TeamWebShareProviderContract> = {
  frp: {
    id: "frp",
    label: "frp self-hosted reverse tunnel",
    binary: "frpc",
    configHint: "Run frpc with an http/https/tcp proxy that forwards the public URL to 127.0.0.1:<Team Web port>.",
  },
  rathole: {
    id: "rathole",
    label: "rathole self-hosted reverse tunnel",
    binary: "rathole",
    configHint: "Run the rathole client with a service that forwards the public URL to 127.0.0.1:<Team Web port>.",
  },
};

export const TEAM_WEB_SHARE_ENV = {
  provider: "PI_TEAM_WEB_SHARE_PROVIDER",
  publicUrl: "PI_TEAM_WEB_SHARE_URL",
  command: "PI_TEAM_WEB_SHARE_COMMAND",
  configPath: "PI_TEAM_WEB_SHARE_CONFIG",
} as const;

export function resolveTeamWebShareConfig(input: TeamWebShareInput = {}): TeamWebShareConfigResult {
  const env = input.env ?? process.env;
  const fileConfig = readTeamWebShareFileConfig(input.cwd, env);
  if (fileConfig?.ok === false) return { ok: false, issue: fileConfig.issue };
  const configured = fileConfig?.config;
  const configuredSource = fileConfig?.source ?? "local";

  const rawProvider = firstString(
    { value: input.provider, source: "action" },
    { value: configured?.provider, source: configuredSource },
    { value: env[TEAM_WEB_SHARE_ENV.provider], source: "env" },
  );
  if (!rawProvider?.value) {
    return {
      ok: false,
      issue: {
        code: "missing_provider",
        message: `Team Web share needs ${TEAM_WEB_SHARE_LOCAL_CONFIG_PATH}, ${TEAM_WEB_SHARE_USER_CONFIG_PATH}, ${TEAM_WEB_SHARE_ENV.provider}=frp or rathole, or action shareProvider.`,
      },
    };
  }

  const provider = rawProvider.value.trim().toLocaleLowerCase();
  if (!isTeamWebShareProviderId(provider)) {
    return {
      ok: false,
      issue: {
        code: "invalid_provider",
        provider: rawProvider.value,
        message: `Unsupported Team Web share provider "${rawProvider.value}". Supported providers: frp, rathole.`,
      },
    };
  }

  const rawUrl = firstString(
    { value: input.publicUrl, source: "action" },
    { value: configured?.publicUrl, source: configuredSource },
    { value: env[TEAM_WEB_SHARE_ENV.publicUrl], source: "env" },
  );
  if (!rawUrl?.value) {
    return {
      ok: false,
      issue: {
        code: "missing_public_url",
        provider,
        message: `Team Web share needs ${TEAM_WEB_SHARE_LOCAL_CONFIG_PATH} or ${TEAM_WEB_SHARE_USER_CONFIG_PATH} publicUrl, ${TEAM_WEB_SHARE_ENV.publicUrl}=https://your-domain.example, or action shareUrl.`,
      },
    };
  }

  const normalized = normalizeTeamWebSharePublicUrl(rawUrl.value);
  if (normalized.ok === false) {
    return {
      ok: false,
      issue: {
        code: "invalid_public_url",
        provider,
        publicUrl: rawUrl.value,
        message: normalized.message,
      },
    };
  }

  const configPath = firstString(
    { value: input.configPath, source: "action" },
    { value: configured?.configPath, source: configuredSource },
    { value: env[TEAM_WEB_SHARE_ENV.configPath], source: "env" },
  );
  const command = firstString(
    { value: input.command, source: "action" },
    { value: configured?.command, source: configuredSource },
    { value: env[TEAM_WEB_SHARE_ENV.command], source: "env" },
  );
  const localPort = firstNumber(
    { value: configured?.localPort, source: configuredSource },
    { value: input.localPort, source: "action" },
  );
  if (localPort && (!Number.isInteger(localPort.value) || localPort.value < 0 || localPort.value > 65535)) {
    return {
      ok: false,
      issue: {
        code: "invalid_local_port",
        provider,
        message: `Invalid Team Web share localPort "${localPort.value}". Use an integer from 0 to 65535.`,
      },
    };
  }

  const autoStart = firstBoolean(
    { value: input.autoStart, source: "action" },
    { value: configured?.autoStart, source: configuredSource },
  );
  const resolvedConfigPath = configPath?.value ? normalizeConfigPath(configPath.value, configPath.source === "user" ? userHomeDir(env) : input.cwd, env) : undefined;
  const sources = [rawProvider.source, rawUrl.source, configPath?.source, command?.source, autoStart?.source]
    .filter((source): source is Exclude<TeamWebShareConfigSource, "mixed"> => !!source);
  const requestedAutoStart = autoStart?.value ?? Boolean(resolvedConfigPath);

  return {
    ok: true,
    config: {
      provider,
      contract: TEAM_WEB_SHARE_PROVIDER_CONTRACTS[provider],
      publicUrl: normalized.publicUrl,
      command: command?.value,
      configPath: resolvedConfigPath,
      localPort: localPort?.value,
      autoStart: requestedAutoStart && Boolean(resolvedConfigPath),
      configSource: summarizeSources(sources),
      localConfigPath: fileConfig?.source === "local" ? fileConfig.path : undefined,
      userConfigPath: fileConfig?.source === "user" ? fileConfig.path : undefined,
      localPortSource: localPort?.source,
      httpWarning: normalized.httpWarning,
    },
  };
}

export function buildTeamWebShareLoginUrl(publicUrl: string, token: string): string {
  const url = new URL(publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`);
  url.pathname = "/share/login";
  url.search = "";
  url.searchParams.set("token", token);
  url.hash = "";
  return url.toString();
}

export function describeTeamWebShareDoctor(input: TeamWebShareInput = {}): string {
  const resolved = resolveTeamWebShareConfig(input);
  const localTarget = typeof input.localPort === "number"
    ? `127.0.0.1:${input.localPort}`
    : "127.0.0.1:<Team Web port>";
  const common = [
    "Team Web share v1 supports self-hosted frp and rathole only.",
    "Team Web can auto-start a configured frp/rathole client, but it will not auto-install tunnel binaries and will not store tunnel secrets.",
    `Configure ${TEAM_WEB_SHARE_LOCAL_CONFIG_PATH}, ${TEAM_WEB_SHARE_USER_CONFIG_PATH}, ${TEAM_WEB_SHARE_ENV.provider}=frp|rathole plus ${TEAM_WEB_SHARE_ENV.publicUrl}=https://your-domain.example, or pass shareProvider/shareUrl to the action.`,
  ];

  if (resolved.ok === false) {
    return [
      `Team Web share is not ready: ${resolved.issue.message}`,
      ...common,
      "",
      `frp: ${TEAM_WEB_SHARE_PROVIDER_CONTRACTS.frp.configHint.replace("<Team Web port>", String(input.localPort ?? "<Team Web port>"))}`,
      `rathole: ${TEAM_WEB_SHARE_PROVIDER_CONTRACTS.rathole.configHint.replace("<Team Web port>", String(input.localPort ?? "<Team Web port>"))}`,
    ].join("\n");
  }

  const { config } = resolved;
  const inspection = inspectTeamWebShareProvider(config);
  const lines = [
    `Team Web share provider: ${config.contract.label}`,
    `Public URL: ${config.publicUrl}`,
    config.httpWarning ? config.httpWarning : "",
    `Config source: ${config.configSource}`,
    config.localConfigPath ? `Project share config: ${config.localConfigPath}` : "Project share config: not found",
    config.userConfigPath ? `User share config: ${config.userConfigPath}` : "User share config: not used",
    `Local target: ${config.localPort ? `127.0.0.1:${config.localPort}` : localTarget}`,
    `Tunnel binary: ${config.contract.binary}${inspection.binaryPath ? ` (${inspection.binaryPath})` : inspection.binaryFound ? " (found)" : " (missing from PATH)"}`,
    config.configPath ? `Tunnel config: ${config.configPath}${inspection.configExists ? " (found)" : " (missing)"}` : "Tunnel config: not configured; auto-start disabled",
    config.command ? `Tunnel command hint: ${config.command} (not executed by Team Web)` : "Tunnel command hint: not recorded by Team Web",
    `Tunnel auto-start: ${inspection.canAutoStart ? "ready" : "disabled/unavailable"}`,
    "Built-in Team Web security: one-time QR login token + PIN, HttpOnly mobile session cookie, TTL, and revoke.",
    ...inspection.issues.map((issue) => `Issue: ${issue}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export function inspectTeamWebShareProvider(
  config: TeamWebShareProviderConfig,
  env: Record<string, string | undefined> = process.env,
): TeamWebShareDoctorInspection {
  const binaryPath = findExecutable(config.contract.binary, env);
  const configExists = config.configPath ? existsSync(config.configPath) : undefined;
  const issues: string[] = [];
  if (!binaryPath) issues.push(`Install ${config.contract.binary} and make it available on PATH.`);
  if (config.configPath && !configExists) issues.push(`Tunnel config does not exist: ${config.configPath}`);
  if (!config.configPath) issues.push("No tunnel config path is configured, so Team Web will not auto-start the tunnel.");
  return {
    binaryFound: Boolean(binaryPath),
    binaryPath,
    configExists,
    canAutoStart: Boolean(config.autoStart && config.configPath && configExists && binaryPath),
    issues,
  };
}

export function buildTeamWebShareTunnelCommand(config: TeamWebShareProviderConfig): { command: string; args: string[]; display: string } {
  if (!config.configPath) {
    return { command: config.contract.binary, args: [], display: config.contract.binary };
  }
  return {
    command: config.contract.binary,
    args: ["-c", config.configPath],
    display: `${config.contract.binary} -c ${config.configPath}`,
  };
}

type TeamWebShareFileConfigResult =
  | { ok: true; source: "local" | "user"; path: string; config: TeamWebShareLocalConfig }
  | { ok: false; issue: TeamWebShareConfigIssue };

function readTeamWebShareFileConfig(cwd: string | undefined, env: Record<string, string | undefined>): TeamWebShareFileConfigResult | undefined {
  const localPath = cwd ? join(cwd, TEAM_WEB_SHARE_LOCAL_CONFIG_PATH) : undefined;
  if (localPath) {
    const local = readTeamWebShareConfigFile(localPath, "local");
    if (local) return local;
  }
  const home = userHomeDir(env);
  if (!home) return undefined;
  return readTeamWebShareConfigFile(join(home, ".pi", "messenger", "team-web-share.json"), "user");
}

function readTeamWebShareConfigFile(path: string, source: "local" | "user"): TeamWebShareFileConfigResult | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, issue: { code: "invalid_local_config", configPath: path, message: `Team Web share config must be a JSON object: ${path}` } };
    }
    const config: TeamWebShareLocalConfig = {};
    for (const key of ["provider", "publicUrl", "command", "configPath"] as const) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        return { ok: false, issue: { code: "invalid_local_config", configPath: path, message: `Team Web share config field "${key}" must be a string.` } };
      }
      config[key] = value;
    }
    if (parsed.localPort !== undefined) {
      if (typeof parsed.localPort !== "number") {
        return { ok: false, issue: { code: "invalid_local_port", configPath: path, message: "Team Web share config field \"localPort\" must be a number." } };
      }
      config.localPort = parsed.localPort;
    }
    if (parsed.autoStart !== undefined) {
      if (typeof parsed.autoStart !== "boolean") {
        return { ok: false, issue: { code: "invalid_local_config", configPath: path, message: "Team Web share config field \"autoStart\" must be a boolean." } };
      }
      config.autoStart = parsed.autoStart;
    }
    return { ok: true, source, path, config };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issue: { code: "invalid_local_config", configPath: path, message: `Unable to read Team Web share config ${path}: ${message}` } };
  }
}

function isTeamWebShareProviderId(value: string): value is TeamWebShareProviderId {
  return (TEAM_WEB_SHARE_PROVIDER_IDS as readonly string[]).includes(value);
}

function normalizeTeamWebSharePublicUrl(rawUrl: string): { ok: true; publicUrl: string; httpWarning?: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: `Invalid Team Web share URL "${rawUrl}". Use an absolute http(s) URL.` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `Invalid Team Web share URL "${rawUrl}". Only http(s) URLs are supported.` };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Team Web share URL must not include credentials." };
  }
  if (url.search || url.hash) {
    return { ok: false, message: "Team Web share URL must be the public origin/root URL without query or fragment." };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, message: "Team Web share URL must point at the Team Web root path. Configure the reverse proxy to expose Team Web at that root." };
  }

  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return {
    ok: true,
    publicUrl: url.toString().replace(/\/$/, ""),
    httpWarning: url.protocol === "http:" ? TEAM_WEB_SHARE_HTTP_WARNING : undefined,
  };
}

function firstString(...values: Array<{ value?: string; source: Exclude<TeamWebShareConfigSource, "mixed"> }>): SourcedValue<string> | undefined {
  for (const item of values) {
    const trimmed = item.value?.trim();
    if (trimmed) return { value: trimmed, source: item.source };
  }
  return undefined;
}

function firstNumber(...values: Array<{ value?: number; source: Exclude<TeamWebShareConfigSource, "mixed"> }>): SourcedValue<number> | undefined {
  for (const item of values) {
    if (typeof item.value === "number" && Number.isFinite(item.value)) return { value: item.value, source: item.source };
  }
  return undefined;
}

function firstBoolean(...values: Array<{ value?: boolean; source: Exclude<TeamWebShareConfigSource, "mixed"> }>): SourcedValue<boolean> | undefined {
  for (const item of values) {
    if (typeof item.value === "boolean") return { value: item.value, source: item.source };
  }
  return undefined;
}

function summarizeSources(sources: Array<Exclude<TeamWebShareConfigSource, "mixed">>): TeamWebShareConfigSource {
  const unique = [...new Set(sources)];
  return unique.length === 1 ? unique[0] : "mixed";
}

function normalizeConfigPath(rawPath: string, cwd: string | undefined, env: Record<string, string | undefined>): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return userHomeDir(env) ?? trimmed;
  if (trimmed.startsWith("~/")) {
    const home = userHomeDir(env);
    return home ? join(home, trimmed.slice(2)) : trimmed;
  }
  if (!trimmed || isAbsolute(trimmed) || !cwd) return trimmed;
  return join(cwd, trimmed);
}

function userHomeDir(env: Record<string, string | undefined>): string | undefined {
  return env.HOME || env.USERPROFILE;
}

function findExecutable(binary: string, env: Record<string, string | undefined>): string | undefined {
  const candidates = binary.includes("/") ? [binary] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}
