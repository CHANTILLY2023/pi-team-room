/**
 * Crew - Progress Tracking
 * 
 * Real-time visibility into agent execution via --mode json event parsing.
 */

export interface ToolEntry {
  tool: string;
  args: string;
  startMs: number;
  endMs: number;
}

export interface AgentProgress {
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartMs?: number;
  recentTools: ToolEntry[];
  toolCallCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
}

// Event types from pi's --mode json output
export interface PiEvent {
  type: string;
  [key: string]: unknown;
  toolName?: string;
  args?: Record<string, unknown>;
  message?: {
    role: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    errorMessage?: string;
  };
}

export function createProgress(agent: string): AgentProgress {
  return {
    agent,
    status: "pending",
    recentTools: [],
    toolCallCount: 0,
    tokens: 0,
    durationMs: 0,
  };
}

export function parseJsonlLine(line: string): PiEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function updateProgress(progress: AgentProgress, event: PiEvent, startTime: number): void {
  progress.durationMs = Date.now() - startTime;

  switch (event.type) {
    case "tool_execution_start":
      progress.status = "running";
      progress.currentTool = event.toolName;
      progress.currentToolArgs = extractArgsPreview(event.args);
      progress.currentToolStartMs = Date.now();
      break;

    case "tool_execution_end":
      progress.toolCallCount++;
      if (progress.currentTool) {
        progress.recentTools.push({
          tool: progress.currentTool,
          args: progress.currentToolArgs ?? "",
          startMs: progress.currentToolStartMs ?? Date.now(),
          endMs: Date.now(),
        });
      }
      progress.currentTool = undefined;
      progress.currentToolArgs = undefined;
      progress.currentToolStartMs = undefined;
      break;

    case "message_end":
      if (event.message?.usage) {
        progress.tokens += (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0);
      }
      if (event.message?.errorMessage) {
        progress.error = event.message.errorMessage;
      }
      break;
  }
}

function extractArgsPreview(args?: Record<string, unknown>): string {
  if (!args) return "";
  const previewKeys = ["command", "path", "file_path", "pattern", "query"];
  for (const key of previewKeys) {
    if (args[key] && typeof args[key] === "string") {
      const value = (args[key] as string).replaceAll("\n", " ").replaceAll("\r", "");
      return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    }
  }
  return "";
}

export function getAssistantText(event: PiEvent): string {
  if (event.type !== "message_end" || event.message?.role !== "assistant") return "";
  for (const part of event.message.content ?? []) {
    if (part.type === "text" && part.text) return part.text;
  }
  return "";
}

export function getFinalOutput(messages: PiEvent[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = getAssistantText(messages[i]);
    if (text) return text;
  }
  return "";
}

export function compactEventForArtifact(event: PiEvent): Record<string, unknown> {
  if (event.type !== "message_update") return event as Record<string, unknown>;

  const compact: Record<string, unknown> = { ...event };
  delete compact.message;

  const assistantMessageEvent = compact.assistantMessageEvent;
  if (assistantMessageEvent && typeof assistantMessageEvent === "object") {
    const nested = { ...(assistantMessageEvent as Record<string, unknown>) };
    delete nested.partial;
    compact.assistantMessageEvent = nested;
  }

  return compact;
}

export function getTerminalProviderError(event: PiEvent): string | null {
  const status = findStatusCode(event);
  if (status === undefined || ![400, 401, 402, 403, 429].includes(status)) return null;

  const text = collectStrings(event).join(" ");
  const normalized = text.toLowerCase();
  if (!/(usage|quota|credit|billing|auth|unauthor|forbidden|rate limit|invalid_request|add more|plan limits|third-party apps)/.test(normalized)) {
    return null;
  }

  const message = firstUsefulMessage(event) ?? text;
  const concise = message.replace(/\s+/g, " ").trim().slice(0, 500);
  return `Provider error ${status}: ${concise || "non-retryable provider error"}`;
}

function findStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["status", "statusCode", "httpStatus", "code"].includes(key) && typeof child === "number") return child;
    const nested = findStatusCode(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(item => collectStrings(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(item => collectStrings(item, depth + 1));
}

function firstUsefulMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "errorMessage", "detail", "details"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  for (const child of Object.values(record)) {
    const nested = firstUsefulMessage(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}
