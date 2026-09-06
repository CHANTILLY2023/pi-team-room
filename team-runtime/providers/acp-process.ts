import type { TurnProcess } from "../process-history.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(isRecord).map(part => {
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "content" && isRecord(part.content)) return outputText([part.content]);
    if (part.type === "diff") return [part.path, part.oldText, part.newText].filter(x => typeof x === "string").join("\n");
    return "";
  }).filter(Boolean).join("\n");
}

// Both Kimi ACP and Grok's streaming-json expose these public session updates.
export class AcpTurnProcess {
  private readonly data: TurnProcess = { version: 1, status: "partial", origin: "runtime", thinkingText: "", answerSteps: [], tools: [] };
  private lastChunk: "thinking" | "answer" | undefined;
  answerText = "";
  finalText = "";

  beginToolBoundary(): void {
    this.lastChunk = undefined;
    this.finalText = "";
  }

  update(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const kind = value.sessionUpdate;
    if ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && isRecord(value.content) && value.content.type === "text" && typeof value.content.text === "string") {
      const text = value.content.text;
      if (!text) return false;
      if (kind === "agent_thought_chunk") {
        this.data.thinkingText += (this.lastChunk !== "thinking" && this.data.thinkingText ? "\n\n" : "") + text;
        this.lastChunk = "thinking";
      } else {
        this.answerText += text;
        this.finalText += text;
        if (this.lastChunk === "answer") this.data.answerSteps[this.data.answerSteps.length - 1] += text;
        else this.data.answerSteps.push(text);
        this.lastChunk = "answer";
      }
      return true;
    }
    if ((kind !== "tool_call" && kind !== "tool_call_update") || typeof value.toolCallId !== "string") return false;
    // Late status-only updates must not erase an answer already received.
    if (kind === "tool_call" || !this.data.tools.some(tool => tool.toolCallId === value.toolCallId)) this.beginToolBoundary();
    let tool = this.data.tools.find(tool => tool.toolCallId === value.toolCallId);
    if (!tool) {
      tool = { toolCallId: value.toolCallId, toolName: "tool", status: "running" };
      this.data.tools.push(tool);
    }
    if (typeof value.title === "string") tool.toolName = value.title;
    if (value.rawInput != null) tool.summary = typeof value.rawInput === "string" ? value.rawInput : JSON.stringify(value.rawInput, null, 2);
    if (value.status === "completed") tool.status = "completed";
    else if (value.status === "failed") tool.status = "error";
    else if (value.status === "pending" || value.status === "in_progress") tool.status = "running";
    if (value.content != null) tool.text = outputText(value.content);
    else if (value.rawOutput != null) tool.text = typeof value.rawOutput === "string" ? value.rawOutput : JSON.stringify(value.rawOutput, null, 2);
    return true;
  }

  snapshot(status: TurnProcess["status"], origin: TurnProcess["origin"] = "runtime"): TurnProcess {
    return { ...this.data, status, origin, answerSteps: [...this.data.answerSteps], tools: this.data.tools.map(tool => ({ ...tool })) };
  }
}

export function acpNotification(value: unknown): { sessionId: string; update: Record<string, unknown> } | undefined {
  if (!isRecord(value)) return;
  const params = isRecord(value.params) ? value.params : value;
  if (typeof params.sessionId === "string" && isRecord(params.update)) return { sessionId: params.sessionId, update: params.update };
}

/** Legacy headless stdout has no IDs on deltas; the child process owns them. */
export function grokTextUpdate(value: unknown, sessionId: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return;
  if (typeof value.sessionId === "string" && value.sessionId !== sessionId) throw new Error("Grok stdout session identity mismatch");
  if ((value.type === "text" || value.type === "thought") && typeof value.data === "string") {
    return { sessionUpdate: value.type === "text" ? "agent_message_chunk" : "agent_thought_chunk", content: { type: "text", text: value.data } };
  }
}
