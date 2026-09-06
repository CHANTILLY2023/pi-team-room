import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AcpTurnProcess, acpNotification, isRecord } from "./providers/acp-process.ts";
import type { TurnProcess } from "./process-history.ts";

export interface NativeProcessTurn { prompt: string; answerText: string; finalText?: string; data: TurnProcess }
export interface NativeProcessHomes { kimi?: string; grok?: string }

export async function readHistoryInside(file: string, root: string): Promise<string> {
  const [actualFile, actualRoot] = await Promise.all([realpath(file), realpath(root)]);
  const inside = relative(actualRoot, actualFile);
  if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) throw new Error("Process history path is outside its authorized directory");
  return readFile(actualFile, "utf8");
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).filter(isRecord);
}

function textParts(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter(isRecord).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
}

function grokTurns(entries: Record<string, unknown>[], sessionId: string): NativeProcessTurn[] {
  const turns: NativeProcessTurn[] = [];
  let prompt = "";
  let collector = new AcpTurnProcess();
  let completed = false;
  let readingPrompt = false;
  const finish = () => { if (prompt) turns.push({ prompt, answerText: collector.answerText, finalText: collector.finalText, data: collector.snapshot(completed ? "complete" : "partial", "legacy") }); };
  for (const entry of entries) {
    const event = acpNotification(entry);
    if (!event || event.sessionId !== sessionId) continue;
    const update = event.update;
    if (update.sessionUpdate === "user_message_chunk") {
      const text = textParts([update.content]);
      if (readingPrompt) prompt += text;
      else { finish(); prompt = text; collector = new AcpTurnProcess(); completed = false; }
      readingPrompt = true;
    } else {
      readingPrompt = false;
      if (update.sessionUpdate === "turn_completed") completed = true;
      else if (!completed) collector.update(update);
    }
  }
  finish();
  return turns;
}

function kimiTurns(entries: Record<string, unknown>[]): NativeProcessTurn[] {
  const turns: NativeProcessTurn[] = [];
  let prompt = "";
  let collector = new AcpTurnProcess();
  const finish = () => { if (prompt) turns.push({ prompt, answerText: collector.answerText, data: collector.snapshot("partial", "legacy") }); };
  for (const entry of entries) {
    if (entry.agentId !== "main") continue;
    if (entry.type === "turn.prompt") { finish(); prompt = textParts(entry.input); collector = new AcpTurnProcess(); }
    if (!prompt || entry.type !== "context.append_loop_event" || !isRecord(entry.event)) continue;
    const event = entry.event;
    if (event.type === "content.part" && isRecord(event.part)) {
      const part = event.part;
      if (part.type === "think" && typeof part.think === "string") collector.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: part.think } });
      if (part.type === "text" && typeof part.text === "string") collector.update({ sessionUpdate: "agent_message_chunk", content: part });
    } else if (event.type === "tool.call") {
      collector.update({ sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: event.name, rawInput: event.args });
    } else if (event.type === "tool.result" && isRecord(event.result)) {
      collector.update({ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: event.result.isError ? "failed" : "completed", rawOutput: [event.result.output, event.result.note].filter(x => typeof x === "string").join("\n") });
    }
  }
  finish();
  return turns;
}

export async function readNativeProcessTurns(marker: string, cwd: string, homes: NativeProcessHomes = {}): Promise<NativeProcessTurn[]> {
  const match = /^(kimi|grok)-session:([A-Za-z0-9_-]+)$/.exec(marker);
  if (!match) return [];
  const [, kind, sessionId] = match;
  try {
    if (kind === "grok") {
      const home = homes.grok ?? join(homedir(), ".grok");
      // macOS CLI processes canonicalize /var to /private/var before indexing.
      const nativeCwd = await realpath(cwd).catch(() => resolve(cwd));
      const root = join(home, "sessions", encodeURIComponent(nativeCwd), sessionId);
      return grokTurns(jsonLines(await readHistoryInside(join(root, "updates.jsonl"), home)), sessionId);
    }
    const home = homes.kimi ?? join(homedir(), ".kimi-code");
    const index = jsonLines(await readHistoryInside(join(home, "session_index.jsonl"), home));
    const entry = index.filter(entry => entry.sessionId === sessionId && typeof entry.workDir === "string" && resolve(entry.workDir) === resolve(cwd)).at(-1);
    if (!entry || typeof entry.sessionDir !== "string") return [];
    const sessionRoot = join(home, "sessions");
    const inside = relative(resolve(sessionRoot), resolve(entry.sessionDir));
    if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) throw new Error("Kimi session index points outside its authorized directory");
    return kimiTurns(jsonLines(await readHistoryInside(join(entry.sessionDir, "agents", "main", "wire.jsonl"), home)));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}
