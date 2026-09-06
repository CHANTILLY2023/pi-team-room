import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { TeamRuntimeError, type AgentId, type MessageId, type TeamId, type ThreadId } from "./types.ts";
import { TeamStore } from "./store.ts";

export type MemoryScope = "team" | "thread" | "agent_private";
export type MemoryVisibility = "team" | "direct" | "private";
export type MemoryWriterType = "user" | "agent" | "system";
export type MemoryStatus = "active" | "revoked";

export interface MemoryProvenance {
  sourceMessageId?: MessageId;
  note?: string;
  [key: string]: unknown;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  teamId?: TeamId;
  threadId?: ThreadId;
  ownerAgentId?: AgentId;
  sourceMessageId?: MessageId;
  provenance?: MemoryProvenance;
  writerType: MemoryWriterType;
  writerId: string;
  visibility: MemoryVisibility;
  visibleTo: AgentId[];
  content: string;
  metadata: Record<string, unknown>;
  status: MemoryStatus;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WriteMemoryInput {
  id?: string;
  scope: MemoryScope;
  teamId?: TeamId;
  threadId?: ThreadId;
  ownerAgentId?: AgentId;
  sourceMessageId?: MessageId;
  provenance?: MemoryProvenance;
  writerType: MemoryWriterType;
  writerId: string;
  visibility?: MemoryVisibility;
  visibleTo?: AgentId[];
  content: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt?: string;
}

export interface MemoryRecallQuery {
  scope?: MemoryScope;
  teamId?: TeamId;
  threadId?: ThreadId;
  ownerAgentId?: AgentId;
  after?: string;
  limit?: number;
  includeRevoked?: boolean;
}

type Row = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function memoryFromRow(row: Row): MemoryRecord {
  const provenance = parseJson<MemoryProvenance | undefined>(row.provenance_json, undefined);
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    teamId: optionalString(row.team_id),
    threadId: optionalString(row.thread_id),
    ownerAgentId: optionalString(row.owner_agent_id),
    sourceMessageId: optionalString(row.source_message_id),
    provenance,
    writerType: String(row.writer_type) as MemoryWriterType,
    writerId: String(row.writer_id),
    visibility: String(row.visibility) as MemoryVisibility,
    visibleTo: parseJson<AgentId[]>(row.visible_to_json, []),
    content: String(row.content),
    metadata,
    status: String(row.status) as MemoryStatus,
    idempotencyKey: optionalString(row.idempotency_key),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Durable memory records backed by the coordinator's SQLite database.
 *
 * Memory is intentionally separate from the canonical transcript: a message
 * is an event, while a memory is an explicitly written, ACL-filtered fact or
 * synthesis that can survive a Thread's lifecycle.
 */
export class MemoryStore {
  readonly db: TeamStore["db"];
  private readonly store: TeamStore;

  constructor(store: TeamStore) {
    this.store = store;
    this.db = store.db;
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('team','thread','agent_private')),
        team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        provenance_json TEXT,
        writer_type TEXT NOT NULL CHECK (writer_type IN ('user','agent','system')),
        writer_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('team','direct','private')),
        visible_to_json TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','revoked')),
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'team' AND team_id IS NOT NULL AND thread_id IS NULL AND owner_agent_id IS NULL)
          OR (scope = 'thread' AND team_id IS NOT NULL AND thread_id IS NOT NULL AND owner_agent_id IS NULL)
          OR (scope = 'agent_private' AND owner_agent_id IS NOT NULL)
        ),
        UNIQUE (scope, team_id, thread_id, owner_agent_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(scope, team_id, thread_id, owner_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_records(source_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_idempotency
        ON memory_records(
          scope,
          COALESCE(team_id, ''),
          COALESCE(thread_id, ''),
          COALESCE(owner_agent_id, ''),
          idempotency_key
        )
        WHERE idempotency_key IS NOT NULL;
    `);
  }

  private requireTeam(teamId: TeamId): void {
    if (!this.store.getTeam(teamId)) throw new TeamRuntimeError("not_found", `Team not found: ${teamId}`, { teamId });
  }

  private requireThread(threadId: ThreadId): NonNullable<ReturnType<TeamStore["getThread"]>> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${threadId}`, { threadId });
    return thread;
  }

  private requireAgent(agentId: AgentId): void {
    if (!this.store.getAgent(agentId)) throw new TeamRuntimeError("not_found", `Agent not found: ${agentId}`, { agentId });
  }

  private requireMember(teamId: TeamId, agentId: AgentId): void {
    if (!this.store.getMember(teamId, agentId)) {
      throw new TeamRuntimeError("permission_denied", `Agent ${agentId} is not a member of team ${teamId}`, { teamId, agentId });
    }
  }

  /** Insert an explicit memory record; scope and provenance are validated before persistence. */
  write(input: WriteMemoryInput): MemoryRecord {
    const scope = input.scope;
    let teamId = input.teamId;
    let threadId = input.threadId;
    if (scope === "team") {
      if (!teamId || threadId || input.ownerAgentId) throw new TeamRuntimeError("conflict", "Team memory requires only teamId", { scope });
      this.requireTeam(teamId);
    } else if (scope === "thread") {
      if (!threadId || input.ownerAgentId) throw new TeamRuntimeError("conflict", "Thread memory requires threadId and no ownerAgentId", { scope });
      const thread = this.requireThread(threadId);
      if (teamId && teamId !== thread.teamId) throw new TeamRuntimeError("conflict", "Thread memory teamId does not match thread", { teamId, threadId });
      teamId = thread.teamId;
    } else {
      if (!input.ownerAgentId) throw new TeamRuntimeError("conflict", "Agent-private memory requires ownerAgentId", { scope });
      this.requireAgent(input.ownerAgentId);
      if (threadId) {
        const thread = this.requireThread(threadId);
        if (teamId && teamId !== thread.teamId) throw new TeamRuntimeError("conflict", "Private memory teamId does not match thread", { teamId, threadId });
        teamId = thread.teamId;
        this.requireMember(teamId, input.ownerAgentId);
      } else if (teamId) {
        this.requireTeam(teamId);
        this.requireMember(teamId, input.ownerAgentId);
      }
    }

    if (input.writerType === "agent") {
      this.requireAgent(input.writerId);
      if (teamId) this.requireMember(teamId, input.writerId);
      if (scope === "agent_private" && input.writerId !== input.ownerAgentId) {
        throw new TeamRuntimeError("permission_denied", "An Agent may only write its own agent-private memory", {
          writerId: input.writerId,
          ownerAgentId: input.ownerAgentId,
        });
      }
    }

    const source = input.sourceMessageId ? this.store.getMessage(input.sourceMessageId) : undefined;
    if (input.sourceMessageId && !source) {
      throw new TeamRuntimeError("not_found", `Source message not found: ${input.sourceMessageId}`, { sourceMessageId: input.sourceMessageId });
    }
    if (source) {
      const sourceThread = this.requireThread(source.threadId);
      if (teamId && sourceThread.teamId !== teamId) {
        throw new TeamRuntimeError("conflict", "Source message belongs to a different team", { sourceMessageId: source.id, teamId });
      }
      if (threadId && source.threadId !== threadId) {
        throw new TeamRuntimeError("conflict", "Source message belongs to a different thread", { sourceMessageId: source.id, threadId });
      }
      if (!teamId) teamId = sourceThread.teamId;
      if (scope === "thread" && !threadId) threadId = source.threadId;
      if (input.writerType === "agent" && !this.store.listMessages(source.threadId, input.writerId).some(message => message.id === source.id)) {
        throw new TeamRuntimeError("permission_denied", "Memory writer cannot use a source message outside its transcript ACL", {
          sourceMessageId: source.id,
          writerId: input.writerId,
        });
      }
    }

    if (scope === "agent_private" && teamId) this.requireMember(teamId, input.ownerAgentId!);

    const existing = input.idempotencyKey
      ? this.db.prepare(`
          SELECT * FROM memory_records
          WHERE scope = ? AND team_id IS ? AND thread_id IS ?
            AND owner_agent_id IS ? AND idempotency_key = ?
        `).get(scope, teamId ?? null, threadId ?? null,
        input.ownerAgentId ?? null, input.idempotencyKey) as Row | undefined
      : undefined;
    if (existing) return memoryFromRow(existing);

    const visibleTo = [...new Set(input.visibleTo ?? [])];
    for (const agentId of visibleTo) {
      this.requireAgent(agentId);
      if (teamId) this.requireMember(teamId, agentId);
    }
    const visibility = input.visibility ?? (scope === "agent_private" ? "private" : "team");
    if (scope === "agent_private" && (visibility !== "private" || visibleTo.length > 0)) {
      throw new TeamRuntimeError("permission_denied", "Agent-private memory is owner-only and cannot be shared", {
        scope,
        visibility,
        visibleTo,
      });
    }
    if (visibility !== "team" && visibleTo.length === 0 && scope !== "agent_private") {
      throw new TeamRuntimeError("permission_denied", "Direct/private team/thread memory requires visibleTo", { scope, visibility });
    }
    if (source && source.visibility !== "team") {
      const sourceReaders = new Set(source.visibleTo);
      if (source.authorType === "agent") sourceReaders.add(source.authorId);
      let memoryReaders: AgentId[];
      if (scope === "agent_private") {
        memoryReaders = [input.ownerAgentId!];
      } else if (visibility === "team") {
        memoryReaders = this.store.listMembers(teamId!).map((member) => member.agentId);
      } else {
        memoryReaders = [...visibleTo];
        if (input.writerType === "agent") memoryReaders.push(input.writerId);
      }
      const unauthorized = [...new Set(memoryReaders)].filter((agentId) => !sourceReaders.has(agentId));
      if (unauthorized.length > 0) {
        throw new TeamRuntimeError(
          "permission_denied",
          "Memory visibility cannot be broader than its source message ACL",
          { sourceMessageId: source.id, unauthorized },
        );
      }
    }
    const createdAt = input.createdAt ?? nowIso();
    const id = input.id ?? randomUUID();
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_records
        (id,scope,team_id,thread_id,owner_agent_id,source_message_id,provenance_json,writer_type,writer_id,visibility,visible_to_json,content,metadata_json,status,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)
    `).run(id, scope, teamId ?? null, threadId ?? null, input.ownerAgentId ?? null, input.sourceMessageId ?? null,
      input.provenance ? json(input.provenance) : null, input.writerType, input.writerId, visibility, json(visibleTo), input.content,
      json(input.metadata ?? {}), input.idempotencyKey ?? null, createdAt, createdAt);
    const saved = this.getRaw(id);
    if (saved) return saved;
    const idempotentRow = input.idempotencyKey
      ? this.db.prepare(`
          SELECT * FROM memory_records
          WHERE scope = ? AND team_id IS ? AND thread_id IS ?
            AND owner_agent_id IS ? AND idempotency_key = ?
        `).get(scope, teamId ?? null, threadId ?? null,
        input.ownerAgentId ?? null, input.idempotencyKey) as Row | undefined
      : undefined;
    if (idempotentRow) return memoryFromRow(idempotentRow);
    throw new TeamRuntimeError("conflict", `Memory ID already exists: ${id}`, { id });
  }

  create(input: WriteMemoryInput): MemoryRecord { return this.write(input); }

  get(id: string, viewerAgentId?: AgentId): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_records WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const memory = memoryFromRow(row);
    return this.canRead(memory, viewerAgentId) ? memory : undefined;
  }

  /** Pull memories by scope/owner/thread. Reads intentionally work after Thread seal. */
  recall(query: MemoryRecallQuery = {}, viewerAgentId?: AgentId): MemoryRecord[] {
    if (query.teamId) this.requireTeam(query.teamId);
    if (query.threadId) {
      const thread = this.requireThread(query.threadId);
      if (query.teamId && query.teamId !== thread.teamId) throw new TeamRuntimeError("conflict", "Recall teamId does not match thread", { teamId: query.teamId, threadId: query.threadId });
    }
    if (query.ownerAgentId) this.requireAgent(query.ownerAgentId);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.scope) { clauses.push("scope = ?"); params.push(query.scope); }
    if (query.teamId) { clauses.push("team_id = ?"); params.push(query.teamId); }
    if (query.threadId) { clauses.push("thread_id = ?"); params.push(query.threadId); }
    if (query.ownerAgentId) { clauses.push("owner_agent_id = ?"); params.push(query.ownerAgentId); }
    if (!query.includeRevoked) clauses.push("status = 'active'");
    if (query.after) { clauses.push("created_at > ?"); params.push(query.after); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM memory_records ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, query.limit ?? 100) as Row[];
    return rows.map(memoryFromRow).filter(memory => this.canRead(memory, viewerAgentId));
  }

  list(query: MemoryRecallQuery = {}, viewerAgentId?: AgentId): MemoryRecord[] { return this.recall(query, viewerAgentId); }

  /** Host principals never inherit an Agent's ACL or private-memory identity. */
  recallForPrincipal(query: MemoryRecallQuery, principalId: string): MemoryRecord[] {
    const teamId = query.threadId
      ? this.requireThread(query.threadId).teamId
      : query.teamId;
    if (!teamId || this.store.getTeam(teamId)?.ownerId !== principalId) {
      throw new TeamRuntimeError("permission_denied", "Principal does not own the requested Team memory scope", {
        principalId,
        teamId,
      });
    }
    return this.recall(query).filter((memory) => (
      memory.scope !== "agent_private" &&
      (memory.visibility === "team" || (memory.writerType === "user" && memory.writerId === principalId))
    ));
  }

  /**
   * Revoke is an authorization boundary, not a convenience delete:
   * - team/thread memory: the Team owner or the original writer may revoke;
   * - agent_private memory: only the private owner Agent or original
   *   user/system writer may revoke. Team ownership never grants private
   *   access.
   */
  revoke(id: string, actorId?: string): MemoryRecord {
    const current = this.getRaw(id);
    if (!current) throw new TeamRuntimeError("not_found", `Memory not found: ${id}`, { id });
    if (!actorId) {
      throw new TeamRuntimeError("permission_denied", `An actor is required to revoke memory ${id}`, { id });
    }

    let allowed = actorId === current.writerId;
    if (current.scope === "agent_private") {
      // Agent-private scope deliberately does not inherit Team owner rights.
      // The owner Agent can manage its private record; a user/system writer
      // can revoke a record it explicitly created for that Agent.
      allowed ||= actorId === current.ownerAgentId;
    } else if (current.teamId) {
      const team = this.store.getTeam(current.teamId);
      allowed ||= team?.ownerId === actorId;
    }
    if (!allowed) {
      throw new TeamRuntimeError("permission_denied", `Actor ${actorId} cannot revoke memory ${id}`, {
        id,
        actorId,
        scope: current.scope,
        teamId: current.teamId,
        ownerAgentId: current.ownerAgentId,
      });
    }
    const updatedAt = nowIso();
    this.db.prepare("UPDATE memory_records SET status='revoked', updated_at=? WHERE id=?").run(updatedAt, id);
    return this.getRaw(id)!;
  }

  private getRaw(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_records WHERE id = ?").get(id) as Row | undefined;
    return row ? memoryFromRow(row) : undefined;
  }

  private canRead(memory: MemoryRecord, viewerAgentId?: AgentId): boolean {
    if (!viewerAgentId) return true;
    if (memory.scope === "agent_private") return viewerAgentId === memory.ownerAgentId;
    if (!memory.teamId) return false;
    this.requireMember(memory.teamId, viewerAgentId);
    if (memory.visibility !== "team") return memory.visibleTo.includes(viewerAgentId) || viewerAgentId === memory.writerId;
    return true;
  }
}

export default MemoryStore;
