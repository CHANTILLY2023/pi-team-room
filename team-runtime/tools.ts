import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryScope, MemoryVisibility } from "./memory.ts";
import { MemoryStore } from "./memory.ts";
import { TeamStore } from "./store.ts";
import { TeamRuntimeError, type PersistentAgent, type SessionBinding } from "./types.ts";

const memoryToolParameters = Type.Object({
  action: Type.String({ description: "write, list, or revoke" }),
  scope: Type.Optional(Type.String({ description: "team, thread, or agent_private" })),
  content: Type.Optional(Type.String({ description: "Memory content for write" })),
  memoryId: Type.Optional(Type.String({ description: "Memory ID for revoke" })),
  sourceMessageId: Type.Optional(Type.String({ description: "Canonical source message provenance" })),
  visibility: Type.Optional(Type.String({ description: "team, direct, or private" })),
  visibleTo: Type.Optional(Type.Array(Type.String(), { description: "Authorized stable Agent IDs" })),
  idempotencyKey: Type.Optional(Type.String({ description: "Stable key for retry-safe writes" })),
  limit: Type.Optional(Type.Number({ description: "Maximum records for list" })),
});

type MemoryToolInput = {
  action: string;
  scope?: string;
  content?: string;
  memoryId?: string;
  sourceMessageId?: string;
  visibility?: string;
  visibleTo?: string[];
  idempotencyKey?: string;
  limit?: number;
};

function scope(value: string | undefined): MemoryScope {
  if (value === undefined || value === "thread") return "thread";
  if (value === "team" || value === "agent_private") return value;
  throw new TeamRuntimeError("conflict", `Unknown memory scope: ${value}`);
}

function visibility(value: string | undefined): MemoryVisibility | undefined {
  if (value === undefined) return undefined;
  if (value === "team" || value === "direct" || value === "private") return value;
  throw new TeamRuntimeError("conflict", `Unknown memory visibility: ${value}`);
}

/** Identity-bound memory tool for one persistent PI AgentSession. */
export function createAgentMemoryTool(
  store: TeamStore,
  memory: MemoryStore,
  agent: PersistentAgent,
  binding: SessionBinding,
): ToolDefinition<typeof memoryToolParameters> {
  return {
    name: "team_memory",
    label: "Team memory",
    description: "Write, recall, or revoke durable memory in your current persistent Team. Identity and Team/Thread scope are enforced by the runtime.",
    promptSnippet: "Use team_memory for durable Team, Thread, or private Agent memory",
    promptGuidelines: [
      "Use team_memory only for information worth carrying across turns, and cite sourceMessageId when the memory derives from the canonical Thread.",
      "Use agent_private for your own private working preferences; it is never shared with other Team members.",
    ],
    parameters: memoryToolParameters,
    async execute(_toolCallId, raw: MemoryToolInput) {
      const thread = store.getThread(binding.threadId);
      if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${binding.threadId}`);
      if (!store.getMember(thread.teamId, agent.id)) {
        throw new TeamRuntimeError("permission_denied", `Agent ${agent.id} is not a member of Team ${thread.teamId}`);
      }

      if (raw.action === "write") {
        const selected = scope(raw.scope);
        if (!raw.content?.trim()) throw new TeamRuntimeError("conflict", "content is required for memory write");
        const record = memory.write({
          scope: selected,
          ...(selected === "team" ? { teamId: thread.teamId } : {}),
          ...(selected === "thread" ? { threadId: thread.id } : {}),
          ...(selected === "agent_private" ? {
            teamId: thread.teamId,
            threadId: thread.id,
            ownerAgentId: agent.id,
          } : {}),
          writerType: "agent",
          writerId: agent.id,
          sourceMessageId: raw.sourceMessageId,
          provenance: raw.sourceMessageId ? { sourceMessageId: raw.sourceMessageId } : undefined,
          visibility: selected === "agent_private" ? "private" : visibility(raw.visibility),
          visibleTo: selected === "agent_private" ? [] : raw.visibleTo,
          content: raw.content.trim(),
          idempotencyKey: raw.idempotencyKey,
        });
        return { content: [{ type: "text", text: `Stored ${record.scope} memory ${record.id}.` }], details: { memory: record } };
      }

      if (raw.action === "list") {
        const selected = scope(raw.scope);
        const records = memory.recall({
          scope: selected,
          ...(selected === "team" ? { teamId: thread.teamId } : {}),
          ...(selected === "thread" ? { threadId: thread.id } : {}),
          ...(selected === "agent_private" ? { teamId: thread.teamId, ownerAgentId: agent.id } : {}),
          limit: Math.min(Math.max(raw.limit ?? 20, 1), 100),
        }, agent.id);
        const text = records.length
          ? records.map((record) => `${record.id} [${record.scope}] ${record.content}`).join("\n")
          : "No matching memory.";
        return { content: [{ type: "text", text }], details: { memories: records } };
      }

      if (raw.action === "revoke") {
        if (!raw.memoryId) throw new TeamRuntimeError("conflict", "memoryId is required for revoke");
        const current = memory.get(raw.memoryId, agent.id);
        if (!current || current.teamId !== thread.teamId) {
          throw new TeamRuntimeError("permission_denied", `Memory ${raw.memoryId} is not accessible in the current Team`);
        }
        const record = memory.revoke(raw.memoryId, agent.id);
        return { content: [{ type: "text", text: `Revoked memory ${record.id}.` }], details: { memory: record } };
      }

      throw new TeamRuntimeError("conflict", `Unknown team_memory action: ${raw.action}`);
    },
  };
}

