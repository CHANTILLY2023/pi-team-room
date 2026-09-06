import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { piWebJson } from "./pi-web-http.ts";
import type { TeamStore } from "./store.ts";
import { readHistoryInside, readNativeProcessTurns, type NativeProcessHomes } from "./native-process-history.ts";
import { parseTurnOutput } from "./protocol.ts";

export interface ProcessTool {
  toolCallId: string;
  toolName: string;
  summary?: string;
  text?: string;
  status: "running" | "completed" | "error";
}

export interface TurnProcess {
  version: 1;
  status: "partial" | "complete" | "unavailable";
  origin: "runtime" | "legacy";
  thinkingText: string;
  answerSteps: string[];
  tools: ProcessTool[];
  reason?: "not_recorded" | "no_matching_turn";
}

export interface ProcessCapture {
  data: TurnProcess;
  sessionFile?: string;
  messageStart?: number;
}

export interface StoredProcess extends ProcessCapture {
  invocationId: string;
  generation: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(record).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

export function collectTurnProcess(messages: unknown[], status: TurnProcess["status"], origin: TurnProcess["origin"]): TurnProcess {
  const thinking: string[] = [];
  const answerSteps: string[] = [];
  const tools = new Map<string, ProcessTool>();
  for (const message of messages) {
    if (!record(message)) continue;
    if (message.role === "assistant") {
      const answer = contentText(message.content).trim();
      if (answer) answerSteps.push(answer);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!record(part)) continue;
        if (part.type === "thinking") {
          const text = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
          if (text) thinking.push(text);
        } else if (part.type === "toolCall" && typeof part.id === "string") {
          tools.set(part.id, { toolCallId: part.id, toolName: String(part.name || "tool"), summary: JSON.stringify(part.arguments ?? {}, null, 2), status: "running" });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const previous = tools.get(message.toolCallId);
      tools.set(message.toolCallId, {
        ...previous,
        toolCallId: message.toolCallId,
        toolName: String(message.toolName || previous?.toolName || "tool"),
        text: contentText(message.content),
        status: message.isError ? "error" : "completed",
      });
    }
  }
  return { version: 1, status, origin, thinkingText: thinking.join("\n\n"), answerSteps, tools: [...tools.values()] };
}

export async function readPiWebHistory(baseUrl: string, sessionId: string, cwd: string, options: { after?: number; signal?: AbortSignal } = {}): Promise<{ messages: unknown[]; start: number; total: number }> {
  const deadline = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const after = options.after ?? 0;
  let before: number | undefined;
  let total: number | undefined;
  let messages: unknown[] = [];
  for (;;) {
    const query = new URLSearchParams({ cwd, limit: "200", ...(before === undefined ? {} : { before: String(before) }) });
    const value = await piWebJson(`${baseUrl.replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`, { signal });
    if (Array.isArray(value) && before === undefined) {
      if (after > value.length) throw new Error("PI WEB history was reset during this invocation");
      return { messages: value.slice(after), start: after, total: value.length };
    }
    if (record(value) && Array.isArray(value.messages) && value.start === undefined && value.total === undefined && before === undefined) {
      if (after > value.messages.length) throw new Error("PI WEB history was reset during this invocation");
      return { messages: value.messages.slice(after), start: after, total: value.messages.length };
    }
    if (!record(value) || !Array.isArray(value.messages) || !Number.isInteger(value.start) || !Number.isInteger(value.total)) throw new Error("Invalid PI WEB history pagination");
    const start = value.start as number;
    const currentTotal = value.total as number;
    total ??= currentTotal;
    const end = before ?? total;
    if (start < 0 || start + value.messages.length !== end || currentTotal < total || (before !== undefined && start >= before)) throw new Error("PI WEB history pagination changed or made no progress");
    if (after > total) throw new Error("PI WEB history was reset during this invocation");
    messages = [...value.messages, ...messages];
    if (start <= after) return { messages: messages.slice(after - start), start: after, total };
    before = start;
  }
}

// Only the last canonical source marker in the prompt identifies this turn.
// Equal final text alone is not an identity, particularly for repeated replies.
export function matchLegacyTurn(messages: unknown[], target: { sourceId: string; sourceSeq: number; finalText: string; protocol?: boolean }): unknown[] | undefined {
  const matches: unknown[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!record(message) || message.role !== "user") continue;
    if (!matchesSource(contentText(message.content), target)) continue;
    let end = index + 1;
    while (end < messages.length && !(record(messages[end]) && (messages[end] as Record<string, unknown>).role === "user")) end++;
    const turn = messages.slice(index + 1, end);
    const answers = turn.filter(record).filter(item => item.role === "assistant");
    const last = answers.at(-1);
    if (last && !last.errorMessage && matchesFinal(contentText(last.content), target)) matches.push(turn);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function matchesFinal(text: string, target: { finalText: string; protocol?: boolean }): boolean {
  try { return (target.protocol ? parseTurnOutput(text).content : text).trim() === target.finalText.trim(); }
  catch { return false; }
}

function matchesSource(prompt: string, target: { sourceId: string; sourceSeq: number }): boolean {
  const marker = [...prompt.matchAll(/^\[thread seq (\d+) message ([^\]\n]+)\] (?:user|system|Agent [^:\n]+):$/gm)].at(-1);
  return !!marker && marker[2] === target.sourceId && Number(marker[1]) === target.sourceSeq;
}

function identifiesAgent(prompt: string, agentId: string): boolean {
  return prompt.split("\n").some(line => line.startsWith(`Identity constant: \`@${agentId}\` `));
}

async function expandFreshPrompt(prompt: string, cwd: string, agentId: string): Promise<string> {
  const match = /^\/fresh task Read task intake from (\.pi\/task-inbox\/[^\r\n]+?\.md)\. Current session/.exec(prompt);
  if (!match) return prompt;
  const file = await readHistoryInside(resolve(cwd, match[1]), join(cwd, ".pi/task-inbox"));
  return identifiesAgent(file, agentId) ? file : prompt;
}

async function expandPiPrompts(messages: unknown[], cwd: string, agentId: string): Promise<unknown[]> {
  const expanded: unknown[] = [];
  for (const message of messages) {
    if (!record(message) || message.role !== "user") { expanded.push(message); continue; }
    try { expanded.push({ ...message, content: await expandFreshPrompt(contentText(message.content), cwd, agentId) }); }
    catch (error) {
      if (record(error) && error.code === "ENOENT") expanded.push(message);
      else throw error;
    }
  }
  return expanded;
}

async function readPiSession(file: string, root: string): Promise<unknown[]> {
  const [actualFile, actualRoot] = await Promise.all([realpath(file), realpath(root)]);
  const inside = relative(actualRoot, actualFile);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("PI history is outside the Team session directory");
  const entries = (await readFile(actualFile, "utf8")).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).filter(record);
  const byId = new Map(entries.filter(entry => typeof entry.id === "string").map(entry => [entry.id, entry]));
  let entry = entries.at(-1);
  if (!entry || typeof entry.id !== "string") return entries.filter(item => item.type === "message").map(item => item.message);
  const branch: unknown[] = [];
  const seen = new Set<unknown>();
  while (entry) {
    if (seen.has(entry.id)) throw new Error("Invalid PI session parent chain");
    seen.add(entry.id);
    if (entry.type === "message") branch.unshift(entry.message);
    if (typeof entry.parentId !== "string") break;
    const parent = byId.get(entry.parentId);
    if (!parent) throw new Error("Incomplete PI session parent chain");
    entry = parent;
  }
  return branch;
}

export async function recoverTurnProcess(store: TeamStore, messageId: string, options: { baseUrl?: string; sessionRoot?: string; signal?: AbortSignal; nativeHomes?: NativeProcessHomes } = {}): Promise<TurnProcess> {
  const deadline = AbortSignal.timeout(15_000);
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
  const final = store.getMessage(messageId);
  const invocation = final?.parentInvocationId ? store.getInvocation(final.parentInvocationId) : undefined;
  const unavailable = (reason: TurnProcess["reason"]): TurnProcess => ({ ...collectTurnProcess([], "unavailable", "legacy"), reason });
  if (!final || final.authorType !== "agent") throw new Error("Team agent message required for process recovery");
  if (!invocation) return unavailable("not_recorded");
  if (invocation.threadId !== final.threadId || invocation.targetAgentId !== final.authorId || invocation.status !== "completed") throw new Error("Completed Team invocation required for process recovery");
  const saved = store.getInvocationProcess(invocation.id);
  if (saved?.data.status === "complete") return saved.data;
  const source = store.getMessage(invocation.sourceMessageId);
  const binding = store.getSessionBinding(final.threadId, final.authorId);
  let file = saved?.sessionFile ?? binding?.sessionFile;
  if (!binding || !source || !file) return unavailable("not_recorded");
  const target = { sourceId: source.id, sourceSeq: source.seq, finalText: final.content, protocol: final.protocol?.version === 1 };
  if (file.startsWith("grok-session:") || file.startsWith("kimi-session:")) {
    options.signal?.throwIfAborted();
    const turns = (await readNativeProcessTurns(file, binding.cwd, options.nativeHomes)).filter(turn => matchesSource(turn.prompt, target));
    const turn = turns.length === 1 ? turns[0] : undefined;
    if (!turn) return saved?.data ?? unavailable("no_matching_turn");
    // Old Kimi wire logs often end before the final step was flushed. Import
    // only the identified fragment and keep it explicitly partial.
    if (file.startsWith("grok-session:") && !matchesFinal(target.protocol ? turn.finalText ?? turn.answerText : turn.answerText, target)) return saved?.data ?? unavailable("no_matching_turn");
    if (!turn.data.thinkingText && !turn.data.tools.length && !turn.data.answerSteps.length) return saved?.data ?? unavailable("not_recorded");
    options.signal?.throwIfAborted();
    store.saveRecoveredProcess(final.id, { data: turn.data, sessionFile: file });
    return turn.data;
  }
  let messages: unknown[];
  let turn: unknown[] | undefined;
  if (file.startsWith("pi-web-session:")) {
    const baseUrl = options.baseUrl ?? process.env.PI_TEAM_PI_WEB_URL ?? process.env.PI_WEB_URL ?? "http://127.0.0.1:8504";
    messages = await expandPiPrompts((await readPiWebHistory(baseUrl, file.slice("pi-web-session:".length), binding.cwd, { signal: options.signal })).messages, binding.cwd, final.authorId);
    turn = matchLegacyTurn(messages, target);
    if (!turn && !saved?.sessionFile) {
      const catalog = await piWebJson(`${baseUrl.replace(/\/+$/, "")}/api/sessions?${new URLSearchParams({ cwd: binding.cwd })}`, { signal: options.signal });
      const candidates: Array<{ file: string; turn: unknown[] }> = [];
      for (const session of Array.isArray(catalog) ? catalog : []) {
        if (!record(session) || typeof session.id !== "string" || session.cwd !== binding.cwd || `pi-web-session:${session.id}` === file || typeof session.firstMessage !== "string") continue;
        const first = await expandFreshPrompt(session.firstMessage, binding.cwd, final.authorId).catch(() => "");
        if (!identifiesAgent(first, final.authorId)) continue;
        const history = await expandPiPrompts((await readPiWebHistory(baseUrl, session.id, binding.cwd, { signal: options.signal })).messages, binding.cwd, final.authorId);
        const matched = matchLegacyTurn(history, target);
        if (matched) candidates.push({ file: `pi-web-session:${session.id}`, turn: matched });
      }
      if (candidates.length === 1) { file = candidates[0].file; turn = candidates[0].turn; }
    }
  } else if (isAbsolute(file)) {
    messages = await expandPiPrompts(await readPiSession(file, options.sessionRoot ?? resolve(join(binding.cwd, ".pi", "messenger", "team-sessions"))), binding.cwd, final.authorId);
    turn = matchLegacyTurn(messages, target);
  } else return unavailable("not_recorded");
  if (!turn) return saved?.data ?? unavailable("no_matching_turn");
  const data = collectTurnProcess(turn, "complete", "legacy");
  options.signal?.throwIfAborted();
  store.saveRecoveredProcess(final.id, { data, sessionFile: file });
  return data;
}
