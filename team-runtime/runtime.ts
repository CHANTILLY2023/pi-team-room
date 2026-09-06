import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeRuntimeClientId, RuntimeCapabilityDiscovery, type RuntimeCliModelOptions } from "./capabilities.ts";
import {
  ClaudeCodeCliRuntimeAdapter,
  CodexCliRuntimeAdapter,
  GrokBuildCliRuntimeAdapter,
  isCliSessionMarker,
  KimiCodeCliRuntimeAdapter,
  PiWebAgentRuntimeAdapter,
  type AgentRuntimeProviderAdapter,
  type SpawnFunction,
} from "./providers/adapters.ts";
import type { PersistentAgent, SessionBinding, TurnControl } from "./types.ts";
import { collectTurnProcess, type ProcessCapture } from "./process-history.ts";

export interface AgentRuntimeResult {
  content: string;
  control?: TurnControl;
  piSessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  thinking?: string;
  process?: ProcessCapture;
}

export interface AgentRuntimeRequest {
  agent: PersistentAgent;
  binding: SessionBinding;
  prompt: string;
  signal?: AbortSignal;
  onProcess?: (capture: ProcessCapture) => void;
}

export interface AgentRuntimeSession {
  piSessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  thinking?: string;
  runtimeConfigKey?: string;
  modelRef?: string;
  contextReset?: boolean;
}

export interface AgentRuntime {
  /**
   * Open/create the exact physical session before model work begins. The
   * coordinator persists this result first, closing the crash window where a
   * PI JSONL exists but only a provisional binding survives in SQLite.
   */
  prepare?(request: Omit<AgentRuntimeRequest, "prompt">): Promise<AgentRuntimeSession>;
  invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
  dispose?(threadId?: string, agentId?: string): Promise<void> | void;
}

interface LiveSession {
  session: AgentSession;
  lastUsedAt: number;
  runtimePolicy: PersistentAgent["runtimePolicy"];
  configKey: string;
}

export interface PiAgentRuntimeOptions {
  cliModelOptions?: RuntimeCliModelOptions;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  sessionDir: string;
  idleTimeoutMs?: number;
  systemPrompt?: (agent: PersistentAgent) => string;
  customTools?: (agent: PersistentAgent, binding: SessionBinding) => ToolDefinition[];
  kimiCommand?: string;
  claudeCommand?: string;
  codexCommand?: string;
  grokCommand?: string;
  grokProxyAvailable?: () => boolean | Promise<boolean>;
  spawnFn?: SpawnFunction;
  usePiWebForPiAgents?: boolean;
  piWebBaseUrl?: string;
  piWebPollMs?: number;
  piWebIdleTimeoutMs?: number;
  /** Extra or overriding non-PI runtime adapters keyed by clientId. */
  providerAdapters?: AgentRuntimeProviderAdapter[];
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } => (
      !!part && typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n")
    .trimEnd();
}

function lastAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = textFromMessage(messages[index]);
    if (text) return text;
  }
  return "";
}

function sessionKey(binding: SessionBinding): string {
  return `${binding.threadId}:${binding.agentId}`;
}

function agentConfigKey(agent: PersistentAgent): string {
  return JSON.stringify({
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    thinking: agent.thinking,
    skillPaths: agent.skillPaths,
    clientId: agent.clientId,
    roleProfile: agent.roleProfile,
    rolePrompt: agent.rolePrompt,
    runtimePolicy: agent.runtimePolicy,
  });
}

function safeSessionPathSegment(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== "." && value !== "..") return value;
  return `id-${Buffer.from(value, "utf8").toString("base64url")}`;
}

function assertSessionPathInside(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const fromRoot = relative(absoluteRoot, absolutePath);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error(`PI session file must stay inside ${absoluteRoot}`);
  }
  return absolutePath;
}

/**
 * Runs persistent logical members as isolated PI AgentSession instances.
 * The coordinator owns durability; this class only owns hot runtime instances.
 */
export class PiAgentRuntime implements AgentRuntime {
  private readonly live = new Map<string, LiveSession>();
  private readonly providerAdapters: Map<string, AgentRuntimeProviderAdapter>;
  private readonly piProviderAdapter?: AgentRuntimeProviderAdapter;
  private modelRuntime?: ModelRuntime;
  private readonly capabilityDiscovery = new RuntimeCapabilityDiscovery();

  constructor(private readonly options: PiAgentRuntimeOptions) {
    this.piProviderAdapter = options.usePiWebForPiAgents
      ? new PiWebAgentRuntimeAdapter({
          baseUrl: options.piWebBaseUrl,
          pollMs: options.piWebPollMs,
          idleTimeoutMs: options.piWebIdleTimeoutMs,
        })
      : undefined;
    const providerAdapters = [
      new KimiCodeCliRuntimeAdapter(options),
      new ClaudeCodeCliRuntimeAdapter(options),
      new CodexCliRuntimeAdapter(options),
      new GrokBuildCliRuntimeAdapter(options),
      ...(options.providerAdapters ?? []),
    ];
    this.providerAdapters = new Map(
      providerAdapters.map((adapter): [string, AgentRuntimeProviderAdapter] => [adapter.clientId, adapter]),
    );
  }

  async prepare(request: Omit<AgentRuntimeRequest, "prompt">): Promise<AgentRuntimeSession> {
    request.signal?.throwIfAborted();
    const clientId = normalizeRuntimeClientId(request.agent.clientId);
    const options = this.options.cliModelOptions ?? this.capabilityDiscovery.discover(this.options.env ?? process.env, clientId);
    const option = options[clientId]?.find(option => request.agent.model === "default" ? option.isDefault || option.model === "default" : option.provider === request.agent.provider && option.model === request.agent.model);
    const effectiveAgent = { ...request.agent, thinking: request.agent.thinking || option?.thinking };
    const adapter = this.providerAdapterFor(effectiveAgent);
    const kind = adapter?.clientId ?? "pi-sdk";
    const runtimeConfigKey = JSON.stringify({ kind, clientId: request.agent.clientId ?? "pi", provider: request.agent.provider, model: request.agent.model, thinking: request.agent.thinking ?? "", effectiveThinking: effectiveAgent.thinking, nativeModelRef: option?.modelRef, fingerprint: this.capabilityDiscovery.fingerprint(clientId) });
    const binding = request.binding;
    const expectedMarker = ({ "pi-web": "pi-web-session:", "kimi-code": "kimi-session:", "claude-code": "claude-session:", "codex-cli": "codex-session:", "grok-build": "grok-session:" } as Record<string, string>)[kind];
    const legacyCompatible = binding.provider === request.agent.provider && binding.model === request.agent.model && binding.thinking === effectiveAgent.thinking &&
      (!binding.sessionFile || (expectedMarker ? binding.sessionFile.startsWith(expectedMarker) : !isCliSessionMarker(binding.sessionFile)));
    const reset = binding.contextInitialized === false || (binding.runtimeConfigKey ? binding.runtimeConfigKey !== runtimeConfigKey : !legacyCompatible);
    if (reset) await this.dispose(binding.threadId, binding.agentId);
    const nextBinding = { ...(reset ? { ...binding, piSessionId: randomUUID(), sessionFile: undefined } : binding), modelRef: option?.modelRef };
    const prepared = adapter
      ? await adapter.prepare({ ...request, agent: effectiveAgent, binding: nextBinding })
      : this.describe((await this.ensureLive(effectiveAgent, nextBinding)).session, effectiveAgent);
    request.signal?.throwIfAborted();
    return { ...prepared, runtimeConfigKey, modelRef: option?.modelRef, contextReset: reset || !binding.sessionFile };
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("Invocation aborted");
    if (request.binding.runtimeConfigKey) request = { ...request, agent: { ...request.agent, thinking: request.binding.thinking } };
    const adapter = this.providerAdapterFor(request.agent);
    if (adapter) return adapter.invoke(request);
    const key = sessionKey(request.binding);
    const live = await this.ensureLive(request.agent, request.binding);

    if (!live.session.isIdle) throw new Error(`PI session is busy for ${request.binding.threadId}/${request.agent.id}`);
    const abort = () => { void live!.session.abort(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    let unsubscribe: (() => void) | undefined;
    let processError: unknown;
    try {
      const beforeMessages = live.session.messages;
      const beforeMessageCount = beforeMessages.length;
      const beforeAssistantText = lastAssistantText(beforeMessages);
      if (request.onProcess) {
        request.onProcess({ data: collectTurnProcess([], "partial", "runtime"), sessionFile: live.session.sessionFile, messageStart: beforeMessageCount });
        let lastCapture = 0;
        unsubscribe = live.session.subscribe(event => {
          if (processError || request.signal?.aborted) return;
          if (event.type !== "message_end" && Date.now() - lastCapture < 500) return;
          lastCapture = Date.now();
          const messages = live.session.messages.slice(beforeMessageCount);
          if (event.type === "message_update" && !messages.includes(event.message)) messages.push(event.message);
          try {
            request.onProcess!({ data: collectTurnProcess(messages, "partial", "runtime"), sessionFile: live.session.sessionFile, messageStart: beforeMessageCount });
          } catch (error) { processError = error; abort(); }
        });
      }
      await live.session.prompt(request.prompt, { source: "extension" });
      await live.session.waitForIdle();
      if (processError) throw processError;
      live.lastUsedAt = Date.now();
      const afterMessages = live.session.messages;
      const appendedMessages = afterMessages.length > beforeMessageCount
        ? afterMessages.slice(beforeMessageCount)
        : [];
      let content = lastAssistantText(appendedMessages);
      if (!content) {
        const afterAssistantText = lastAssistantText(afterMessages);
        if (afterAssistantText && afterAssistantText !== beforeAssistantText) content = afterAssistantText;
      }
      if (!content) throw new Error(`PI agent ${request.agent.name} completed without assistant text`);
      this.pruneIdle();
      const result = {
        content,
        ...this.describe(live.session, request.agent),
        process: { data: collectTurnProcess(appendedMessages, "complete", "runtime"), sessionFile: live.session.sessionFile, messageStart: beforeMessageCount },
      };
      if (request.agent.runtimePolicy === "on_demand") {
        live.session.dispose();
        this.live.delete(key);
      }
      return result;
    } finally {
      unsubscribe?.();
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private providerAdapterFor(agent: PersistentAgent): AgentRuntimeProviderAdapter | undefined {
    const rawClientId = agent.clientId?.trim();
    if (!rawClientId || rawClientId === "pi") return this.piProviderAdapter;
    const normalizedClientId = normalizeRuntimeClientId(rawClientId);
    if (normalizedClientId === "grok-pi" || normalizedClientId === "kimi-pi") return this.piProviderAdapter;
    if (normalizedClientId === "kimi-code" || normalizedClientId === "claude-code" || normalizedClientId === "codex-cli" || normalizedClientId === "grok-build") {
      return this.providerAdapters.get(normalizedClientId);
    }
    return this.providerAdapters.get(rawClientId);
  }

  private async ensureLive(agent: PersistentAgent, binding: SessionBinding): Promise<LiveSession> {
    const key = sessionKey(binding);
    const configKey = agentConfigKey(agent);
    let live = this.live.get(key);
    if (live && live.configKey !== configKey) {
      if (!live.session.isIdle) {
        throw new Error(`Cannot reconfigure busy PI session ${binding.threadId}/${agent.id}`);
      }
      live.session.dispose();
      this.live.delete(key);
      live = undefined;
    }
    if (!live) {
      live = {
        session: await this.open(agent, binding),
        lastUsedAt: Date.now(),
        runtimePolicy: agent.runtimePolicy,
        configKey,
      };
      this.live.set(key, live);
    }
    return live;
  }

  private describe(session: AgentSession, agent: PersistentAgent): AgentRuntimeSession {
    return {
      piSessionId: session.sessionId,
      sessionFile: session.sessionFile,
      provider: session.model?.provider ?? agent.provider,
      model: session.model?.id ?? agent.model,
      thinking: session.thinkingLevel,
    };
  }

  async dispose(threadId?: string, agentId?: string): Promise<void> {
    for (const [key, live] of this.live) {
      const matches = (!threadId || key.startsWith(`${threadId}:`)) && (!agentId || key.endsWith(`:${agentId}`));
      if (!matches) continue;
      live.session.dispose();
      this.live.delete(key);
    }
    for (const adapter of this.providerAdapters.values()) await adapter.dispose?.(threadId, agentId);
  }

  private async open(agent: PersistentAgent, binding: SessionBinding): Promise<AgentSession> {
    // Bind logical IDs to one filesystem component even when opening a binding
    // imported from an older or externally edited coordinator database.
    const agentSessionDir = join(
      this.options.sessionDir,
      safeSessionPathSegment(binding.threadId),
      safeSessionPathSegment(binding.agentId),
    );
    const defaultSessionPath = join(agentSessionDir, `${safeSessionPathSegment(binding.piSessionId)}.jsonl`);
    const storedSessionFile = isCliSessionMarker(binding.sessionFile) ? undefined : binding.sessionFile;
    const sessionPath = assertSessionPathInside(
      this.options.sessionDir,
      storedSessionFile ?? defaultSessionPath,
    );
    mkdirSync(dirname(sessionPath), { recursive: true });
    if (!existsSync(sessionPath)) {
      // SessionManager.open() turns an existing empty file into a valid PI
      // session and flushes its header immediately. The fixed path is derived
      // from the durable binding, so a crash before prepare() returns cannot
      // orphan a timestamp-named session or create a second identity.
      try { closeSync(openSync(sessionPath, "wx")); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const sessionManager = SessionManager.open(sessionPath, agentSessionDir, binding.cwd);

    const agentDir = this.options.agentDir;
    const settingsManager = agentDir
      ? SettingsManager.create(binding.cwd, agentDir)
      : SettingsManager.create(binding.cwd);
    this.modelRuntime ??= await ModelRuntime.create({
      ...(agentDir ? { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") } : {}),
    });
    const model = this.modelRuntime.getModel(agent.provider, agent.model);
    if (!model) throw new Error(`Unknown PI model ${agent.provider}/${agent.model} for ${agent.name}`);

    const resourceLoader = new DefaultResourceLoader({
      cwd: binding.cwd,
      agentDir: agentDir ?? join(binding.cwd, ".pi-agent"),
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: agent.skillPaths,
      systemPrompt: this.options.systemPrompt?.(agent) ?? [
        `You are ${agent.name}, a persistent member of a multi-agent PI team.`,
        "Answer the routed team message as this member. Do not impersonate other members.",
        "Your final answer is appended to the shared canonical thread and is visible to the team unless marked private.",
      ].join("\n"),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: binding.cwd,
      ...(agentDir ? { agentDir } : {}),
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: (agent.thinking || undefined) as ThinkingLevel | undefined,
      sessionManager,
      settingsManager,
      resourceLoader,
      customTools: this.options.customTools?.(agent, binding),
      sessionStartEvent: { type: "session_start", reason: storedSessionFile ? "resume" : "startup" },
    });
    return session;
  }

  private pruneIdle(): void {
    const timeout = this.options.idleTimeoutMs;
    if (!timeout || timeout <= 0) return;
    const cutoff = Date.now() - timeout;
    for (const [key, live] of this.live) {
      if (live.runtimePolicy !== "idle_timeout" || !live.session.isIdle || live.lastUsedAt > cutoff) continue;
      live.session.dispose();
      this.live.delete(key);
    }
  }
}
