import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  CLAUDE_CODE_CLI_MODEL_OPTIONS,
  CODEX_CLI_MODEL_OPTIONS,
  GROK_BUILD_CLI_MODEL_OPTIONS,
  GROK_PI_MODEL_OPTIONS,
  KIMI_CLI_MODEL_OPTIONS,
  TEAM_RUNTIME_THINKING_LEVEL_OPTIONS,
  buildRuntimeCapabilities,
  createPiModelOption,
  runtimeModelKey,
  type RuntimeModelLike,
  type TeamRuntimeClientCapability,
  type TeamRuntimeModelOption,
} from "./capabilities.ts";
import { PiAgentRuntime } from "./runtime.ts";
import { claudeThinkingEffort, codexThinkingEffort, kimiThinkingEffort, type SpawnFunction } from "./providers/adapters.ts";
import type { PersistentAgent, SessionBinding } from "./types.ts";

type ProbeClient = "pi" | "kimi-code" | "claude-code" | "codex-cli" | "grok-pi" | "grok-build";

interface CliInvocation {
  command: string;
  args: string[];
  cwd?: string;
  kimiThinkingEffort?: string;
  httpProxy?: string;
  reasoningEffort?: string;
  claudeThinkingEffort?: string;
  codexThinkingEffort?: string;
}

interface ProbeRecord {
  clientId: ProbeClient;
  provider: string;
  model: string;
  thinking: string;
  turns: number;
  ok: boolean;
  requested: {
    provider: string;
    model: string;
    thinking?: string;
  };
  effective?: {
    provider: string;
    model: string;
    thinking?: string;
  };
  cli?: CliInvocation;
  cliInvocations?: CliInvocation[];
  turnResults?: Array<{
    turn: number;
    effective?: {
      provider: string;
      model: string;
      thinking?: string;
    };
    cli?: CliInvocation;
    assistantTextLength?: number;
    assistantPreview?: string;
  }>;
  assistantTextLength?: number;
  assistantPreview?: string;
  error?: string;
  elapsedMs: number;
}

const PROBE_PROMPT = process.env.TEAM_RUNTIME_PROBE_PROMPT ?? "你好";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.TEAM_RUNTIME_PROBE_TIMEOUT_MS ?? "180000", 10);
const THINKING_LEVELS = new Set<string>(TEAM_RUNTIME_THINKING_LEVEL_OPTIONS.filter(Boolean));

function compactText(value: string | undefined, limit = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3))}...` : text;
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
}

function normalizeProbeClient(value: string | undefined): ProbeClient | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  if (normalized === "pi") return "pi";
  if (normalized === "kimi" || normalized === "kimi-code") return "kimi-code";
  if (normalized === "claude" || normalized === "claude-code") return "claude-code";
  if (normalized === "codex" || normalized === "codex-cli") return "codex-cli";
  if (normalized === "grok" || normalized === "grok-build") return "grok-build";
  if (normalized === "grok-pi") return "grok-pi";
  return undefined;
}

function isProbeClient(value: string): value is ProbeClient {
  return value === "pi" || value === "kimi-code" || value === "claude-code" || value === "codex-cli" || value === "grok-pi" || value === "grok-build";
}

function parseArgs(): { clients: ProbeClient[]; keepSessions: boolean; turns: number; refs: Set<string>; thinking?: string } {
  const clientArg = process.argv.find((arg) => arg.startsWith("--client="))?.slice("--client=".length);
  const turnsArg = process.argv.find((arg) => arg.startsWith("--turns="))?.slice("--turns=".length);
  const refArg = process.argv.find((arg) => arg.startsWith("--ref="))?.slice("--ref=".length);
  const thinkingArg = process.argv.find((arg) => arg.startsWith("--thinking="))?.slice("--thinking=".length);
  const turns = Math.max(1, Math.min(5, Number.parseInt(turnsArg ?? "1", 10) || 1));
  const clients = clientArg
    ? clientArg.split(",").map(normalizeProbeClient).filter((client): client is ProbeClient => !!client)
    : ["pi", "kimi-code", "grok-pi"] as ProbeClient[];
  return {
    clients: clients.length > 0 ? clients : ["pi", "kimi-code", "grok-pi"],
    keepSessions: process.argv.includes("--keep-sessions"),
    turns,
    refs: new Set((refArg ?? "").split(",").map((ref) => ref.trim().toLocaleLowerCase()).filter(Boolean)),
    thinking: thinkingArg,
  };
}

function readEnabledModelRefs(agentDir: string): Array<{ provider: string; model: string; thinking?: string }> {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return [];
  let enabledModels: unknown;
  try {
    enabledModels = (JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledModels?: unknown }).enabledModels;
  } catch {
    return [];
  }
  if (!Array.isArray(enabledModels)) return [];

  const refs: Array<{ provider: string; model: string; thinking?: string }> = [];
  for (const value of enabledModels) {
    if (typeof value !== "string") continue;
    let ref = value.trim();
    if (!ref) continue;
    let thinking: string | undefined;
    const colon = ref.lastIndexOf(":");
    if (colon > 0) {
      const suffix = ref.slice(colon + 1);
      if (THINKING_LEVELS.has(suffix)) {
        thinking = suffix;
        ref = ref.slice(0, colon);
      }
    }
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    refs.push({ provider: ref.slice(0, slash), model: ref.slice(slash + 1), thinking });
  }
  return refs;
}

async function loadPiModelOptions(agentDir: string): Promise<TeamRuntimeModelOption[]> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const enabledRefs = readEnabledModelRefs(agentDir);
  const modelRefs: Array<{ provider: string; model: string; thinking?: string }> = enabledRefs.length > 0
    ? enabledRefs
    : modelRuntime.getAvailableSnapshot().map((model) => ({ provider: model.provider, model: model.id }));
  const options: TeamRuntimeModelOption[] = [];
  const seen = new Set<string>();

  for (const ref of modelRefs) {
    const model = modelRuntime.getModel(ref.provider, ref.model);
    if (!model) continue;
    const option = createPiModelOption({
      model: model as RuntimeModelLike,
      thinking: ref.thinking,
      scoped: enabledRefs.length > 0,
    });
    if (!option) continue;
    const key = `${option.clientId}:${option.provider}/${option.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

function createAgent(input: {
  clientId: ProbeClient;
  provider: string;
  model: string;
  thinking: string;
  runtimePolicy?: PersistentAgent["runtimePolicy"];
}): PersistentAgent {
  const thinking = input.thinking || undefined;
  const id = `probe-${input.clientId}-${slug(input.provider)}-${slug(input.model)}-${slug(thinking ?? "default")}`;
  return {
    id,
    name: id,
    clientId: input.clientId,
    provider: input.provider,
    model: input.model,
    thinking,
    skillPaths: [],
    aliases: [],
    runtimePolicy: input.runtimePolicy ?? "on_demand",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createBinding(input: {
  cwd: string;
  threadId: string;
  agent: PersistentAgent;
}): SessionBinding {
  return {
    threadId: input.threadId,
    agentId: input.agent.id,
    piSessionId: randomUUID(),
    cwd: input.cwd,
    provider: input.agent.provider,
    model: input.agent.model,
    thinking: input.agent.thinking,
    status: "active",
    generation: 0,
    lastVisibleSeq: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

async function runProbe(input: {
  runtime: PiAgentRuntime;
  cwd: string;
  clientId: ProbeClient;
  provider: string;
  model: string;
  thinking: string;
  turns: number;
  cliLog?: CliInvocation[];
}): Promise<ProbeRecord> {
  const started = Date.now();
  const agent = createAgent({
    ...input,
    runtimePolicy: input.turns > 1 ? "idle_timeout" : "on_demand",
  });
  let binding = createBinding({
    cwd: input.cwd,
    threadId: `capability-probe-${input.clientId}`,
    agent,
  });
  const beforeCliCount = input.cliLog?.length ?? 0;
  const turnResults: NonNullable<ProbeRecord["turnResults"]> = [];

  try {
    let result: Awaited<ReturnType<PiAgentRuntime["invoke"]>> | undefined;
    for (let turn = 1; turn <= input.turns; turn++) {
      const beforeTurnCliCount = input.cliLog?.length ?? 0;
      const prompt = turn === 1
        ? PROBE_PROMPT
        : `第二轮：上一轮用户说了什么？只回答上一轮用户原文。`;
      result = await withTimeout(DEFAULT_TIMEOUT_MS, (signal) => input.runtime.invoke({
        agent,
        binding,
        prompt,
        signal,
      }));
      const cli = input.cliLog?.slice(beforeTurnCliCount).at(-1);
      const assistantPreview = compactText(result.content);
      turnResults.push({
        turn,
        effective: {
          provider: result.provider,
          model: result.model,
          thinking: result.thinking || undefined,
        },
        ...(cli ? { cli } : {}),
        assistantTextLength: result.content.trim().length,
        assistantPreview,
      });
      binding = {
        ...binding,
        piSessionId: result.piSessionId,
        sessionFile: result.sessionFile,
        provider: result.provider,
        model: result.model,
        thinking: result.thinking,
        updatedAt: new Date().toISOString(),
      };
    }
    const cliInvocations = input.cliLog?.slice(beforeCliCount) ?? [];
    const cli = cliInvocations.at(-1);
    const assistantPreview = compactText(result?.content);
    const ok = turnResults.length === input.turns && turnResults.every((turn) => (turn.assistantTextLength ?? 0) > 0);
    return {
      clientId: input.clientId,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      turns: input.turns,
      ok,
      requested: {
        provider: input.provider,
        model: input.model,
        thinking: input.thinking || undefined,
      },
      effective: {
        provider: result!.provider,
        model: result!.model,
        thinking: result!.thinking || undefined,
      },
      ...(cli ? { cli } : {}),
      ...(cliInvocations.length ? { cliInvocations } : {}),
      turnResults,
      assistantTextLength: result!.content.trim().length,
      assistantPreview,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const cliInvocations = input.cliLog?.slice(beforeCliCount) ?? [];
    const cli = cliInvocations.at(-1);
    return {
      clientId: input.clientId,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      turns: input.turns,
      ok: false,
      requested: {
        provider: input.provider,
        model: input.model,
        thinking: input.thinking || undefined,
      },
      ...(cli ? { cli } : {}),
      ...(cliInvocations.length ? { cliInvocations } : {}),
      ...(turnResults.length ? { turnResults } : {}),
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    };
  }
}

function matrixItems(capability: TeamRuntimeClientCapability): Array<{ option: TeamRuntimeModelOption; thinking: string }> {
  const items: Array<{ option: TeamRuntimeModelOption; thinking: string }> = [];
  for (const option of capability.modelOptions) {
    for (const thinking of option.thinkingLevels) items.push({ option, thinking });
  }
  return items;
}

async function main(): Promise<void> {
  const { clients, keepSessions, turns, refs, thinking: thinkingFilter } = parseArgs();
  const cwd = process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const sessionRoot = mkdtempSync(join(tmpdir(), "pi-team-capability-probe-"));
  const cliLog: CliInvocation[] = [];
  const spawnFn: SpawnFunction = ((command: string, args: string[], options: Parameters<SpawnFunction>[2]) => {
    const reasoningIndex = args.indexOf("--reasoning-effort");
    const claudeEffortIndex = args.indexOf("--effort");
    const codexConfigIndex = args.indexOf("-c");
    const codexConfig = codexConfigIndex >= 0 ? args[codexConfigIndex + 1] : undefined;
    cliLog.push({
      command,
      args: [...args],
      cwd: options?.cwd === undefined ? undefined : String(options.cwd),
      kimiThinkingEffort: options?.env?.KIMI_MODEL_THINKING_EFFORT,
      httpProxy: options?.env?.HTTP_PROXY,
      reasoningEffort: reasoningIndex >= 0 ? args[reasoningIndex + 1] : undefined,
      claudeThinkingEffort: claudeEffortIndex >= 0 ? args[claudeEffortIndex + 1] : undefined,
      codexThinkingEffort: codexConfig?.match(/^model_reasoning_effort="([^"]+)"$/)?.[1],
    });
    return spawn(command, args, options);
  }) as SpawnFunction;

  const piOptions = await loadPiModelOptions(agentDir);
  const capabilities = buildRuntimeCapabilities(piOptions);
  const piRuntime = new PiAgentRuntime({
    sessionDir: join(sessionRoot, "pi"),
    agentDir,
    idleTimeoutMs: 1,
  });
  const cliRuntime = new PiAgentRuntime({
    sessionDir: join(sessionRoot, "cli"),
    agentDir,
    idleTimeoutMs: 1,
    spawnFn,
  });
  const records: ProbeRecord[] = [];

  console.log(JSON.stringify({
    type: "capability_probe_start",
    cwd,
    agentDir,
    sessionRoot,
    prompt: PROBE_PROMPT,
      clients,
      turns,
      refs: [...refs],
      thinking: thinkingFilter,
      piModels: piOptions.map((option) => `${option.provider}/${option.model}`),
      kimiModels: KIMI_CLI_MODEL_OPTIONS.map((option) => `${option.provider}/${option.model}`),
      claudeModels: CLAUDE_CODE_CLI_MODEL_OPTIONS.map((option) => `${option.provider}/${option.model}`),
      codexModels: CODEX_CLI_MODEL_OPTIONS.map((option) => `${option.provider}/${option.model}`),
      grokBuildModels: GROK_BUILD_CLI_MODEL_OPTIONS.map((option) => `${option.provider}/${option.model}`),
      grokPiModels: GROK_PI_MODEL_OPTIONS.map((option) => `${option.provider}/${option.model}`),
  }));

  try {
    for (const capability of capabilities) {
      if (!isProbeClient(capability.clientId)) continue;
      if (!clients.includes(capability.clientId)) continue;
      for (const { option, thinking } of matrixItems(capability)) {
        const ref = `${option.provider}/${option.model}`.toLocaleLowerCase();
        if (refs.size > 0 && !refs.has(ref)) continue;
        if (thinkingFilter !== undefined && thinking !== thinkingFilter) continue;
        const runtime = capability.clientId === "pi" || capability.clientId === "grok-pi" ? piRuntime : cliRuntime;
        const record = await runProbe({
          runtime,
          cwd,
          clientId: capability.clientId,
          provider: option.provider,
          model: option.model,
          thinking,
          turns,
          cliLog: capability.clientId === "pi" || capability.clientId === "grok-pi" ? undefined : cliLog,
        });
        records.push(record);
        console.log(JSON.stringify({
          type: "capability_probe_result",
          ...record,
          runtimeModelKey: runtimeModelKey({
            clientId: option.clientId,
            provider: option.provider,
            model: option.model,
            thinking,
          }),
          expectedKimiThinkingEffort: capability.clientId === "kimi-code" ? kimiThinkingEffort(thinking) : undefined,
          expectedClaudeThinkingEffort: capability.clientId === "claude-code" ? claudeThinkingEffort(thinking) : undefined,
          expectedCodexThinkingEffort: capability.clientId === "codex-cli" ? codexThinkingEffort(thinking) : undefined,
          expectedGrokReasoningEffort: capability.clientId === "grok-build" ? thinking || undefined : undefined,
        }));
      }
    }
  } finally {
    await piRuntime.dispose();
    await cliRuntime.dispose();
    if (!keepSessions) rmSync(sessionRoot, { recursive: true, force: true });
  }

  const failed = records.filter((record) => !record.ok);
  const summary = {
    type: "capability_probe_summary",
    ok: failed.length === 0,
    total: records.length,
    passed: records.length - failed.length,
    failed: failed.length,
    failures: failed.map((record) => ({
      clientId: record.clientId,
      provider: record.provider,
      model: record.model,
      thinking: record.thinking,
      turns: record.turns,
      error: record.error,
    })),
  };
  console.log(JSON.stringify(summary));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
