import { WebSocket } from "ws";
import { piWebJson } from "./pi-web-http.ts";

const GLOBAL_CHAT_STREAM_ID = "__global__";
const CHAT_EVENT_LOG_LIMIT = 300;
const CHAT_MESSAGE_LIMIT = 200;

export interface PiWebChatBridgeOptions {
  baseUrl?: string;
  cwd: string;
  now?: () => number;
}

export interface PiWebChatModelOption {
  key: string;
  provider: string;
  model: string;
  name?: string;
  reasoning?: boolean;
}

export interface PiWebChatSessionItem {
  id: string;
  name?: string;
  preview: string;
  created?: string;
  modified?: string;
  messageCount: number;
  archived: boolean;
  active: boolean;
  status: "idle" | "streaming" | "queued" | "tool" | "compacting" | "error" | "archived";
  statusLabel: string;
  modelLabel?: string;
}

export interface PiWebChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "custom";
  text: string;
  thinkingText?: string;
  copyText: string;
  thinkingLevel?: string;
  source?: string;
  customType?: string;
}

export interface PiWebChatQueuedInput {
  id: string;
  kind: "steer" | "followUp";
  text: string;
}

export interface PiWebChatToolState {
  toolCallId: string;
  toolName: string;
  summary?: string;
  text?: string;
  status: "running" | "completed" | "error";
  updatedAt: string;
}

export interface PiWebChatRunState {
  status: "idle" | "streaming" | "queued" | "tool" | "compacting";
  label: string;
  assistantText: string;
  thinkingText: string;
  activityLabel?: string;
  activityDetail?: string;
}

export interface PiWebChatCurrentConfig {
  model?: PiWebChatModelOption;
  thinkingLevel?: string;
  pendingModel?: PiWebChatModelOption;
  pendingThinkingLevel?: string;
  appliesNextTurn: boolean;
}

export interface PiWebChatConnectionState {
  status: "connecting" | "connected" | "error";
  message?: string;
}

export interface PiWebChatSnapshot {
  mode: "chat";
  eventStreamId: string;
  activeSessionId?: string;
  sessions: PiWebChatSessionItem[];
  session?: {
    id: string;
    name?: string;
    archived: boolean;
    readOnly: boolean;
  };
  messages: PiWebChatMessage[];
  activeRun?: PiWebChatRunState;
  queuedInputs: PiWebChatQueuedInput[];
  toolStates: PiWebChatToolState[];
  modelOptions: PiWebChatModelOption[];
  thinkingLevels: string[];
  currentConfig: PiWebChatCurrentConfig;
  connectionState: PiWebChatConnectionState;
  cursor: number;
  upstreamSeq: number;
}

export interface PiWebChatEvent {
  type: "assistant.delta" | "thinking.delta" | "tool.start" | "tool.update" | "tool.end" | "assistant.done" | "run.status" | "input.queued" | "session.updated" | "snapshot.invalidated" | "error";
  cursor: number;
  streamId: string;
  sessionId?: string;
  upstreamSeq?: number;
  text?: string;
  tool?: PiWebChatToolState;
  status?: PiWebChatRunState["status"];
  label?: string;
  queuedInputs?: PiWebChatQueuedInput[];
  currentConfig?: PiWebChatCurrentConfig;
  connectionState?: PiWebChatConnectionState;
  sessions?: PiWebChatSessionItem[];
  message?: string;
  activityLabel?: string;
  activityDetail?: string;
}

interface PiWebSessionListEntry {
  id: string;
  name?: string;
  created?: string;
  modified?: string;
  messageCount: number;
  firstMessage?: string;
  archived: boolean;
}

interface PiWebModelRef {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

interface PiWebSessionStatus {
  sessionId: string;
  model?: PiWebModelRef;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  isBashRunning?: boolean;
  pendingMessageCount?: number;
  queuedMessages?: Array<{ kind?: string; text?: string }>;
}

interface PiWebStreamSnapshot {
  seq: number;
  partial: unknown;
}

interface PendingConfigState {
  model?: PiWebChatModelOption;
  thinkingLevel?: string;
}

interface SessionRealtimeState {
  id: string;
  log: PiWebChatEvent[];
  nextCursor: number;
  listeners: Set<(event: PiWebChatEvent) => void>;
  connectionState: PiWebChatConnectionState;
  status?: PiWebSessionStatus;
  activityLabel?: string;
  activityDetail?: string;
  liveAssistantText: string;
  liveThinkingText: string;
  toolStates: Map<string, PiWebChatToolState>;
  toolOrder: string[];
  pendingConfig?: PendingConfigState;
  upstream?: WebSocket;
  connecting?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt?: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
  disposed?: boolean;
  applyingPending: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThinkingLevelInput(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function shortPreview(value: string | undefined, limit = 72): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3))}...` : text;
}

function joinMessageText(content: unknown): { text: string; thinkingText: string } {
  if (typeof content === "string") return { text: content, thinkingText: "" };
  const parts = arrayValue(content);
  if (!parts.length) return { text: "", thinkingText: "" };
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = stringValue(part.type);
    if (type === "text") {
      const text = stringValue(part.text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === "thinking") {
      const thinking = stringValue(part.thinking) ?? stringValue(part.text);
      if (thinking) thinkingParts.push(thinking);
    }
  }
  return {
    text: textParts.join("\n").trim(),
    thinkingText: thinkingParts.join("\n").trim(),
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => stringifyUnknown(entry)).filter(Boolean).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output === "string") return value.output;
    if (typeof value.content === "string") return value.content;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "[object]";
    }
  }
  return "";
}

function queuedInputsFromStatus(status: PiWebSessionStatus | undefined): PiWebChatQueuedInput[] {
  return arrayValue(status?.queuedMessages).map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const rawKind = stringValue(record.kind) ?? "followUp";
    return {
      id: `queued:${index}:${rawKind}`,
      kind: rawKind === "steer" ? "steer" : "followUp",
      text: stringValue(record.text) ?? "",
    };
  });
}

function modelOptionFromPiModel(model: PiWebModelRef | undefined): PiWebChatModelOption | undefined {
  if (!model?.provider || !model.id) return undefined;
  return {
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    model: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
  };
}

function normalizeModelOption(value: unknown): PiWebChatModelOption | undefined {
  if (!isRecord(value)) return undefined;
  const provider = stringValue(value.provider);
  const model = stringValue(value.id) ?? stringValue(value.modelId) ?? stringValue(value.model);
  if (!provider || !model) return undefined;
  return {
    key: `${provider}/${model}`,
    provider,
    model,
    ...(stringValue(value.name) ? { name: stringValue(value.name) } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
  };
}

function normalizeMessage(value: unknown, index: number): PiWebChatMessage {
  const record = isRecord(value) ? value : {};
  const role = stringValue(record.role);
  const normalizedRole = role === "user" || role === "assistant" || role === "system" || role === "custom" ? role : "system";
  const content = record.content;
  const body = joinMessageText(content ?? record.text ?? "");
  const fallbackText = body.text || stringifyUnknown(content ?? record.text ?? "");
  const thinkingText = body.thinkingText;
  const source = stringValue(record.source);
  const customType = stringValue(record.customType);
  const thinkingLevel = stringValue(record.thinkingLevel);
  const text = fallbackText || (customType ? `[${customType}]` : "");
  const copyText = thinkingText ? `${text}\n\n[thinking]\n${thinkingText}`.trim() : text;
  return {
    id: `message:${index}:${normalizedRole}`,
    role: normalizedRole,
    text,
    ...(thinkingText ? { thinkingText } : {}),
    copyText,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(source ? { source } : {}),
    ...(customType ? { customType } : {}),
  };
}

function runStateFromStatus(
  status: PiWebSessionStatus | undefined,
  live: { assistantText: string; thinkingText: string; activityLabel?: string; activityDetail?: string },
): PiWebChatRunState | undefined {
  if (!status) {
    if (!live.assistantText && !live.thinkingText) return undefined;
    return {
      status: "queued",
      label: "等待连接",
      assistantText: live.assistantText,
      thinkingText: live.thinkingText,
      ...(live.activityLabel ? { activityLabel: live.activityLabel } : {}),
      ...(live.activityDetail ? { activityDetail: live.activityDetail } : {}),
    };
  }
  const pending = status.pendingMessageCount ?? 0;
  const busy = status.isStreaming || status.isCompacting || status.isBashRunning || pending > 0;
  if (!busy && !live.assistantText && !live.thinkingText) return undefined;
  let runStatus: PiWebChatRunState["status"] = "idle";
  let label = "空闲";
  if (status.isStreaming) {
    runStatus = "streaming";
    label = "流式输出中";
  } else if (status.isBashRunning) {
    runStatus = "tool";
    label = "工具执行中";
  } else if (status.isCompacting) {
    runStatus = "compacting";
    label = "整理上下文中";
  } else if (pending > 0) {
    runStatus = "queued";
    label = "队列中";
  }
  return {
    status: runStatus,
    label,
    assistantText: live.assistantText,
    thinkingText: live.thinkingText,
    ...(live.activityLabel ? { activityLabel: live.activityLabel } : {}),
    ...(live.activityDetail ? { activityDetail: live.activityDetail } : {}),
  };
}

function sessionStatusLabel(status: PiWebSessionStatus | undefined, archived: boolean): { status: PiWebChatSessionItem["status"]; label: string; modelLabel?: string } {
  if (archived) return { status: "archived", label: "已归档" };
  if (!status) return { status: "idle", label: "空闲" };
  const model = modelOptionFromPiModel(status.model);
  const modelLabel = model ? `${model.provider}/${model.model}` : undefined;
  if (status.isStreaming) return { status: "streaming", label: "输出中", ...(modelLabel ? { modelLabel } : {}) };
  if (status.isBashRunning) return { status: "tool", label: "工具中", ...(modelLabel ? { modelLabel } : {}) };
  if (status.isCompacting) return { status: "compacting", label: "整理中", ...(modelLabel ? { modelLabel } : {}) };
  if ((status.pendingMessageCount ?? 0) > 0) return { status: "queued", label: `排队 ${status.pendingMessageCount}`, ...(modelLabel ? { modelLabel } : {}) };
  return { status: "idle", label: "空闲", ...(modelLabel ? { modelLabel } : {}) };
}

export class PiWebChatBridge {
  private readonly baseUrl: string;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly states = new Map<string, SessionRealtimeState>();
  private readonly unpersisted = new Map<string, PiWebSessionListEntry>();
  private readonly controller = new AbortController();
  private closed = false;

  constructor(options: PiWebChatBridgeOptions) {
    this.baseUrl = (options.baseUrl ?? process.env.PI_TEAM_PI_WEB_URL ?? process.env.PI_WEB_URL ?? "http://127.0.0.1:8504").replace(/\/+$/, "");
    this.cwd = options.cwd;
    this.now = options.now ?? (() => Date.now());
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.controller.abort(new Error("Chat bridge closed"));
    for (const state of this.states.values()) {
      state.disposed = true;
      if (state.releaseTimer) clearTimeout(state.releaseTimer);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.listeners.clear();
      try {
        state.upstream?.close();
      } catch {
        // Best effort during shutdown.
      }
    }
    this.states.clear();
    this.unpersisted.clear();
  }

  async snapshot(preferredSessionId?: string): Promise<PiWebChatSnapshot> {
    const sessions = await this.listSessions();
    if (preferredSessionId && !sessions.some(session => session.id === preferredSessionId)) {
      await this.getJson(`/api/sessions/${encodeURIComponent(preferredSessionId)}/status?cwd=${encodeURIComponent(this.cwd)}`);
      const active = { id: preferredSessionId, messageCount: 0, archived: false };
      this.unpersisted.set(preferredSessionId, active);
      sessions.unshift(active);
    }
    const selected = this.pickSession(sessions, preferredSessionId);
    const list = this.decorateSessions(sessions, selected?.id);
    if (!selected) {
      const state = this.ensureState(GLOBAL_CHAT_STREAM_ID);
      return {
        mode: "chat",
        eventStreamId: GLOBAL_CHAT_STREAM_ID,
        sessions: list,
        messages: [],
        queuedInputs: [],
        toolStates: [],
        modelOptions: [],
        thinkingLevels: [],
        currentConfig: { appliesNextTurn: false },
        connectionState: state.connectionState,
        cursor: state.nextCursor - 1,
        upstreamSeq: 0,
      };
    }

    const state = this.ensureState(selected.id);
    void this.ensureSessionConnection(state);
    const cursor = state.nextCursor - 1;
    const [messagesResponse, status, streamSnapshot, modelsResponse, thinkingResponse] = await Promise.all([
      this.getJson(`/api/sessions/${encodeURIComponent(selected.id)}/messages?cwd=${encodeURIComponent(this.cwd)}&limit=${CHAT_MESSAGE_LIMIT}`),
      this.getJson(`/api/sessions/${encodeURIComponent(selected.id)}/status?cwd=${encodeURIComponent(this.cwd)}`),
      this.getJson(`/api/sessions/${encodeURIComponent(selected.id)}/stream-snapshot?cwd=${encodeURIComponent(this.cwd)}`),
      this.getJson(`/api/sessions/${encodeURIComponent(selected.id)}/models?cwd=${encodeURIComponent(this.cwd)}`),
      this.getJson(`/api/sessions/${encodeURIComponent(selected.id)}/thinking-levels?cwd=${encodeURIComponent(this.cwd)}`),
    ]);

    state.status = this.normalizeStatus(status, selected.id);
    const stream = this.normalizeStreamSnapshot(streamSnapshot);
    const partial = normalizeMessage(stream.partial ?? { role: "assistant", content: "" }, 9_999);
    if (stream.partial) {
      state.liveAssistantText = partial.text;
      state.liveThinkingText = partial.thinkingText ?? "";
    } else if (!(state.status?.isStreaming || state.status?.isBashRunning || state.status?.isCompacting || (state.status?.pendingMessageCount ?? 0) > 0)) {
      state.liveAssistantText = "";
      state.liveThinkingText = "";
    }

    const messages = this.normalizeMessages(messagesResponse);
    const modelOptions = this.normalizeModelOptions(modelsResponse);
    const thinkingLevels = arrayValue(isRecord(thinkingResponse) ? thinkingResponse.levels : []).map((value) => String(value));
    const queuedInputs = queuedInputsFromStatus(state.status);
    const currentConfig = this.currentConfig(state);
    const activeRun = runStateFromStatus(state.status, {
      assistantText: state.liveAssistantText,
      thinkingText: state.liveThinkingText,
      activityLabel: state.activityLabel,
      activityDetail: state.activityDetail,
    });
    this.maybeApplyPendingConfig(state);

    return {
      mode: "chat",
      eventStreamId: selected.id,
      activeSessionId: selected.id,
      sessions: this.decorateSessions(sessions, selected.id),
      session: {
        id: selected.id,
        ...(selected.name ? { name: selected.name } : {}),
        archived: selected.archived === true,
        readOnly: selected.archived === true,
      },
      messages,
      ...(activeRun ? { activeRun } : {}),
      queuedInputs,
      toolStates: state.toolOrder.map((id) => state.toolStates.get(id)).filter((item): item is PiWebChatToolState => !!item),
      modelOptions,
      thinkingLevels,
      currentConfig,
      connectionState: state.connectionState,
      cursor,
      upstreamSeq: stream.seq,
    };
  }

  async createSession(input: { model?: PiWebChatModelOption; thinkingLevel?: string } = {}): Promise<PiWebChatSnapshot> {
    const created = await this.postJson("/api/sessions", { cwd: this.cwd });
    const sessionId = stringValue(isRecord(created) ? created.id : undefined);
    if (!sessionId) throw new Error("PI Web did not return a session id");
    const state = this.ensureState(sessionId);
    this.unpersisted.set(sessionId, { id: sessionId, created: nowIso(this.now()), messageCount: 0, archived: false });
    void this.ensureSessionConnection(state);
    const thinkingLevel = normalizeThinkingLevelInput(input.thinkingLevel);
    if (input.model || thinkingLevel !== undefined) {
      await this.applyConfigNow(state, {
        ...input,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      });
    }
    await this.broadcastSessionListUpdate();
    return this.snapshot(sessionId);
  }

  async switchSession(sessionId: string): Promise<PiWebChatSnapshot> {
    return this.snapshot(sessionId);
  }

  async send(input: { sessionId: string; text: string; mode: "send" | "followUp" | "steer" }): Promise<PiWebChatSnapshot> {
    const sessionId = input.sessionId;
    const trimmed = input.text.trim();
    if (!trimmed) throw new Error("message is required");
    const state = this.ensureState(sessionId);
    void this.ensureSessionConnection(state);
    const sessions = await this.listSessions();
    const selected = sessions.find((entry) => entry.id === sessionId);
    if (selected?.archived) throw new Error("该会话已归档，先切到未归档会话再发消息。");

    const status = this.normalizeStatus(await this.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/status?cwd=${encodeURIComponent(this.cwd)}`), sessionId);
    state.status = status;
    const busy = status.isStreaming || status.isBashRunning || status.isCompacting || (status.pendingMessageCount ?? 0) > 0;
    if (input.mode === "send" && busy) {
      throw new Error("当前正在运行，请用 Follow 或 Steer。");
    }
    const behavior = busy
      ? input.mode === "steer"
        ? "steer"
        : input.mode === "followUp"
          ? "followUp"
          : undefined
      : undefined;
    if (!busy) {
      state.liveAssistantText = "";
      state.liveThinkingText = "";
      state.toolOrder = [];
      state.toolStates.clear();
    }
    await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      cwd: this.cwd,
      text: trimmed,
      ...(behavior ? { streamingBehavior: behavior } : {}),
    });
    const snapshot = await this.snapshot(sessionId);
    if (behavior) {
      const queued = {
        id: `queued:${this.now()}:${behavior}`,
        kind: behavior === "steer" ? "steer" : "followUp",
        text: trimmed,
      } satisfies PiWebChatQueuedInput;
      this.publish(sessionId, {
        type: "input.queued",
        sessionId,
        queuedInputs: [queued],
      });
    }
    return snapshot;
  }

  async stop(sessionId: string): Promise<PiWebChatSnapshot> {
    await this.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { cwd: this.cwd });
    return this.snapshot(sessionId);
  }

  async setConfig(input: { sessionId: string; model?: PiWebChatModelOption; thinkingLevel?: string }): Promise<PiWebChatSnapshot> {
    const state = this.ensureState(input.sessionId);
    void this.ensureSessionConnection(state);
    const thinkingWasSubmitted = input.thinkingLevel !== undefined;
    const normalizedThinkingLevel = normalizeThinkingLevelInput(input.thinkingLevel);
    const status = this.normalizeStatus(await this.getJson(`/api/sessions/${encodeURIComponent(input.sessionId)}/status?cwd=${encodeURIComponent(this.cwd)}`), input.sessionId);
    state.status = status;
    const busy = status.isStreaming || status.isBashRunning || status.isCompacting || (status.pendingMessageCount ?? 0) > 0;
    if (busy) {
      const pendingConfig: PendingConfigState = {
        ...(state.pendingConfig ?? {}),
        ...(input.model ? { model: input.model } : {}),
      };
      if (normalizedThinkingLevel !== undefined) pendingConfig.thinkingLevel = normalizedThinkingLevel;
      else if (thinkingWasSubmitted) delete pendingConfig.thinkingLevel;
      state.pendingConfig = pendingConfig.model || pendingConfig.thinkingLevel !== undefined ? pendingConfig : undefined;
      const snapshot = await this.snapshot(input.sessionId);
      await this.broadcastSessionListUpdate();
      this.publish(input.sessionId, {
        type: "session.updated",
        sessionId: input.sessionId,
        currentConfig: snapshot.currentConfig,
      });
      return snapshot;
    }
    await this.applyConfigNow(state, {
      ...input,
      ...(normalizedThinkingLevel !== undefined ? { thinkingLevel: normalizedThinkingLevel } : {}),
    });
    const snapshot = await this.snapshot(input.sessionId);
    await this.broadcastSessionListUpdate();
    this.publish(input.sessionId, {
      type: "session.updated",
      sessionId: input.sessionId,
      currentConfig: snapshot.currentConfig,
    });
    return snapshot;
  }

  subscribe(streamId: string, afterCursor: number | undefined, onEvent: (event: PiWebChatEvent) => void): () => void {
    const state = this.ensureState(streamId);
    const cursor = typeof afterCursor === "number" && Number.isFinite(afterCursor) ? afterCursor : 0;
    for (const event of state.log) {
      if (event.cursor > cursor) onEvent(event);
    }
    state.listeners.add(onEvent);
    if (state.releaseTimer) clearTimeout(state.releaseTimer);
    if (streamId !== GLOBAL_CHAT_STREAM_ID) void this.ensureSessionConnection(state);
    return () => {
      state.listeners.delete(onEvent);
      this.scheduleRelease(state);
    };
  }

  private scheduleRelease(state: SessionRealtimeState): void {
    if (this.closed || state.disposed || state.listeners.size || state.id === GLOBAL_CHAT_STREAM_ID) return;
    if (state.releaseTimer) clearTimeout(state.releaseTimer);
    state.releaseTimer = setTimeout(() => {
      if (state.listeners.size) return;
      if (state.pendingConfig || state.applyingPending || state.status?.isStreaming || state.status?.isCompacting || state.status?.isBashRunning || (state.status?.pendingMessageCount ?? 0) > 0) {
        this.scheduleRelease(state);
        return;
      }
      state.disposed = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.upstream?.close();
      this.states.delete(state.id);
    }, 30_000);
    state.releaseTimer.unref?.();
  }

  private ensureState(streamId: string): SessionRealtimeState {
    let state = this.states.get(streamId);
    if (state) return state;
    state = {
      id: streamId,
      log: [],
      nextCursor: 1,
      listeners: new Set(),
      connectionState: streamId === GLOBAL_CHAT_STREAM_ID
        ? { status: "connected" }
        : { status: "connecting", message: "正在连接 PI Web 事件流" },
      liveAssistantText: "",
      liveThinkingText: "",
      toolStates: new Map(),
      toolOrder: [],
      applyingPending: false,
    };
    this.states.set(streamId, state);
    this.scheduleRelease(state);
    return state;
  }

  private async ensureSessionConnection(state: SessionRealtimeState): Promise<void> {
    if (this.closed || state.disposed || state.id === GLOBAL_CHAT_STREAM_ID) return;
    if (state.upstream && state.upstream.readyState === WebSocket.OPEN) {
      state.connectionState = { status: "connected" };
      return;
    }
    if (state.connecting) return state.connecting;
    const wsUrl = this.toWebSocketUrl(`/api/sessions/${encodeURIComponent(state.id)}/events?cwd=${encodeURIComponent(this.cwd)}`);
    state.connectionState = { status: "connecting", message: "正在连接 PI Web 事件流" };
    state.connecting = new Promise<void>((resolve) => {
      const socket = new WebSocket(wsUrl);
      state.upstream = socket;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.on("open", () => {
        if (this.closed || state.disposed || state.upstream !== socket) { socket.close(); finish(); return; }
        state.upstream = socket;
        state.connectionState = { status: "connected" };
        this.publishRunStatus(state);
        finish();
        if (state.reconnectAttempt) {
          void this.snapshot(state.id).then(() => {
            if (state.disposed || state.upstream !== socket) return;
            this.publish(state.id, { type: "snapshot.invalidated", sessionId: state.id });
          }).catch(() => undefined);
        }
        state.reconnectAttempt = 0;
      });
      socket.on("message", (payload) => {
        if (this.closed || state.disposed || state.upstream !== socket) return;
        try {
          this.handleUpstreamEvent(state, JSON.parse(String(payload)));
        } catch (error) {
          this.publish(state.id, {
            type: "error",
            sessionId: state.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      socket.on("error", (error) => {
        if (this.closed || state.disposed || state.upstream !== socket) { finish(); return; }
        state.connectionState = { status: "error", message: error instanceof Error ? error.message : "PI Web 事件流异常" };
        this.publishRunStatus(state);
        finish();
      });
      socket.on("close", () => {
        finish();
        if (this.closed || state.disposed || state.upstream !== socket) return;
        if (state.upstream === socket) state.upstream = undefined;
        state.connectionState = this.closed
          ? { status: "error", message: "事件流已关闭" }
          : { status: "connecting", message: "事件流断开，正在重连" };
        this.publishRunStatus(state);
        if (!this.closed) {
          if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
          state.reconnectTimer = setTimeout(() => {
            state.connecting = undefined;
            void this.ensureSessionConnection(state);
          }, Math.min(10_000, 600 * Math.pow(2, state.reconnectAttempt ?? 0)));
          state.reconnectAttempt = (state.reconnectAttempt ?? 0) + 1;
        }
      });
    }).finally(() => {
      state.connecting = undefined;
    });
    return state.connecting;
  }

  private handleUpstreamEvent(state: SessionRealtimeState, event: unknown): void {
    if (!isRecord(event)) return;
    const type = stringValue(event.type) ?? "unknown";
    const upstreamSeq = typeof event.seq === "number" ? event.seq : undefined;
    if (type === "assistant.delta") {
      const text = stringValue(event.text) ?? "";
      if (text) state.liveAssistantText += text;
      this.publish(state.id, { type: "assistant.delta", sessionId: state.id, upstreamSeq, text });
      return;
    }
    if (type === "assistant.thinking.delta") {
      const text = stringValue(event.text) ?? "";
      if (text) state.liveThinkingText += text;
      this.publish(state.id, { type: "thinking.delta", sessionId: state.id, upstreamSeq, text });
      return;
    }
    if (type === "tool.start") {
      const tool = {
        toolCallId: stringValue(event.toolCallId) ?? `tool:${this.now()}`,
        toolName: stringValue(event.toolName) ?? "tool",
        ...(stringValue(event.summary) ? { summary: stringValue(event.summary) } : {}),
        status: "running" as const,
        updatedAt: nowIso(this.now()),
      };
      state.toolStates.set(tool.toolCallId, tool);
      if (!state.toolOrder.includes(tool.toolCallId)) state.toolOrder.unshift(tool.toolCallId);
      this.publish(state.id, { type: "tool.start", sessionId: state.id, upstreamSeq, tool });
      return;
    }
    if (type === "tool.update" || type === "tool.end") {
      const toolCallId = stringValue(event.toolCallId) ?? `tool:${this.now()}`;
      const previous = state.toolStates.get(toolCallId);
      const text = stringValue(event.text) ?? stringifyUnknown(event.content);
      const mergedText = this.mergeToolText(previous?.text, text);
      const tool = {
        toolCallId,
        toolName: stringValue(event.toolName) ?? previous?.toolName ?? "tool",
        ...(stringValue(event.summary) ?? previous?.summary ? { summary: stringValue(event.summary) ?? previous?.summary } : {}),
        ...(mergedText ? { text: mergedText } : {}),
        status: type === "tool.end" && booleanValue(event.isError) === true ? "error" as const : type === "tool.end" ? "completed" as const : "running" as const,
        updatedAt: nowIso(this.now()),
      };
      state.toolStates.set(toolCallId, tool);
      if (!state.toolOrder.includes(toolCallId)) state.toolOrder.unshift(toolCallId);
      this.publish(state.id, { type: type === "tool.end" ? "tool.end" : "tool.update", sessionId: state.id, upstreamSeq, tool });
      return;
    }
    if (type === "activity.update") {
      const activity = isRecord(event.activity) ? event.activity : {};
      state.activityLabel = stringValue(activity.label);
      state.activityDetail = stringValue(activity.detail);
      this.publishRunStatus(state, upstreamSeq);
      return;
    }
    if (type === "status.update") {
      state.status = this.normalizeStatus(event.status, state.id);
      if (!(state.status.isStreaming || state.status.isBashRunning || state.status.isCompacting || (state.status.pendingMessageCount ?? 0) > 0)) {
        state.liveAssistantText = "";
        state.liveThinkingText = "";
      }
      this.publishRunStatus(state, upstreamSeq);
      this.maybeApplyPendingConfig(state);
      return;
    }
    if (type === "session.name") {
      void this.broadcastSessionListUpdate();
      return;
    }
    if (type === "message.end") {
      state.liveAssistantText = "";
      state.liveThinkingText = "";
      this.publish(state.id, { type: "assistant.done", sessionId: state.id, upstreamSeq });
      return;
    }
  }

  private publishRunStatus(state: SessionRealtimeState, upstreamSeq?: number): void {
    const currentConfig = this.currentConfig(state);
    const run = runStateFromStatus(state.status, {
      assistantText: state.liveAssistantText,
      thinkingText: state.liveThinkingText,
      activityLabel: state.activityLabel,
      activityDetail: state.activityDetail,
    });
    this.publish(state.id, {
      type: "run.status",
      sessionId: state.id,
      upstreamSeq,
      status: run?.status ?? "idle",
      label: run?.label ?? "空闲",
      queuedInputs: queuedInputsFromStatus(state.status),
      currentConfig,
      connectionState: state.connectionState,
      activityLabel: state.activityLabel,
      activityDetail: state.activityDetail,
    });
  }

  private publish(streamId: string, event: Omit<PiWebChatEvent, "cursor" | "streamId">): void {
    const state = this.ensureState(streamId);
    const payload: PiWebChatEvent = {
      ...event,
      cursor: state.nextCursor++,
      streamId,
    };
    state.log.push(payload);
    if (state.log.length > CHAT_EVENT_LOG_LIMIT) state.log.splice(0, state.log.length - CHAT_EVENT_LOG_LIMIT);
    for (const listener of state.listeners) listener(payload);
  }

  private async broadcastSessionListUpdate(): Promise<void> {
    const sessions = this.decorateSessions(await this.listSessions(), undefined);
    for (const state of this.states.values()) {
      this.publish(state.id, { type: "session.updated", sessionId: state.id === GLOBAL_CHAT_STREAM_ID ? undefined : state.id, sessions });
    }
  }

  private maybeApplyPendingConfig(state: SessionRealtimeState): void {
    if (!state.pendingConfig || state.applyingPending) return;
    const busy = state.status?.isStreaming || state.status?.isBashRunning || state.status?.isCompacting || (state.status?.pendingMessageCount ?? 0) > 0;
    if (busy) return;
    state.applyingPending = true;
    void this.applyConfigNow(state, {
      sessionId: state.id,
      ...(state.pendingConfig.model ? { model: state.pendingConfig.model } : {}),
      ...(state.pendingConfig.thinkingLevel !== undefined ? { thinkingLevel: state.pendingConfig.thinkingLevel } : {}),
    }).then(async () => {
      state.pendingConfig = undefined;
      const snapshot = await this.snapshot(state.id);
      await this.broadcastSessionListUpdate();
      this.publish(state.id, {
        type: "session.updated",
        sessionId: state.id,
        currentConfig: snapshot.currentConfig,
      });
    }).catch((error) => {
      state.pendingConfig = undefined;
      this.publish(state.id, {
        type: "error",
        sessionId: state.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      state.applyingPending = false;
    });
  }

  private async applyConfigNow(
    state: SessionRealtimeState,
    input: { sessionId?: string; model?: PiWebChatModelOption; thinkingLevel?: string },
  ): Promise<void> {
    const thinkingLevel = normalizeThinkingLevelInput(input.thinkingLevel);
    if (input.model) {
      await this.postJson(`/api/sessions/${encodeURIComponent(state.id)}/model`, {
        cwd: this.cwd,
        provider: input.model.provider,
        modelId: input.model.model,
      });
    }
    if (thinkingLevel !== undefined) {
      await this.postJson(`/api/sessions/${encodeURIComponent(state.id)}/thinking-level`, {
        cwd: this.cwd,
        level: thinkingLevel,
      });
    }
  }

  private currentConfig(state: SessionRealtimeState): PiWebChatCurrentConfig {
    return {
      ...(modelOptionFromPiModel(state.status?.model) ? { model: modelOptionFromPiModel(state.status?.model) } : {}),
      ...(state.status?.thinkingLevel !== undefined ? { thinkingLevel: state.status.thinkingLevel } : {}),
      ...(state.pendingConfig?.model ? { pendingModel: state.pendingConfig.model } : {}),
      ...(state.pendingConfig?.thinkingLevel !== undefined ? { pendingThinkingLevel: state.pendingConfig.thinkingLevel } : {}),
      appliesNextTurn: !!(state.pendingConfig?.model || state.pendingConfig?.thinkingLevel !== undefined),
    };
  }

  private decorateSessions(entries: PiWebSessionListEntry[], activeId: string | undefined): PiWebChatSessionItem[] {
    return entries.map((entry) => {
      const state = this.states.get(entry.id);
      const projection = sessionStatusLabel(state?.status, entry.archived === true);
      return {
        id: entry.id,
        ...(entry.name ? { name: entry.name } : {}),
        preview: shortPreview(entry.firstMessage) || entry.name || entry.id,
        ...(entry.created ? { created: entry.created } : {}),
        ...(entry.modified ? { modified: entry.modified } : {}),
        messageCount: entry.messageCount ?? 0,
        archived: entry.archived === true,
        active: entry.id === activeId,
        status: projection.status,
        statusLabel: projection.label,
        ...(projection.modelLabel ? { modelLabel: projection.modelLabel } : {}),
      };
    });
  }

  private pickSession(entries: PiWebSessionListEntry[], preferredSessionId: string | undefined): PiWebSessionListEntry | undefined {
    if (preferredSessionId) {
      const exact = entries.find((entry) => entry.id === preferredSessionId);
      if (exact) return exact;
    }
    return entries.find((entry) => entry.archived !== true) ?? entries[0];
  }

  private normalizeStatus(value: unknown, fallbackSessionId: string): PiWebSessionStatus {
    const record = isRecord(value) ? value : {};
    const modelRecord = isRecord(record.model) ? record.model : undefined;
    return {
      sessionId: stringValue(record.sessionId) ?? fallbackSessionId,
      ...(modelRecord && stringValue(modelRecord.provider) && stringValue(modelRecord.id)
        ? {
            model: {
              provider: stringValue(modelRecord.provider)!,
              id: stringValue(modelRecord.id)!,
              ...(stringValue(modelRecord.name) ? { name: stringValue(modelRecord.name) } : {}),
              ...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
            },
          }
        : {}),
      ...(stringValue(record.thinkingLevel) !== undefined ? { thinkingLevel: String(record.thinkingLevel) } : {}),
      isStreaming: booleanValue(record.isStreaming) === true,
      isCompacting: booleanValue(record.isCompacting) === true,
      isBashRunning: booleanValue(record.isBashRunning) === true,
      pendingMessageCount: typeof record.pendingMessageCount === "number" ? record.pendingMessageCount : 0,
      queuedMessages: arrayValue(record.queuedMessages).map((entry) => isRecord(entry) ? entry : {}),
    };
  }

  private normalizeStreamSnapshot(value: unknown): PiWebStreamSnapshot {
    const record = isRecord(value) ? value : {};
    return {
      seq: typeof record.seq === "number" ? record.seq : 0,
      partial: record.partial,
    };
  }

  private normalizeMessages(value: unknown): PiWebChatMessage[] {
    const record = isRecord(value) ? value : {};
    const source = Array.isArray(record.messages) ? record.messages : Array.isArray(value) ? value : [];
    return source.map((message, index) => normalizeMessage(message, index));
  }

  private normalizeModelOptions(value: unknown): PiWebChatModelOption[] {
    const record = isRecord(value) ? value : {};
    const source = Array.isArray(record.models) ? record.models : [];
    return source.map((entry) => normalizeModelOption(entry)).filter((item): item is PiWebChatModelOption => !!item);
  }

  private mergeToolText(previous: string | undefined, incoming: string | undefined): string | undefined {
    const next = trimText(incoming);
    if (!next) return previous;
    if (!previous) return next;
    if (next.startsWith(previous) || next === previous) return next;
    if (previous.includes(next)) return previous;
    return `${previous}\n${next}`;
  }

  private async listSessions(): Promise<PiWebSessionListEntry[]> {
    const response = await this.getJson(`/api/sessions?cwd=${encodeURIComponent(this.cwd)}`);
    const entries = Array.isArray(response) ? response : [];
    const persisted = entries
      .map((entry) => {
        const record = isRecord(entry) ? entry : {};
        const id = stringValue(record.id) ?? stringValue(record.sessionId);
        if (!id) return undefined;
        return {
          id,
          ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
          ...(stringValue(record.created) ? { created: stringValue(record.created) } : {}),
          ...(stringValue(record.modified) ? { modified: stringValue(record.modified) } : {}),
          messageCount: typeof record.messageCount === "number" ? record.messageCount : 0,
          ...(stringValue(record.firstMessage) ? { firstMessage: stringValue(record.firstMessage) } : {}),
          archived: booleanValue(record.archived) === true,
        } satisfies PiWebSessionListEntry;
      })
      .filter((item): item is PiWebSessionListEntry => !!item)
      .sort((left, right) => String(right.modified ?? right.created ?? "").localeCompare(String(left.modified ?? left.created ?? "")));
    for (const entry of persisted) this.unpersisted.delete(entry.id);
    return [...this.unpersisted.values(), ...persisted];
  }

  private async getJson(path: string): Promise<unknown> {
    return piWebJson(`${this.baseUrl}${path}`, { signal: this.controller.signal });
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    return piWebJson(`${this.baseUrl}${path}`, { body, signal: this.controller.signal });
  }

  private toWebSocketUrl(path: string): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPiWebChatHtml(input: { desktopSharePanel?: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PI Team Chat</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#120f0d;
      --panel:#1d1816;
      --panel-2:#2a221f;
      --panel-3:#171312;
      --line:rgba(255,235,214,.10);
      --line-2:rgba(255,235,214,.18);
      --text:#fff4ea;
      --muted:#cab7a6;
      --soft:#9b897b;
      --accent:#efb160;
      --accent-2:#de7f5c;
      --user:#6b4137;
      --assistant:#221c19;
      --ok:#9ae3b3;
      --warn:#f4c76d;
      --err:#ff9386;
      --shadow:0 22px 60px rgba(0,0,0,.28);
    }
    * { box-sizing:border-box; }
    html, body { height:100%; }
    body {
      margin:0;
      min-height:100vh;
      background:
        radial-gradient(circle at top left, rgba(239,177,96,.16), transparent 34%),
        radial-gradient(circle at 85% 0%, rgba(222,127,92,.15), transparent 28%),
        linear-gradient(135deg, #0f0d0c, #15110f 45%, #120f0d);
      color:var(--text);
      font:14px/1.55 "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    button, input, select, textarea { font:inherit; }
    button { color:inherit; }
    .shell {
      min-height:100vh;
      display:grid;
      grid-template-columns:320px minmax(0, 1fr) 320px;
      background:rgba(9,8,8,.32);
      backdrop-filter: blur(16px);
    }
    .panel {
      min-height:0;
      overflow:auto;
      border-right:1px solid var(--line);
      background:linear-gradient(180deg, rgba(33,26,23,.96), rgba(21,17,15,.98));
    }
    .panel-right {
      border-right:0;
      border-left:1px solid var(--line);
      background:linear-gradient(180deg, rgba(24,20,18,.96), rgba(15,13,12,.98));
    }
    .panel-body { padding:18px 16px 22px; }
    .brand {
      display:flex;
      align-items:center;
      gap:12px;
      margin-bottom:18px;
    }
    .brand-mark {
      width:44px;
      height:44px;
      border-radius:15px;
      display:grid;
      place-items:center;
      background:#171211;
      border:1px solid var(--line-2);
      box-shadow:var(--shadow);
      font-size:22px;
    }
    .brand-title { font-size:18px; font-weight:900; letter-spacing:-.03em; }
    .brand-sub { color:var(--muted); font-size:12px; }
    .toolbar {
      display:flex;
      gap:8px;
      margin-bottom:12px;
    }
    .primary-btn, .ghost-btn, .tiny-btn, .pill-btn {
      border:1px solid var(--line);
      border-radius:14px;
      cursor:pointer;
    }
    .primary-btn {
      background:linear-gradient(135deg, var(--accent), var(--accent-2));
      color:#27150e;
      font-weight:900;
      padding:10px 12px;
      box-shadow:0 12px 26px rgba(222,127,92,.24);
    }
    .ghost-btn, .pill-btn, .tiny-btn {
      background:rgba(255,240,222,.05);
      color:var(--text);
    }
    .ghost-btn { padding:10px 12px; }
    .pill-btn {
      padding:6px 10px;
      font-size:12px;
      font-weight:850;
      color:var(--muted);
    }
    .pill-btn.active {
      background:rgba(239,177,96,.18);
      border-color:rgba(239,177,96,.42);
      color:var(--text);
    }
    .tiny-btn {
      padding:6px 10px;
      font-size:12px;
      font-weight:850;
      color:var(--muted);
    }
    .danger { color:#ffafa5; }
    .toolbar .ghost-btn, .toolbar .primary-btn { flex:1; }
    .panel-title {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
      margin:0 0 10px;
    }
    .panel-title h2 {
      margin:0;
      font-size:12px;
      letter-spacing:.08em;
      text-transform:uppercase;
      color:var(--muted);
    }
    .session-list {
      display:grid;
      gap:8px;
    }
    .session-card {
      width:100%;
      text-align:left;
      border:1px solid transparent;
      border-radius:16px;
      padding:12px;
      background:rgba(255,245,234,.04);
      color:var(--text);
      cursor:pointer;
    }
    .session-card:hover { background:rgba(255,245,234,.08); }
    .session-card.active {
      border-color:rgba(239,177,96,.34);
      background:rgba(239,177,96,.10);
    }
    .session-name {
      display:flex;
      justify-content:space-between;
      gap:10px;
      font-weight:850;
    }
    .session-name span:first-child {
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .session-status { color:var(--soft); font-size:11px; white-space:nowrap; }
    .session-preview {
      color:var(--muted);
      margin-top:4px;
      font-size:12px;
      display:-webkit-box;
      -webkit-line-clamp:2;
      -webkit-box-orient:vertical;
      overflow:hidden;
    }
    .session-meta {
      margin-top:8px;
      color:var(--soft);
      font-size:11px;
      display:flex;
      justify-content:space-between;
      gap:8px;
    }
    .conversation {
      min-width:0;
      min-height:100vh;
      display:grid;
      grid-template-rows:auto minmax(0, 1fr) auto;
      background:
        radial-gradient(circle at 50% 0%, rgba(239,177,96,.08), transparent 30%),
        linear-gradient(180deg, rgba(25,20,18,.95), rgba(18,15,13,.98));
    }
    .topbar {
      padding:18px 20px 14px;
      border-bottom:1px solid var(--line);
      display:grid;
      gap:12px;
    }
    .topbar-main {
      display:flex;
      justify-content:space-between;
      gap:12px;
      align-items:flex-start;
    }
    .topbar-title {
      min-width:0;
    }
    .eyebrow {
      color:var(--muted);
      font-size:11px;
      font-weight:850;
      letter-spacing:.10em;
      text-transform:uppercase;
    }
    .title-row {
      display:flex;
      align-items:center;
      gap:10px;
      margin-top:6px;
      flex-wrap:wrap;
    }
    .title-row h1 {
      margin:0;
      font-size:24px;
      letter-spacing:-.04em;
    }
    .status-chip, .pending-chip {
      padding:5px 9px;
      border-radius:999px;
      font-size:12px;
      font-weight:850;
      border:1px solid var(--line);
      background:rgba(255,245,234,.05);
      color:var(--muted);
    }
    .status-chip.streaming, .status-chip.tool { color:var(--warn); border-color:rgba(244,199,109,.34); }
    .status-chip.idle { color:var(--ok); border-color:rgba(154,227,179,.26); }
    .pending-chip { color:var(--accent); border-color:rgba(239,177,96,.36); }
    .topbar-actions {
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      justify-content:flex-end;
      align-items:center;
    }
    .topbar-controls {
      display:grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap:10px;
    }
    label.field {
      display:grid;
      gap:6px;
      color:var(--muted);
      font-size:12px;
      font-weight:850;
    }
    select.field-input, textarea.field-input {
      width:100%;
      border:1px solid var(--line);
      border-radius:14px;
      background:rgba(15,13,12,.72);
      color:var(--text);
      outline:none;
      padding:10px 12px;
    }
    .messages {
      min-height:0;
      overflow:auto;
      padding:18px 20px 26px;
      display:grid;
      gap:14px;
      align-content:start;
    }
    .empty-state {
      margin:auto;
      max-width:480px;
      padding:28px;
      border:1px solid var(--line);
      border-radius:24px;
      background:rgba(255,245,234,.04);
      box-shadow:var(--shadow);
    }
    .empty-state h3 {
      margin:0 0 8px;
      font-size:22px;
      letter-spacing:-.03em;
    }
    .empty-state p {
      margin:0;
      color:var(--muted);
    }
    .message-row {
      display:flex;
      gap:12px;
      align-items:flex-start;
    }
    .message-row.user { justify-content:flex-end; }
    .bubble {
      max-width:min(780px, 92%);
      border:1px solid var(--line);
      border-radius:22px;
      padding:14px 14px 12px;
      box-shadow:var(--shadow);
      background:var(--assistant);
    }
    .message-row.user .bubble {
      background:linear-gradient(180deg, rgba(107,65,55,.98), rgba(77,43,38,.98));
      border-color:rgba(255,228,214,.14);
    }
    .bubble-head {
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:center;
      margin-bottom:8px;
    }
    .bubble-label {
      font-size:12px;
      color:var(--muted);
      font-weight:850;
      letter-spacing:.04em;
      text-transform:uppercase;
    }
    .message-row.user .bubble-label { color:rgba(255,236,222,.85); }
    .bubble-actions { display:flex; gap:6px; }
    .bubble-text {
      margin:0;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      font-family:"SF Mono", "JetBrains Mono", "Roboto Mono", monospace;
      font-size:13px;
      line-height:1.65;
      user-select:text;
    }
    .bubble-thinking {
      margin-top:10px;
      padding-top:10px;
      border-top:1px dashed rgba(255,245,234,.10);
    }
    .bubble-thinking summary {
      color:var(--soft);
      cursor:pointer;
      font-size:12px;
      font-weight:850;
    }
    .bubble-thinking pre {
      margin:10px 0 0;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      font-family:"SF Mono", "JetBrains Mono", monospace;
      font-size:12px;
      color:var(--muted);
    }
    .composer {
      border-top:1px solid var(--line);
      padding:16px 20px 20px;
      background:rgba(15,13,12,.92);
    }
    .composer-box {
      display:grid;
      gap:10px;
      padding:12px;
      border:1px solid var(--line);
      border-radius:20px;
      background:rgba(255,245,234,.04);
    }
    .composer-box textarea {
      min-height:120px;
      resize:vertical;
      border:0;
      outline:none;
      background:transparent;
      color:var(--text);
      padding:0;
    }
    .composer-actions {
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:center;
      flex-wrap:wrap;
    }
    .composer-hint {
      color:var(--soft);
      font-size:12px;
    }
    .action-group {
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .stack {
      display:grid;
      gap:12px;
    }
    .card {
      padding:14px;
      border:1px solid var(--line);
      border-radius:18px;
      background:rgba(255,245,234,.04);
    }
    .card h3 {
      margin:0 0 8px;
      font-size:13px;
      color:var(--muted);
      letter-spacing:.04em;
      text-transform:uppercase;
    }
    .stat {
      display:flex;
      justify-content:space-between;
      gap:8px;
      color:var(--muted);
      font-size:12px;
      margin-top:6px;
    }
    .stat strong { color:var(--text); }
    .queue-list, .tool-list {
      display:grid;
      gap:8px;
    }
    .queue-item, .tool-item {
      padding:10px;
      border:1px solid var(--line);
      border-radius:14px;
      background:rgba(15,13,12,.48);
    }
    .queue-kind, .tool-head {
      display:flex;
      justify-content:space-between;
      gap:8px;
      color:var(--muted);
      font-size:12px;
      font-weight:850;
    }
    .queue-text, .tool-text {
      margin-top:6px;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      color:var(--text);
      font-size:12px;
    }
    .tool-text {
      font-family:"SF Mono", "JetBrains Mono", monospace;
      color:var(--muted);
    }
    .tool-state-running { color:var(--warn); }
    .tool-state-completed { color:var(--ok); }
    .tool-state-error { color:var(--err); }
    .banner {
      margin-bottom:10px;
      padding:10px 12px;
      border-radius:14px;
      border:1px solid rgba(255,147,134,.22);
      background:rgba(255,147,134,.08);
      color:#ffd7d2;
      display:none;
    }
    .banner.show { display:block; }
    .mode-links {
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .share-wrap { margin-top:16px; }
    .mobile-bar { display:none; }
    @media (max-width: 1024px) {
      .shell {
        grid-template-columns:minmax(0, 1fr);
        backdrop-filter:none;
        overflow-x:clip;
      }
      .panel, .panel-right {
        position:fixed;
        top:0;
        bottom:0;
        width:min(86vw, 340px);
        z-index:40;
        transition:transform .22s ease;
        visibility:hidden;
      }
      .panel {
        left:0;
        transform:translateX(-100%);
      }
      .panel.open { transform:translateX(0); visibility:visible; }
      .panel-right {
        left:auto;
        right:0;
        transform:translateX(100%);
      }
      .panel-right.open { transform:translateX(0); }
      .conversation {
        min-height:100vh;
      }
      .mobile-bar {
        display:flex;
        gap:8px;
      }
      .topbar-main {
        flex-direction:column;
      }
      .topbar-actions {
        justify-content:flex-start;
      }
      .topbar-controls {
        grid-template-columns:1fr;
      }
      .bubble { max-width:100%; }
    }
  </style>
</head>
<body class="shell">
  <aside class="panel" id="sessionPanel">
    <div class="panel-body">
      <div class="brand">
        <div class="brand-mark">PI</div>
        <div>
          <div class="brand-title">PI-team Chat</div>
          <div class="brand-sub">PI WEB 会话内核，手机优先聊天壳</div>
        </div>
      </div>
      <div class="toolbar">
        <button class="primary-btn" id="newSessionBtn" type="button">新建会话</button>
        <a class="ghost-btn" id="teamModeLink" href="/team" style="text-decoration:none;display:grid;place-items:center;">Team 模式</a>
      </div>
      <div class="panel-title">
        <h2>Sessions</h2>
        <span class="session-status" id="sessionCount">0</span>
      </div>
      <div class="session-list" id="sessionList"></div>
      <div class="share-wrap">${input.desktopSharePanel ?? ""}</div>
    </div>
  </aside>

  <main class="conversation">
    <header class="topbar">
      <div class="mobile-bar">
        <button class="ghost-btn" id="openSessionsBtn" type="button">会话</button>
        <button class="ghost-btn" id="openInsightBtn" type="button">进度</button>
      </div>
      <div class="topbar-main">
        <div class="topbar-title">
          <div class="eyebrow">Chat Mode</div>
          <div class="title-row">
            <h1 id="chatTitle">还没选会话</h1>
            <span class="status-chip" id="runChip">空闲</span>
            <span class="pending-chip" id="pendingChip" hidden>下轮生效</span>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="mode-links">
            <a class="pill-btn active" id="chatModeLink" href="/" style="text-decoration:none;">Chat</a>
            <a class="pill-btn" id="teamModeLinkTop" href="/team" style="text-decoration:none;">Team</a>
          </div>
          <button class="ghost-btn danger" id="stopBtn" type="button">Stop</button>
        </div>
      </div>
      <div class="topbar-controls">
        <label class="field">模型
          <select class="field-input" id="modelSelect"></select>
        </label>
        <label class="field">思考强度
          <select class="field-input" id="thinkingSelect"></select>
        </label>
      </div>
    </header>

    <section class="messages" id="messages">
      <div class="empty-state">
        <h3>会话内容会在这里流出来</h3>
        <p>你可以在电脑或手机上同时打开它。只要底层是同一个 PI WEB session，消息、过程、工具进度都会同步。</p>
      </div>
    </section>

    <section class="composer">
      <div class="banner" id="errorBanner"></div>
      <div class="composer-box">
        <textarea id="composerInput" placeholder="输入消息。空闲时点 Send；运行中可以点 Follow 或 Steer。"></textarea>
        <div class="composer-actions">
          <div class="composer-hint" id="composerHint">消息会直接发到当前会话。</div>
          <div class="action-group">
            <button class="ghost-btn" id="followBtn" type="button">Follow</button>
            <button class="ghost-btn" id="steerBtn" type="button">Steer</button>
            <button class="primary-btn" id="sendBtn" type="button">Send</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <aside class="panel panel-right" id="insightPanel">
    <div class="panel-body stack">
      <section class="card">
        <h3>当前状态</h3>
        <div class="stat"><span>连接</span><strong id="connectionText">准备中</strong></div>
        <div class="stat"><span>模型</span><strong id="modelText">-</strong></div>
        <div class="stat"><span>思考</span><strong id="thinkingText">-</strong></div>
        <div class="stat"><span>运行</span><strong id="runText">空闲</strong></div>
        <div class="stat"><span>活动</span><strong id="activityText">-</strong></div>
      </section>
      <section class="card">
        <h3>排队输入</h3>
        <div class="queue-list" id="queueList"></div>
      </section>
      <section class="card">
        <h3>Tools / Progress</h3>
        <div class="tool-list" id="toolList"></div>
      </section>
    </div>
  </aside>

  <script>
    (() => {
      const query = new URLSearchParams(window.location.search);
      const sessionPanel = document.getElementById("sessionPanel");
      const insightPanel = document.getElementById("insightPanel");
      const messagesEl = document.getElementById("messages");
      const sessionListEl = document.getElementById("sessionList");
      const sessionCountEl = document.getElementById("sessionCount");
      const chatTitleEl = document.getElementById("chatTitle");
      const runChipEl = document.getElementById("runChip");
      const pendingChipEl = document.getElementById("pendingChip");
      const modelSelectEl = document.getElementById("modelSelect");
      const thinkingSelectEl = document.getElementById("thinkingSelect");
      const sendBtn = document.getElementById("sendBtn");
      const followBtn = document.getElementById("followBtn");
      const steerBtn = document.getElementById("steerBtn");
      const stopBtn = document.getElementById("stopBtn");
      const inputEl = document.getElementById("composerInput");
      const bannerEl = document.getElementById("errorBanner");
      const connectionTextEl = document.getElementById("connectionText");
      const modelTextEl = document.getElementById("modelText");
      const thinkingTextEl = document.getElementById("thinkingText");
      const runTextEl = document.getElementById("runText");
      const activityTextEl = document.getElementById("activityText");
      const queueListEl = document.getElementById("queueList");
      const toolListEl = document.getElementById("toolList");
      const composerHintEl = document.getElementById("composerHint");
      const chatModeLink = document.getElementById("chatModeLink");
      const teamModeLink = document.getElementById("teamModeLink");
      const teamModeLinkTop = document.getElementById("teamModeLinkTop");

      chatModeLink.href = "/" + window.location.search;
      teamModeLink.href = "/team" + window.location.search;
      teamModeLinkTop.href = "/team" + window.location.search;

      const state = {
        snapshot: null,
        ws: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        loadGeneration: 0,
        navigationGeneration: 0,
        loading: false,
        watermark: 0,
      };

      function apiUrl(path) {
        const url = new URL(path, window.location.origin);
        query.forEach((value, key) => url.searchParams.set(key, value));
        return url.toString();
      }

      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text);
        }
        window.prompt("复制内容", text);
        return Promise.resolve();
      }

      function setBanner(message) {
        if (!message) {
          bannerEl.classList.remove("show");
          bannerEl.textContent = "";
          return;
        }
        bannerEl.textContent = String(message);
        bannerEl.classList.add("show");
      }

      function busy(snapshot) {
        return !!(snapshot && snapshot.activeRun && snapshot.activeRun.status !== "idle");
      }

      function setDisabled(el, disabled) {
        el.disabled = !!disabled;
      }

      function renderSessions(snapshot) {
        sessionCountEl.textContent = String((snapshot.sessions || []).length);
        const nodes = (snapshot.sessions || []).map((session) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "session-card" + (session.active ? " active" : "");
          const name = document.createElement("div");
          name.className = "session-name";
          const left = document.createElement("span");
          left.textContent = session.name || session.preview || session.id;
          const right = document.createElement("span");
          right.className = "session-status";
          right.textContent = session.statusLabel;
          name.append(left, right);
          const preview = document.createElement("div");
          preview.className = "session-preview";
          preview.textContent = session.preview || session.id;
          const meta = document.createElement("div");
          meta.className = "session-meta";
          const count = document.createElement("span");
          count.textContent = String(session.messageCount) + " 条";
          const model = document.createElement("span");
          model.textContent = session.modelLabel || (session.archived ? "只读" : "PI WEB");
          meta.append(count, model);
          button.append(name, preview, meta);
          button.addEventListener("click", () => switchSession(session.id));
          return button;
        });
        sessionListEl.replaceChildren(...(nodes.length ? nodes : [emptyLine("还没有会话，先新建一个。")]));
      }

      function emptyLine(text) {
        const div = document.createElement("div");
        div.className = "session-preview";
        div.textContent = text;
        return div;
      }

      function renderHeader(snapshot) {
        const session = snapshot.session;
        chatTitleEl.textContent = session ? (session.name || session.id) : "还没选会话";
        const runStatus = snapshot.activeRun ? snapshot.activeRun.status : "idle";
        runChipEl.textContent = snapshot.activeRun ? snapshot.activeRun.label : "空闲";
        runChipEl.className = "status-chip " + runStatus;
        pendingChipEl.hidden = !snapshot.currentConfig.appliesNextTurn;
        if (!pendingChipEl.hidden) {
          const pending = [];
          if (snapshot.currentConfig.pendingModel) pending.push(snapshot.currentConfig.pendingModel.provider + "/" + snapshot.currentConfig.pendingModel.model);
          if (snapshot.currentConfig.pendingThinkingLevel !== undefined) pending.push("thinking " + snapshot.currentConfig.pendingThinkingLevel);
          pendingChipEl.textContent = "下轮生效" + (pending.length ? " · " + pending.join(" · ") : "");
        }
        const modelOptions = snapshot.modelOptions || [];
        modelSelectEl.replaceChildren(...modelOptions.map((option) => {
          const node = document.createElement("option");
          node.value = JSON.stringify({ provider: option.provider, model: option.model });
          node.textContent = option.name || (option.provider + "/" + option.model);
          const current = snapshot.currentConfig.model;
          node.selected = !!(current && current.provider === option.provider && current.model === option.model);
          return node;
        }));
        const levels = snapshot.thinkingLevels || [];
        thinkingSelectEl.replaceChildren(...levels.map((level) => {
          const node = document.createElement("option");
          node.value = level;
          node.textContent = level || "默认";
          node.selected = String(snapshot.currentConfig.thinkingLevel || "") === String(level || "");
          return node;
        }));
      }

      function renderMessages(snapshot) {
        const nodes = [];
        const messages = snapshot.messages || [];
        if (!messages.length && !(snapshot.activeRun && snapshot.activeRun.assistantText)) {
          const wrap = document.createElement("div");
          wrap.className = "empty-state";
          const title = document.createElement("h3");
          title.textContent = snapshot.activeSessionId ? "这里会展示完整可复制的对话" : "先新建一个会话";
          const body = document.createElement("p");
          body.textContent = snapshot.activeSessionId
            ? "代码块、长文本、表格都直接保留为可选中文字。"
            : "新建后，电脑和手机打开同一条会话就能一起看流式过程。";
          wrap.append(title, body);
          nodes.push(wrap);
        } else {
          messages.forEach((message) => nodes.push(renderBubble(message, false)));
          if (snapshot.activeRun && (snapshot.activeRun.assistantText || snapshot.activeRun.thinkingText)) {
            const liveMessage = {
              id: "live",
              role: "assistant",
              text: snapshot.activeRun.assistantText || "",
              thinkingText: snapshot.activeRun.thinkingText || "",
              copyText: ((snapshot.activeRun.assistantText || "") + (snapshot.activeRun.thinkingText ? "\\n\\n[thinking]\\n" + snapshot.activeRun.thinkingText : "")).trim(),
            };
            nodes.push(renderBubble(liveMessage, true));
          }
        }
        messagesEl.replaceChildren(...nodes);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function renderBubble(message, live) {
        const row = document.createElement("div");
        row.className = "message-row " + (message.role === "user" ? "user" : "assistant");
        const bubble = document.createElement("article");
        bubble.className = "bubble";
        const head = document.createElement("div");
        head.className = "bubble-head";
        const label = document.createElement("div");
        label.className = "bubble-label";
        label.textContent = message.role === "user"
          ? "You"
          : live
            ? "Assistant · live"
            : message.role === "assistant"
              ? "Assistant"
              : message.role;
        const actions = document.createElement("div");
        actions.className = "bubble-actions";
        if (message.role === "assistant") {
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "tiny-btn";
          copy.textContent = "复制";
          copy.addEventListener("click", () => {
            void copyText(message.copyText || message.text || "");
          });
          actions.append(copy);
        }
        head.append(label, actions);
        const pre = document.createElement("pre");
        pre.className = "bubble-text";
        pre.textContent = message.text || "";
        bubble.append(head, pre);
        if (message.thinkingText) {
          const details = document.createElement("details");
          details.className = "bubble-thinking";
          if (live) details.open = true;
          const summary = document.createElement("summary");
          summary.textContent = live ? "实时 thinking" : "查看 thinking";
          const thinking = document.createElement("pre");
          thinking.textContent = message.thinkingText;
          details.append(summary, thinking);
          bubble.append(details);
        }
        row.append(bubble);
        return row;
      }

      function renderInsights(snapshot) {
        const currentModel = snapshot.currentConfig.model;
        connectionTextEl.textContent = snapshot.connectionState.message || snapshot.connectionState.status;
        modelTextEl.textContent = currentModel ? (currentModel.name || (currentModel.provider + "/" + currentModel.model)) : "-";
        thinkingTextEl.textContent = snapshot.currentConfig.thinkingLevel === "" ? "默认" : (snapshot.currentConfig.thinkingLevel || "-");
        runTextEl.textContent = snapshot.activeRun ? snapshot.activeRun.label : "空闲";
        activityTextEl.textContent = snapshot.activeRun && snapshot.activeRun.activityLabel
          ? snapshot.activeRun.activityLabel + (snapshot.activeRun.activityDetail ? " · " + snapshot.activeRun.activityDetail : "")
          : "-";
        const queues = (snapshot.queuedInputs || []).map((item) => {
          const node = document.createElement("div");
          node.className = "queue-item";
          const kind = document.createElement("div");
          kind.className = "queue-kind";
          const left = document.createElement("span");
          left.textContent = item.kind === "steer" ? "Steer" : "Follow";
          const right = document.createElement("span");
          right.textContent = "已排队";
          kind.append(left, right);
          const text = document.createElement("div");
          text.className = "queue-text";
          text.textContent = item.text || "";
          node.append(kind, text);
          return node;
        });
        queueListEl.replaceChildren(...(queues.length ? queues : [emptyLine("当前没有排队输入。")]));

        const tools = (snapshot.toolStates || []).map((tool) => {
          const node = document.createElement("div");
          node.className = "tool-item";
          const head = document.createElement("div");
          head.className = "tool-head";
          const left = document.createElement("span");
          left.textContent = tool.toolName + (tool.summary ? " · " + tool.summary : "");
          const right = document.createElement("span");
          right.className = "tool-state-" + tool.status;
          right.textContent = tool.status;
          head.append(left, right);
          node.append(head);
          if (tool.text) {
            const text = document.createElement("div");
            text.className = "tool-text";
            text.textContent = tool.text;
            node.append(text);
          }
          return node;
        });
        toolListEl.replaceChildren(...(tools.length ? tools : [emptyLine("这里会显示 tool / progress。")]));
      }

      function renderActions(snapshot) {
        const hasSession = !!snapshot.activeSessionId;
        const isBusy = busy(snapshot);
        const readOnly = !!(snapshot.session && snapshot.session.readOnly);
        composerHintEl.textContent = !hasSession
          ? "先新建一个会话。"
          : readOnly
            ? "归档会话只读。"
            : isBusy
              ? "当前正在运行，你可以补 Follow 或 Steer。"
              : "当前空闲，直接 Send 即可。";
        setDisabled(sendBtn, !hasSession || readOnly || isBusy || state.loading);
        setDisabled(followBtn, !hasSession || readOnly || !isBusy || state.loading);
        setDisabled(steerBtn, !hasSession || readOnly || !isBusy || state.loading);
        setDisabled(stopBtn, !hasSession || readOnly || !isBusy || state.loading);
        setDisabled(modelSelectEl, !hasSession || readOnly || state.loading);
        setDisabled(thinkingSelectEl, !hasSession || readOnly || state.loading);
      }

      function render(snapshot) {
        if (!snapshot) return;
        renderSessions(snapshot);
        renderHeader(snapshot);
        renderMessages(snapshot);
        renderInsights(snapshot);
        renderActions(snapshot);
      }

      async function request(path, body) {
        const response = await fetch(apiUrl(path), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json();
        if (!response.ok || payload.error) {
          throw new Error(payload.error || payload.message || "request failed");
        }
        return payload;
      }

      async function loadSnapshot(options) {
        const generation = ++state.loadGeneration;
        const selectedId = state.snapshot && state.snapshot.activeSessionId;
        const reconnect = !options || options.reconnect !== false;
        state.loading = true;
        renderActions(state.snapshot || { activeSessionId: null, activeRun: null, session: null });
        try {
          const response = await fetch(apiUrl("/api/chat/snapshot"));
          const snapshot = await response.json();
          if (generation !== state.loadGeneration || selectedId !== (state.snapshot && state.snapshot.activeSessionId)) return;
          if (!response.ok || snapshot.error) {
            throw new Error(snapshot.error || "snapshot failed");
          }
          state.snapshot = snapshot;
          state.watermark = snapshot.upstreamSeq || 0;
          render(snapshot);
          setBanner("");
          if (reconnect) connectSocket(snapshot);
        } catch (error) {
          setBanner(error instanceof Error ? error.message : String(error));
        } finally {
          state.loading = false;
          if (state.snapshot) renderActions(state.snapshot);
        }
      }

      function connectSocket(snapshot) {
        if (!snapshot) return;
        const params = new URLSearchParams(window.location.search);
        params.set("streamId", snapshot.eventStreamId || "__global__");
        params.set("cursor", String(snapshot.cursor || 0));
        if (snapshot.activeSessionId) params.set("sessionId", snapshot.activeSessionId);
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = protocol + "//" + window.location.host + "/api/chat/events?" + params.toString();
        if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
        const previous = state.ws;
        state.ws = null;
        if (previous) previous.close();
        const socket = new WebSocket(url);
        state.ws = socket;
        socket.onopen = () => { if (state.ws === socket) state.reconnectAttempt = 0; };
        socket.onmessage = (message) => {
          if (state.ws !== socket) return;
          const event = JSON.parse(message.data);
          if (event.streamId && event.streamId !== (snapshot.eventStreamId || "__global__")) return;
          if (event.upstreamSeq && event.upstreamSeq <= state.watermark) return;
          applyEvent(event);
        };
        socket.onclose = () => {
          if (state.ws !== socket) return;
          if (state.snapshot) {
            state.snapshot.connectionState = { status: "connecting", message: "连接断开，正在重连" };
            renderInsights(state.snapshot);
            renderActions(state.snapshot);
          }
          state.reconnectTimer = window.setTimeout(() => {
            if (state.ws !== socket) return;
            void loadSnapshot({ reconnect: true });
          }, Math.min(10_000, 700 * Math.pow(2, state.reconnectAttempt++ || 0)));
        };
      }

      function upsertTool(tool) {
        const tools = state.snapshot.toolStates || [];
        const index = tools.findIndex((item) => item.toolCallId === tool.toolCallId);
        if (index >= 0) tools[index] = tool;
        else tools.unshift(tool);
        state.snapshot.toolStates = tools.slice(0, 24);
      }

      function applyEvent(event) {
        if (!state.snapshot) return;
        state.snapshot.cursor = event.cursor || state.snapshot.cursor;
        if (event.type === "assistant.delta") {
          state.snapshot.activeRun = state.snapshot.activeRun || {
            status: "streaming",
            label: "流式输出中",
            assistantText: "",
            thinkingText: "",
          };
          state.snapshot.activeRun.assistantText += event.text || "";
          renderMessages(state.snapshot);
          return;
        }
        if (event.type === "thinking.delta") {
          state.snapshot.activeRun = state.snapshot.activeRun || {
            status: "streaming",
            label: "流式输出中",
            assistantText: "",
            thinkingText: "",
          };
          state.snapshot.activeRun.thinkingText += event.text || "";
          renderMessages(state.snapshot);
          return;
        }
        if (event.type === "tool.start" || event.type === "tool.update" || event.type === "tool.end") {
          if (event.tool) upsertTool(event.tool);
          renderInsights(state.snapshot);
          return;
        }
        if (event.type === "run.status") {
          state.snapshot.connectionState = event.connectionState || state.snapshot.connectionState;
          state.snapshot.queuedInputs = Array.isArray(event.queuedInputs) ? event.queuedInputs : state.snapshot.queuedInputs;
          if (event.currentConfig) state.snapshot.currentConfig = event.currentConfig;
          if (event.status === "idle" && !(state.snapshot.activeRun && state.snapshot.activeRun.assistantText)) {
            state.snapshot.activeRun = null;
          } else {
            state.snapshot.activeRun = state.snapshot.activeRun || { status: event.status || "queued", label: event.label || "处理中", assistantText: "", thinkingText: "" };
            state.snapshot.activeRun.status = event.status || state.snapshot.activeRun.status;
            state.snapshot.activeRun.label = event.label || state.snapshot.activeRun.label;
            state.snapshot.activeRun.activityLabel = event.activityLabel;
            state.snapshot.activeRun.activityDetail = event.activityDetail;
          }
          renderHeader(state.snapshot);
          renderInsights(state.snapshot);
          renderActions(state.snapshot);
          return;
        }
        if (event.type === "input.queued") {
          const current = state.snapshot.queuedInputs || [];
          const next = Array.isArray(event.queuedInputs) ? event.queuedInputs : [];
          state.snapshot.queuedInputs = next.concat(current).slice(0, 12);
          renderInsights(state.snapshot);
          return;
        }
        if (event.type === "session.updated") {
          if (Array.isArray(event.sessions)) {
            state.snapshot.sessions = event.sessions.map((item) => ({
              ...item,
              active: item.id === state.snapshot.activeSessionId,
            }));
            renderSessions(state.snapshot);
          }
          if (event.currentConfig && event.sessionId === state.snapshot.activeSessionId) {
            state.snapshot.currentConfig = event.currentConfig;
            renderHeader(state.snapshot);
            renderInsights(state.snapshot);
          }
          return;
        }
        if (event.type === "assistant.done") {
          state.watermark = event.upstreamSeq || state.watermark;
          void loadSnapshot({ reconnect: false });
          return;
        }
        if (event.type === "snapshot.invalidated") {
          void loadSnapshot({ reconnect: true });
          return;
        }
        if (event.type === "error") {
          setBanner(event.message || "发生错误");
        }
      }

      function beginNavigation() {
        state.loadGeneration++;
        state.navigationGeneration++;
        const previous = state.ws;
        state.ws = null;
        if (previous) previous.close();
        if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
        return state.navigationGeneration;
      }

      async function switchSession(sessionId) {
        const generation = beginNavigation();
        try {
          const payload = await request("/api/chat/session/switch", { sessionId });
          if (generation !== state.navigationGeneration) return;
          state.snapshot = payload.snapshot;
          state.watermark = payload.snapshot.upstreamSeq || 0;
          render(state.snapshot);
          connectSocket(state.snapshot);
          setBanner("");
          sessionPanel.classList.remove("open");
        } catch (error) {
          if (generation !== state.navigationGeneration) return;
          if (state.snapshot) connectSocket(state.snapshot);
          setBanner(error instanceof Error ? error.message : String(error));
        }
      }

      async function send(mode) {
        const text = inputEl.value.trim();
        if (!text || !state.snapshot || !state.snapshot.activeSessionId) return;
        const generation = state.navigationGeneration;
        try {
          state.loading = true;
          renderActions(state.snapshot);
          const payload = await request(mode === "send"
            ? "/api/chat/send"
            : mode === "followUp"
              ? "/api/chat/follow"
              : "/api/chat/steer", {
            sessionId: state.snapshot.activeSessionId,
            message: text,
          });
          if (generation !== state.navigationGeneration) return;
          state.snapshot = payload.snapshot;
          state.watermark = payload.snapshot.upstreamSeq || 0;
          inputEl.value = "";
          render(state.snapshot);
          setBanner("");
        } catch (error) {
          setBanner(error instanceof Error ? error.message : String(error));
        } finally {
          state.loading = false;
          if (state.snapshot) renderActions(state.snapshot);
        }
      }

      async function newSession() {
        const generation = beginNavigation();
        try {
          const current = state.snapshot && state.snapshot.currentConfig ? state.snapshot.currentConfig : {};
          const payload = await request("/api/chat/session/new", {
            ...(current.model ? { model: current.model.model, provider: current.model.provider } : {}),
            ...(current.thinkingLevel !== undefined ? { thinkingLevel: current.thinkingLevel } : {}),
          });
          if (generation !== state.navigationGeneration) return;
          state.snapshot = payload.snapshot;
          state.watermark = payload.snapshot.upstreamSeq || 0;
          render(state.snapshot);
          connectSocket(state.snapshot);
          setBanner("");
          sessionPanel.classList.remove("open");
        } catch (error) {
          setBanner(error instanceof Error ? error.message : String(error));
        }
      }

      async function stopRun() {
        if (!state.snapshot || !state.snapshot.activeSessionId) return;
        const generation = state.navigationGeneration;
        try {
          const payload = await request("/api/chat/stop", { sessionId: state.snapshot.activeSessionId });
          if (generation !== state.navigationGeneration) return;
          state.snapshot = payload.snapshot;
          state.watermark = payload.snapshot.upstreamSeq || 0;
          render(state.snapshot);
          setBanner("");
        } catch (error) {
          setBanner(error instanceof Error ? error.message : String(error));
        }
      }

      async function saveConfig() {
        if (!state.snapshot || !state.snapshot.activeSessionId) return;
        const generation = state.navigationGeneration;
        let model;
        try {
          model = modelSelectEl.value ? JSON.parse(modelSelectEl.value) : null;
        } catch {
          model = null;
        }
        try {
          const payload = await request("/api/chat/session/config", {
            sessionId: state.snapshot.activeSessionId,
            ...(model ? { provider: model.provider, model: model.model } : {}),
            thinkingLevel: thinkingSelectEl.value,
          });
          if (generation !== state.navigationGeneration) return;
          state.snapshot = payload.snapshot;
          state.watermark = payload.snapshot.upstreamSeq || 0;
          render(state.snapshot);
          setBanner("");
        } catch (error) {
          setBanner(error instanceof Error ? error.message : String(error));
        }
      }

      document.getElementById("newSessionBtn").addEventListener("click", () => { void newSession(); });
      document.getElementById("openSessionsBtn").addEventListener("click", () => sessionPanel.classList.toggle("open"));
      document.getElementById("openInsightBtn").addEventListener("click", () => insightPanel.classList.toggle("open"));
      sendBtn.addEventListener("click", () => { void send("send"); });
      followBtn.addEventListener("click", () => { void send("followUp"); });
      steerBtn.addEventListener("click", () => { void send("steer"); });
      stopBtn.addEventListener("click", () => { void stopRun(); });
      modelSelectEl.addEventListener("change", () => { void saveConfig(); });
      thinkingSelectEl.addEventListener("change", () => { void saveConfig(); });
      inputEl.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void send(busy(state.snapshot) ? "followUp" : "send");
        }
      });

      void loadSnapshot({ reconnect: true });
    })();
  </script>
</body>
</html>`;
}
