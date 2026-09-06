import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConnectorCommand } from "../capabilities.ts";
import { grokRuntimeEnv } from "../grok-proxy.ts";
import { piWebJson, redactRuntimeError } from "../pi-web-http.ts";
import { collectTurnProcess, readPiWebHistory } from "../process-history.ts";
import { openKimiAcp } from "./kimi-acp.ts";
import { AcpTurnProcess, acpNotification, grokTextUpdate } from "./acp-process.ts";
import { readNativeProcessTurns } from "../native-process-history.ts";
import type { AgentRuntimeRequest, AgentRuntimeResult, AgentRuntimeSession } from "../runtime.ts";
import type { PersistentAgent, SessionBinding } from "../types.ts";

export const GROK_SESSION_FILE_PREFIX = "grok-session:";
export const KIMI_SESSION_FILE_PREFIX = "kimi-session:";
export const CLAUDE_SESSION_FILE_PREFIX = "claude-session:";
export const CODEX_SESSION_FILE_PREFIX = "codex-session:";
export const PI_WEB_SESSION_FILE_PREFIX = "pi-web-session:";

export type RuntimePrepareRequest = Omit<AgentRuntimeRequest, "prompt">;
export type SpawnFunction = typeof spawn;

export interface AgentRuntimeProviderAdapter {
  readonly clientId: string;
  prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession>;
  invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
  dispose?(threadId?: string, agentId?: string): Promise<void> | void;
}

export interface RuntimeCliAdapterOptions {
  kimiCommand?: string;
  claudeCommand?: string;
  codexCommand?: string;
  grokCommand?: string;
  grokProxyAvailable?: () => boolean | Promise<boolean>;
  spawnFn?: SpawnFunction;
}

export interface PromptCliInput {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  signal?: AbortSignal;
  agentName: string;
  displayName: string;
  spawnFn?: SpawnFunction;
  onStdout?: (chunk: string) => void;
}

export function kimiThinkingEffort(thinking: string | undefined): string | undefined {
  switch (thinking) {
    case undefined:
    case "":
      return undefined;
    case "off":
    case "low":
    case "high":
    case "max":
      return thinking;
    case "minimal":
      return "low";
    case "medium":
      return "high";
    case "xhigh":
      return "max";
    default:
      return thinking;
  }
}

export function claudeThinkingEffort(thinking: string | undefined): string | undefined {
  switch (thinking) {
    case undefined:
    case "":
    case "off":
      return undefined;
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultracode":
      return thinking;
    default:
      return thinking;
  }
}

export function codexThinkingEffort(thinking: string | undefined): string | undefined {
  switch (thinking) {
    case undefined:
    case "":
    case "off":
      return undefined;
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return thinking;
    case "ultracode":
      return "ultra";
    default:
      return thinking;
  }
}

export function cliSessionIdFromMarker(value: string | undefined, prefix: string): string | undefined {
  return value?.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

export function isCliSessionMarker(value: string | undefined): boolean {
  return !!value && (
    value.startsWith(GROK_SESSION_FILE_PREFIX) ||
    value.startsWith(KIMI_SESSION_FILE_PREFIX) ||
    value.startsWith(CLAUDE_SESSION_FILE_PREFIX) ||
    value.startsWith(CODEX_SESSION_FILE_PREFIX) ||
    value.startsWith(PI_WEB_SESSION_FILE_PREFIX)
  );
}

export function piWebSessionIdFromMarker(value: string | undefined): string | undefined {
  return value?.startsWith(PI_WEB_SESSION_FILE_PREFIX) ? value.slice(PI_WEB_SESSION_FILE_PREFIX.length) : undefined;
}

export function withoutCliProxyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    delete env[key];
  }
  return env;
}

function describeCliBinding(agent: PersistentAgent, binding: SessionBinding): AgentRuntimeSession {
  return {
    piSessionId: binding.piSessionId,
    sessionFile: binding.sessionFile,
    provider: agent.provider,
    model: agent.model,
    thinking: agent.thinking,
  };
}

export interface PiWebRuntimeAdapterOptions {
  baseUrl?: string;
  pollMs?: number;
  idleTimeoutMs?: number;
}

interface PiWebSessionStatus {
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  isBashRunning?: boolean;
  pendingMessageCount?: number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromPiWebMessage(message: unknown): string {
  if (!isRecord(message)) return "";
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trimEnd();
  if (!Array.isArray(content)) return stringValue(message.text)?.trimEnd() ?? "";
  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trimEnd();
}

function lastAssistantTextFromPiWebMessages(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = textFromPiWebMessage(messages[index]);
    if (text) return text;
  }
  return "";
}

function piWebBusy(status: PiWebSessionStatus): boolean {
  return status.isStreaming === true ||
    status.isCompacting === true ||
    status.isBashRunning === true ||
    (status.pendingMessageCount ?? 0) > 0;
}

function abortReason(signal: AbortSignal | undefined, fallback: string): unknown {
  return signal?.reason ?? new Error(fallback);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal, "PI Web runtime aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, "PI Web runtime aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class PiWebAgentRuntimeAdapter implements AgentRuntimeProviderAdapter {
  readonly clientId = "pi-web";
  private readonly baseUrl: string;
  private readonly pollMs: number;
  private readonly idleTimeoutMs: number;
  private readonly appliedConfigBySession = new Map<string, string>();

  constructor(options: PiWebRuntimeAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.PI_TEAM_PI_WEB_URL ?? process.env.PI_WEB_URL ?? "http://127.0.0.1:8504").replace(/\/+$/, "");
    this.pollMs = Math.max(10, options.pollMs ?? 250);
    this.idleTimeoutMs = Math.max(1_000, options.idleTimeoutMs ?? 30 * 60_000);
  }

  async prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession> {
    request.signal?.throwIfAborted();
    const sessionId = piWebSessionIdFromMarker(request.binding.sessionFile) ?? await this.createSession(request.binding.cwd, request.signal);
    await this.applyConfig(sessionId, request.agent, request.binding.cwd, request.signal);
    const status = await this.getStatus(sessionId, request.binding.cwd, request.signal);
    return { ...this.describe(sessionId, request.agent), thinking: status.thinkingLevel ?? request.agent.thinking };
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const existingSessionId = piWebSessionIdFromMarker(request.binding.sessionFile);
    if (existingSessionId) await this.applyConfig(existingSessionId, request.agent, request.binding.cwd, request.signal);
    const prepared = existingSessionId
      ? this.describe(existingSessionId, request.agent)
      : await this.prepare(request);
    const sessionId = prepared.piSessionId;
    const beforeMessages = await this.listMessages(sessionId, request.binding.cwd, request.signal);
    const captureProcess = async () => {
      // Capture belongs to the invocation's absolute message interval, not to
      // whichever browser happens to be following the physical session.
      const history = await readPiWebHistory(this.baseUrl, sessionId, request.binding.cwd, { after: beforeMessages.total, signal: request.signal });
      const stream = await this.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/stream-snapshot?cwd=${encodeURIComponent(request.binding.cwd)}`, request.signal);
      const partial = isRecord(stream) && isRecord(stream.partial) ? [stream.partial] : [];
      return { data: collectTurnProcess([...history.messages, ...partial], "partial", "runtime"), sessionFile: prepared.sessionFile, messageStart: beforeMessages.total };
    };
    let lastCapture = 0;
    const observe = request.onProcess ? async () => {
      if (Date.now() - lastCapture < 1_000) return;
      lastCapture = Date.now();
      // A transient history read must not cancel model work. The final capture
      // is required below; failed reads never replace previously saved data.
      const capture = await captureProcess().catch(() => undefined);
      if (capture) request.onProcess!(capture);
    } : undefined;
    let stop: Promise<unknown> | undefined;
    const stopOnAbort = () => {
      stop ??= piWebJson(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/stop`, { body: { cwd: request.binding.cwd }, timeoutMs: 3_000 }).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal?.aborted) throw abortReason(request.signal, "PI Web runtime aborted");
      request.onProcess?.({ data: collectTurnProcess([], "partial", "runtime"), sessionFile: prepared.sessionFile, messageStart: beforeMessages.total });
      await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        cwd: request.binding.cwd,
        text: request.prompt,
      }, request.signal);
      await this.waitForIdle(sessionId, request.binding.cwd, request.signal, observe);
      const afterMessages = request.onProcess
        ? await readPiWebHistory(this.baseUrl, sessionId, request.binding.cwd, { after: beforeMessages.total, signal: request.signal })
        : await this.listMessages(sessionId, request.binding.cwd, request.signal);
      const appendedMessages = afterMessages.messages.slice(Math.max(0, beforeMessages.total - afterMessages.start));
      const content = lastAssistantTextFromPiWebMessages(appendedMessages);
      const failed = appendedMessages.find(message => isRecord(message) && message.role === "assistant" && typeof message.errorMessage === "string");
      if (isRecord(failed)) throw new Error(redactRuntimeError(String(failed.errorMessage)).slice(0, 400));
      if (!content) throw new Error(`PI Web session ${sessionId} returned no assistant text for ${request.agent.name}`);
      return {
        content,
        ...prepared,
        process: { data: collectTurnProcess(appendedMessages, "complete", "runtime"), sessionFile: prepared.sessionFile, messageStart: beforeMessages.total },
      };
    } catch (error) {
      stopOnAbort();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", stopOnAbort);
      await stop;
    }
  }

  private describe(sessionId: string, agent: PersistentAgent): AgentRuntimeSession {
    return {
      piSessionId: sessionId,
      sessionFile: `${PI_WEB_SESSION_FILE_PREFIX}${sessionId}`,
      provider: agent.provider,
      model: agent.model,
      thinking: agent.thinking,
    };
  }

  private async createSession(cwd: string, signal?: AbortSignal): Promise<string> {
    const response = await this.postJson("/api/sessions", { cwd }, signal);
    const id = isRecord(response) ? stringValue(response.id) ?? stringValue(response.sessionId) : undefined;
    if (!id) throw new Error("PI Web did not return a session id");
    return id;
  }

  private async applyConfig(sessionId: string, agent: PersistentAgent, cwd: string, signal?: AbortSignal): Promise<void> {
    const configKey = JSON.stringify({
      cwd,
      provider: agent.provider,
      model: agent.model,
      thinking: agent.thinking ?? "",
    });
    if (this.appliedConfigBySession.get(sessionId) === configKey) return;
    await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      cwd,
      provider: agent.provider,
      modelId: agent.model,
    }, signal);
    if (agent.thinking) {
      await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/thinking-level`, {
        cwd,
        level: agent.thinking,
      }, signal);
    }
    this.appliedConfigBySession.set(sessionId, configKey);
    if (this.appliedConfigBySession.size > 256) this.appliedConfigBySession.delete(this.appliedConfigBySession.keys().next().value!);
  }

  dispose(): void { this.appliedConfigBySession.clear(); }

  private async waitForIdle(sessionId: string, cwd: string, signal: AbortSignal | undefined, observe?: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + this.idleTimeoutMs;
    while (Date.now() <= deadline) {
      if (signal?.aborted) throw abortReason(signal, "PI Web runtime aborted");
      const status = await this.getStatus(sessionId, cwd, signal);
      if (!piWebBusy(status)) return;
      await observe?.();
      await sleep(this.pollMs, signal);
    }
    throw new Error(`PI Web session ${sessionId} did not become idle within ${this.idleTimeoutMs}ms`);
  }

  private async getStatus(sessionId: string, cwd: string, signal?: AbortSignal): Promise<PiWebSessionStatus> {
    const value = await this.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/status?cwd=${encodeURIComponent(cwd)}`, signal);
    return isRecord(value) ? value : {};
  }

  private async listMessages(sessionId: string, cwd: string, signal?: AbortSignal): Promise<{ messages: unknown[]; start: number; total: number }> {
    const value = await this.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages?cwd=${encodeURIComponent(cwd)}&limit=200`, signal);
    if (Array.isArray(value)) return { messages: value, start: 0, total: value.length };
    if (isRecord(value) && Array.isArray(value.messages)) {
      const start = typeof value.start === "number" ? value.start : 0;
      return { messages: value.messages, start, total: typeof value.total === "number" ? value.total : start + value.messages.length };
    }
    throw new Error("Invalid PI Web messages response");
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return piWebJson(`${this.baseUrl}${path}`, { signal });
  }

  private async postJson(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return piWebJson(`${this.baseUrl}${path}`, { body, signal });
  }
}

export async function invokePromptCli(input: PromptCliInput): Promise<string> {
  const raw = await invokePromptCliRaw(input);
  const text = raw.stdout.trim();
  if (!text) throw new Error(`${input.displayName} returned no output for ${input.agentName}`);
  return text;
}

export async function invokePromptCliRaw(input: PromptCliInput): Promise<{ stdout: string; stderr: string }> {
  const options: SpawnOptionsWithoutStdio = {
    cwd: input.cwd,
    env: input.inheritEnv === false ? input.env : { ...process.env, ...input.env },
  };
  const spawnFn = input.spawnFn ?? spawn;

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawnFn(input.command, input.args, options);
    child.stdin?.end();
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      child.kill();
      settle(() => reject(input.signal?.reason ?? new Error(`${input.displayName} invocation aborted`)));
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      try { input.onStdout?.(chunk); } catch (error) { child.kill(); settle(() => reject(error)); }
    });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => {
      if (code === 0) {
        settle(() => stdout.trim() || stderr.trim()
          ? resolve({ stdout, stderr })
          : reject(new Error(`${input.displayName} returned no output for ${input.agentName}`)));
        return;
      }
      let detail = stderr.trim();
      if (!detail) {
        try { const result = JSON.parse(stdout); if (result.is_error && typeof result.result === "string") detail = result.result; } catch {}
      }
      const suffix = detail ? `: ${redactRuntimeError(detail).slice(0, 500)}` : signal ? ` (${signal})` : "";
      settle(() => reject(new Error(`${input.displayName} failed for ${input.agentName} with exit code ${code ?? "unknown"}${suffix}`)));
    });
    if (input.signal?.aborted) abort();
  });
}

export class GrokBuildCliRuntimeAdapter implements AgentRuntimeProviderAdapter {
  readonly clientId = "grok-build";

  constructor(private readonly options: RuntimeCliAdapterOptions) {}

  async prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession> {
    return describeCliBinding(request.agent, request.binding);
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const grokSessionId = request.binding.piSessionId;
    const firstTurn = request.binding.sessionFile !== `${GROK_SESSION_FILE_PREFIX}${grokSessionId}`;
    const args = request.agent.model === "default" ? [] : ["--model", request.agent.model];
    if (request.agent.thinking) args.push("--reasoning-effort", request.agent.thinking);
    if (firstTurn) args.push("--session-id", grokSessionId);
    else args.push("--resume", grokSessionId);
    args.push("-p", request.prompt, "--output-format", "streaming-json");
    const collector = new AcpTurnProcess();
    const sessionFile = `${GROK_SESSION_FILE_PREFIX}${grokSessionId}`;
    const beforeTurns = await readNativeProcessTurns(sessionFile, request.binding.cwd);
    let legacy = false;
    let legacyEnded = false;
    let unsupported = false;
    let pending = "";
    let lastSaved = 0;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const value: unknown = JSON.parse(line);
      const event = acpNotification(value);
      if (event && event.sessionId !== grokSessionId) return;
      let update = event?.update;
      if (!event && isRecord(value)) {
        update = grokTextUpdate(value, grokSessionId);
        if (update) legacy = true;
        else if (value.type === "end") {
          if (value.stopReason !== "end_turn") throw new Error(`Grok stopped before completion: ${String(value.stopReason)}`);
          legacyEnded = true;
        } else if (!["available_commands", "usage"].includes(String(value.type))) {
          unsupported = true;
          collector.beginToolBoundary();
        }
      }
      if (!update || !collector.update(update)) return;
      if (Date.now() - lastSaved >= 500) {
        request.onProcess?.({ data: collector.snapshot("partial"), sessionFile });
        lastSaved = Date.now();
      }
    };
    await invokePromptCliRaw({
      command: this.options.grokCommand ?? runtimeConnectorCommand("grok-build") ?? "grok",
      args,
      cwd: request.binding.cwd,
      env: await grokRuntimeEnv(process.env, this.options.grokProxyAvailable),
      inheritEnv: false,
      signal: request.signal,
      agentName: request.agent.name,
      displayName: "Grok Build CLI",
      spawnFn: this.options.spawnFn,
      onStdout: chunk => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); consume(line); }
      },
    });
    consume(pending);
    const turns = legacy ? await readNativeProcessTurns(sessionFile, request.binding.cwd) : [];
    const native = turns.length > beforeTurns.length && turns.at(-1)?.prompt === request.prompt ? turns.at(-1) : undefined;
    if (legacy && !native && (!legacyEnded || unsupported)) throw new Error("Grok legacy output requires a complete invocation-bound native history");
    const content = (native ? native.finalText ?? "" : collector.finalText).trimEnd();
    if (!content.trim()) throw new Error(`Grok Build CLI returned no final assistant text for ${request.agent.name}`);

    return {
      content,
      piSessionId: request.binding.piSessionId,
      sessionFile,
      process: { data: native?.data ?? collector.snapshot("complete"), sessionFile },
      provider: request.agent.provider,
      model: request.agent.model,
      thinking: request.agent.thinking,
    };
  }
}

export { GrokBuildCliRuntimeAdapter as GrokCliRuntimeAdapter };

export class KimiCodeCliRuntimeAdapter implements AgentRuntimeProviderAdapter {
  readonly clientId = "kimi-code";
  private readonly live = new Map<string, Awaited<ReturnType<typeof openKimiAcp>>>();

  constructor(private readonly options: RuntimeCliAdapterOptions) {}

  async prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession> {
    const key = `${request.binding.threadId}:${request.agent.id}`;
    const model = request.binding.modelRef ?? `${request.agent.provider}/${request.agent.model}`;
    const existingSessionId = cliSessionIdFromMarker(request.binding.sessionFile, KIMI_SESSION_FILE_PREFIX);
    const effort = request.agent.provider === "kimi-code" ? kimiThinkingEffort(request.agent.thinking) : request.agent.thinking;
    const previous = this.live.get(key);
    if (previous) await previous.close();
    this.live.delete(key);
    const live = await openKimiAcp({
      command: this.options.kimiCommand ?? runtimeConnectorCommand("kimi-code") ?? "kimi",
      cwd: request.binding.cwd,
      env: withoutCliProxyEnv(process.env),
      signal: request.signal,
      spawnFn: this.options.spawnFn,
      sessionId: existingSessionId,
      model: request.agent.model === "default" ? undefined : model,
      thinking: effort,
    });
    this.live.set(key, live);
    return {
      piSessionId: live.sessionId,
      sessionFile: `${KIMI_SESSION_FILE_PREFIX}${live.sessionId}`,
      provider: request.agent.provider,
      model: request.agent.model,
      thinking: live.thinking,
    };
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const key = `${request.binding.threadId}:${request.agent.id}`;
    if (!this.live.has(key)) await this.prepare(request);
    const live = this.live.get(key)!;
    try {
      const sessionFile = `${KIMI_SESSION_FILE_PREFIX}${live.sessionId}`;
      let lastSaved = 0;
      const content = await live.prompt(request.prompt, request.signal, data => {
        if (Date.now() - lastSaved < 500) return;
        request.onProcess?.({ data, sessionFile });
        lastSaved = Date.now();
      });
      return { content, piSessionId: live.sessionId, sessionFile, provider: request.agent.provider, model: request.agent.model, thinking: live.thinking, process: { data: live.process, sessionFile } };
    } finally {
      if (this.live.get(key) === live) this.live.delete(key);
      await live.close();
    }
  }

  async dispose(threadId?: string, agentId?: string): Promise<void> {
    for (const [key, live] of this.live) {
      if (threadId && !key.startsWith(`${threadId}:`)) continue;
      if (agentId && key !== `${threadId}:${agentId}`) continue;
      this.live.delete(key);
      await live.close();
    }
  }
}

export class ClaudeCodeCliRuntimeAdapter implements AgentRuntimeProviderAdapter {
  readonly clientId = "claude-code";

  constructor(private readonly options: RuntimeCliAdapterOptions) {}

  async prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession> {
    return describeCliBinding(request.agent, request.binding);
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const existingSessionId = cliSessionIdFromMarker(request.binding.sessionFile, CLAUDE_SESSION_FILE_PREFIX);
    const args = request.agent.model === "default" ? [] : ["--model", request.agent.model];
    const effort = claudeThinkingEffort(request.agent.thinking);
    if (effort) args.push("--effort", effort);
    if (existingSessionId) args.push("--resume", existingSessionId);
    args.push("-p", request.prompt, "--output-format", "json");
    const raw = await invokePromptCliRaw({
      command: this.options.claudeCommand ?? runtimeConnectorCommand("claude-code") ?? "claude",
      args,
      cwd: request.binding.cwd,
      env: withoutCliProxyEnv(process.env),
      inheritEnv: false,
      signal: request.signal,
      agentName: request.agent.name,
      displayName: "Claude Code CLI",
      spawnFn: this.options.spawnFn,
    });
    const parsed = this.parseJson(raw.stdout, raw.stderr);
    const sessionId = parsed.sessionId ?? existingSessionId;
    if (!sessionId) throw new Error(`Claude Code CLI did not report a session id for ${request.agent.name}`);
    if (!parsed.content) throw new Error(`Claude Code CLI returned no assistant text for ${request.agent.name}`);

    return {
      content: parsed.content,
      piSessionId: sessionId,
      sessionFile: `${CLAUDE_SESSION_FILE_PREFIX}${sessionId}`,
      provider: request.agent.provider,
      model: request.agent.model,
      thinking: request.agent.thinking,
    };
  }

  private parseJson(stdout: string, stderr: string): { content: string; sessionId?: string } {
    const text = stdout.trim() || stderr.trim();
    if (!text) return { content: "" };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { content: text };
    }
    if (!value || typeof value !== "object") return { content: text };
    const output = value as {
      result?: unknown;
      content?: unknown;
      session_id?: unknown;
      sessionId?: unknown;
      error?: unknown;
      is_error?: unknown;
    };
    if (output.is_error && typeof output.error === "string") throw new Error(output.error);
    const content = typeof output.result === "string"
      ? output.result
      : typeof output.content === "string"
        ? output.content
        : "";
    const sessionId = typeof output.session_id === "string"
      ? output.session_id
      : typeof output.sessionId === "string"
        ? output.sessionId
        : undefined;
    return { content: content.trimEnd(), sessionId };
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export class CodexCliRuntimeAdapter implements AgentRuntimeProviderAdapter {
  readonly clientId = "codex-cli";

  constructor(private readonly options: RuntimeCliAdapterOptions) {}

  async prepare(request: RuntimePrepareRequest): Promise<AgentRuntimeSession> {
    return describeCliBinding(request.agent, request.binding);
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const existingSessionId = cliSessionIdFromMarker(request.binding.sessionFile, CODEX_SESSION_FILE_PREFIX);
    const outputDir = mkdtempSync(join(tmpdir(), "pi-team-codex-cli-"));
    const outputFile = join(outputDir, "last-message.txt");
    try {
      const args = ["exec"];
      if (existingSessionId) args.push("resume");
      if (request.agent.model && request.agent.model !== "default") args.push("--model", request.agent.model);
      const effort = codexThinkingEffort(request.agent.thinking);
      if (effort) args.push("-c", `model_reasoning_effort=${tomlString(effort)}`);
      args.push("--json", "-o", outputFile, "--skip-git-repo-check");
      if (existingSessionId) args.push(existingSessionId);
      args.push(request.prompt);

      const raw = await invokePromptCliRaw({
        command: this.options.codexCommand ?? runtimeConnectorCommand("codex-cli") ?? "codex",
        args,
        cwd: request.binding.cwd,
        env: withoutCliProxyEnv(process.env),
        inheritEnv: false,
        signal: request.signal,
        agentName: request.agent.name,
        displayName: "Codex CLI",
        spawnFn: this.options.spawnFn,
      });
      const parsed = this.parseJsonl(raw.stdout);
      if (parsed.error) throw new Error(parsed.error);
      const content = (existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "").trimEnd() || parsed.content;
      const sessionId = parsed.sessionId ?? existingSessionId;
      if (!sessionId) throw new Error(`Codex CLI did not report a thread id for ${request.agent.name}`);
      if (!content) throw new Error(`Codex CLI returned no assistant text for ${request.agent.name}`);

      return {
        content,
        piSessionId: sessionId,
        sessionFile: `${CODEX_SESSION_FILE_PREFIX}${sessionId}`,
        provider: request.agent.provider,
        model: request.agent.model,
        thinking: request.agent.thinking,
      };
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }

  private parseJsonl(stdout: string): { content: string; sessionId?: string; error?: string } {
    const chunks: string[] = [];
    let sessionId: string | undefined;
    let failure: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const event = value as {
        type?: unknown;
        thread_id?: unknown;
        item?: unknown;
        message?: unknown;
        content?: unknown;
        error?: unknown;
      };
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
        continue;
      }
      if (event.type === "agent_message" && typeof event.message === "string") {
        chunks.push(event.message);
        continue;
      }
      if (event.type === "message" && typeof event.content === "string") {
        chunks.push(event.content);
        continue;
      }
      if (event.type === "item.completed" && event.item && typeof event.item === "object") {
        const item = event.item as { type?: unknown; text?: unknown };
        if (item.type === "agent_message" && typeof item.text === "string") chunks.push(item.text);
        continue;
      }
      if (event.type === "turn.failed") {
        failure = this.errorMessage(event.error) ?? "Codex CLI turn failed";
      }
    }
    return { content: (chunks.at(-1) ?? "").trimEnd(), sessionId, error: failure };
  }

  private errorMessage(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    const error = value as { message?: unknown; errorMessage?: unknown };
    if (typeof error.message === "string") return error.message;
    if (typeof error.errorMessage === "string") return error.errorMessage;
    return undefined;
  }
}
