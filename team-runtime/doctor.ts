import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  normalizeRuntimeClientId,
  runtimeConnectorCommand,
  runtimeConnectorForClient,
  type RuntimeClientId,
  type RuntimeConnectorAuthMode,
  type RuntimeConnectorSessionMode,
  type TeamRuntimeClientCapability,
} from "./capabilities.ts";

export type TeamRuntimeConnectorStatus = "ready" | "missing" | "needs_probe" | "failed";

export interface TeamRuntimeConnectorProbeResult {
  ok: boolean;
  turns: number;
  assistantPreview?: string;
  error?: string;
}

export interface TeamRuntimeDoctorRecord {
  clientId: RuntimeClientId;
  label: string;
  authMode: RuntimeConnectorAuthMode;
  status: TeamRuntimeConnectorStatus;
  models: string[];
  thinkingLevels: string[];
  sessionMode: RuntimeConnectorSessionMode;
  nextStep: string;
  command?: string;
  commandEnv?: string;
  commandPath?: string;
  note?: string;
  probe?: TeamRuntimeConnectorProbeResult;
}

export interface InspectRuntimeConnectorsInput {
  capabilities: readonly TeamRuntimeClientCapability[];
  clientId?: string;
  env?: NodeJS.ProcessEnv;
  locateCommand?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function locateRuntimeCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/") || isAbsolute(trimmed)) return isExecutable(trimmed) ? trimmed : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, trimmed);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function modelRefs(capability: TeamRuntimeClientCapability): string[] {
  return capability.modelOptions.map((option) => `${option.provider}/${option.model}`);
}

function displayThinking(levels: readonly string[]): string[] {
  return levels.map((level) => level || "default");
}

function nextStepFor(input: {
  authMode: RuntimeConnectorAuthMode;
  label: string;
  command?: string;
  commandEnv?: string;
  commandFound: boolean;
  modelCount: number;
}): string {
  if (input.authMode === "pi-provider") {
    return input.modelCount > 0
      ? "Ready from the current PI provider/model configuration. Use probe=true only when you want a real hello test."
      : "No PI models were discovered. Check ctx.scopedModels or ~/.pi/agent/settings.json enabledModels.";
  }
  if (!input.commandFound) {
    const override = input.commandEnv ? ` Set ${input.commandEnv} to a custom command path if needed.` : "";
    return `Install and log in to ${input.label}, then make ${input.command ?? "the CLI"} available on PATH.${override}`;
  }
  return "Command found. Run doctor with probe=true for a real two-turn hello test before calling it all-green.";
}

export function inspectRuntimeConnectors(input: InspectRuntimeConnectorsInput): TeamRuntimeDoctorRecord[] {
  const env = input.env ?? process.env;
  const locateCommand = input.locateCommand ?? locateRuntimeCommand;
  const clientFilter = input.clientId ? normalizeRuntimeClientId(input.clientId) : undefined;
  const capabilities = input.capabilities
    .filter((capability) => !clientFilter || normalizeRuntimeClientId(capability.clientId) === clientFilter);

  return capabilities.map((capability): TeamRuntimeDoctorRecord => {
    const connector = runtimeConnectorForClient(capability.clientId);
    const command = runtimeConnectorCommand(connector.clientId, env);
    const commandPath = command ? locateCommand(command, env) : undefined;
    const models = modelRefs(capability);
    const status: TeamRuntimeConnectorStatus = connector.authMode === "local-cli"
      ? commandPath ? "needs_probe" : "missing"
      : models.length > 0 ? "ready" : "missing";
    return {
      clientId: connector.clientId,
      label: connector.label,
      authMode: connector.authMode,
      status,
      models,
      thinkingLevels: [...capability.thinkingLevels],
      sessionMode: connector.sessionMode,
      nextStep: nextStepFor({
        authMode: connector.authMode,
        label: connector.label,
        command,
        commandEnv: connector.commandEnv,
        commandFound: !!commandPath,
        modelCount: models.length,
      }),
      command,
      commandEnv: connector.commandEnv,
      commandPath,
      note: capability.note ?? connector.note,
    };
  });
}

function compactList(values: readonly string[], limit = 5): string {
  if (values.length === 0) return "(none)";
  const head = values.slice(0, limit);
  const suffix = values.length > head.length ? `, +${values.length - head.length} more` : "";
  return `${head.join(", ")}${suffix}`;
}

export function formatRuntimeDoctor(records: readonly TeamRuntimeDoctorRecord[]): string {
  if (records.length === 0) return "No Team Runtime connectors matched the requested clientId.";
  const lines = ["Team Runtime connector doctor"];
  for (const record of records) {
    const command = record.command ? ` command=${record.commandPath ?? record.command ?? "missing"}` : "";
    lines.push("");
    lines.push(`[${record.status}] ${record.label} (${record.clientId})`);
    lines.push(`  auth=${record.authMode} session=${record.sessionMode}${command}`);
    lines.push(`  models=${compactList(record.models)}`);
    lines.push(`  thinking=${displayThinking(record.thinkingLevels).join(", ")}`);
    if (record.probe) {
      lines.push(`  probe=${record.probe.ok ? "ok" : "failed"} turns=${record.probe.turns}${record.probe.assistantPreview ? ` preview=${record.probe.assistantPreview}` : ""}${record.probe.error ? ` error=${record.probe.error}` : ""}`);
    }
    lines.push(`  next=${record.nextStep}`);
  }
  return lines.join("\n");
}
