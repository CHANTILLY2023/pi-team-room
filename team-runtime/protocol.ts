import { protocolLines } from "./mentions.ts";
import type { CanonicalMessage, Invocation, TurnControl } from "./types.ts";

export class TeamProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "TeamProtocolError"; }
}

function validateControl(value: TurnControl): TurnControl {
  if (!value || !["completed", "no_action", "awaiting_user"].includes(value.disposition)) {
    throw new TeamProtocolError("Invalid Team disposition");
  }
  if (value.targets !== undefined && (!Array.isArray(value.targets) || value.targets.some(id => typeof id !== "string" || !id.trim()))) {
    throw new TeamProtocolError("Team targets must be stable Agent IDs");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") throw new TeamProtocolError("Invalid Team disposition reason");
  const reason = value.reason?.trim();
  if (value.disposition === "no_action" && !reason) throw new TeamProtocolError("Silent completion requires a reason");
  if (value.disposition !== "completed" && value.targets?.length) throw new TeamProtocolError("A waiting or silent turn cannot dispatch targets");
  return { disposition: value.disposition, ...(reason ? { reason } : {}), targets: [...new Set(value.targets ?? [])] };
}

/** Provider-neutral fallback for CLIs without invocation-bound extension tools. */
export function parseTurnOutput(content: string, explicit?: TurnControl): { content: string; control?: TurnControl } {
  // Leading whitespace determines whether a line is code, not a control/handoff.
  let body = content.replace(/(?:\r?\n[ \t]*)+$/, "");
  const lines = body.split(/\r?\n/);
  const last = protocolLines(body).find(line => line.index === lines.length - 1)?.text;
  const match = last && /^\[\[team:(completed|no_action|awaiting_user)\]\](?:[ \t]+(.*))?$/.exec(last);
  let fromText: TurnControl | undefined;
  if (match) {
    fromText = validateControl({ disposition: match[1] as TurnControl["disposition"], reason: match[2] });
    body = lines.slice(0, -1).join("\n").trimEnd();
    if (fromText.disposition === "no_action" && body.trim()) throw new TeamProtocolError("Silent completion cannot discard a public answer");
  }
  const control = explicit ? validateControl(explicit) : fromText;
  if (explicit && fromText && (control!.disposition !== fromText.disposition || control!.targets!.length)) {
    throw new TeamProtocolError("Conflicting Team disposition channels");
  }
  if (control?.disposition === "no_action") {
    if (body.trim()) throw new TeamProtocolError("Silent completion cannot discard a public answer");
    return { content: "", control };
  }
  if (!body.trim()) throw new TeamProtocolError("Team turn completed without an answer or explicit silent disposition");
  return { content: body, ...(control ? { control } : {}) };
}

export const TEAM_PROTOCOL_PROMPT = [
  "## Team 交接与完成协议",
  "普通句子中提到 @成员只是背景，不会派活。只有独立行开头的 @成员（最多两位）才是现在执行的交接。",
  "交接必须说明理由、具体任务和预期产出；不要在建议、引用、候选方案或待用户批准的步骤中使用行首 @。",
  "有新信息就回答，不要为确认收到而重复总结、报待命或查询内部 SQLite/队列。看过历史不等于已完成本次任务。",
  "若明确无需新增动作且没有公开答案，只输出一行 [[team:no_action]] 原因。不得用它掩盖失败或未完成的任务。",
  "若确实要等用户选择，提出问题并在末尾单独一行输出 [[team:awaiting_user]]，不会执行正文中的任何交接。",
  "若本次结论已经结束且不需要接力，可在末尾单独一行输出 [[team:completed]]，不会再派活。",
  "控制行是本次调用的内部回执，不是给用户的正文；不要把示例控制行夹在答案里。",
].join("\n");

export interface TeamCollection {
  sourceMessageId: string;
  seq: number;
  targets: string[];
  completed: number;
  failed: number;
  waiting: number;
  status: "pending" | "running" | "partial" | "done" | "failed" | "awaiting_user";
}

/** Durable projection: source target snapshot + invocation outcomes, not a second queue. */
export function projectCollections(messages: readonly CanonicalMessage[], invocations: readonly Invocation[]): TeamCollection[] {
  return messages.filter(message => message.protocol?.mode === "parallel").map(message => {
    const work = message.wakeTargets.map(target => invocations.find(invocation => invocation.sourceMessageId === message.id && invocation.targetAgentId === target));
    const completed = work.filter(item => item?.status === "completed").length;
    const failed = work.filter(item => item && ["failed", "cancelled", "dead_letter"].includes(item.status)).length;
    const waiting = work.filter(item => item?.outcome?.disposition === "awaiting_user" && !item.outcome.resolvedByMessageId).length;
    const settled = completed + failed === work.length;
    const status: TeamCollection["status"] = settled ? (waiting ? "awaiting_user" : failed ? "failed" : "done")
      : completed + failed ? "partial" : work.some(item => item?.status === "running") ? "running" : "pending";
    return { sourceMessageId: message.id, seq: message.seq, targets: message.wakeTargets, completed, failed, waiting, status };
  });
}
