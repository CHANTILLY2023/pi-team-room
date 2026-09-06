import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";
import type { ProcessCapture, StoredProcess } from "./process-history.ts";
import {
  type AgentId,
  type AppendMessageInput,
  type CanonicalMessage,
  type Delivery,
  type DeliveryStatus,
  type Invocation,
  type InvocationLease,
  type InvocationStatus,
  type InvocationOutcome,
  type MessageId,
  type AgentRoleProfile,
  type PersistentAgent,
  type SessionBinding,
  type Team,
  type TeamId,
  type TeamMember,
  type ThreadFolder,
  type ThreadFolderId,
  type TeamThread,
  type ThreadId,
  TeamRuntimeError,
} from "./types.ts";

// Vite versions predating Node's `node:sqlite` builtin try to resolve the
// `sqlite` suffix as an npm package. Loading through Node's own require keeps
// the implementation on DatabaseSync while allowing the same source to run in
// those test transforms.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** Persisted read position for one agent in one thread. */
export interface CursorState {
  threadId: ThreadId;
  agentId: AgentId;
  lastVisibleSeq: number;
  lastAckedDelivery?: string;
}

export interface HostContext {
  hostSessionId: string;
  principalId: string;
  teamId: TeamId;
  threadId: ThreadId;
  updatedAt: string;
}

export interface DeliveryFilter {
  threadId?: ThreadId;
  agentId?: AgentId;
  status?: DeliveryStatus | DeliveryStatus[];
  dueAt?: string;
}

export interface InvocationFilter {
  threadId?: ThreadId;
  targetAgentId?: AgentId;
  status?: InvocationStatus | InvocationStatus[];
}

export interface ClaimDeliveryResult {
  delivery: Delivery;
  leaseToken: string;
}

export interface CommitInvocationFinalInput {
  lease: InvocationLease;
  deliveryToken?: string;
  final: AppendMessageInput;
  injectedThroughSeq: number;
  process?: ProcessCapture;
  session?: Pick<SessionBinding, "piSessionId" | "sessionFile" | "provider" | "model" | "thinking" | "runtimeConfigKey" | "modelRef" | "contextInitialized" | "contextThroughSeq">;
}

export type CommitInvocationOutcomeInput = Omit<CommitInvocationFinalInput, "final"> & {
  final?: AppendMessageInput;
  outcome: InvocationOutcome;
};

type Row = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value ?? []);
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

function optionalRoleProfile(value: unknown): AgentRoleProfile | undefined {
  const parsed = parseJson<AgentRoleProfile>(value, {});
  const result: AgentRoleProfile = {};
  for (const key of ["roleDescription", "personality", "teamStrengths", "caution"] as const) {
    const item = parsed[key];
    if (typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultLeaseUntil(): string {
  return new Date(Date.now() + 30_000).toISOString();
}

function bool(value: unknown): boolean {
  return Number(value) !== 0;
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function messageFromRow(row: Row): CanonicalMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    seq: asNumber(row.seq),
    authorType: String(row.author_type) as CanonicalMessage["authorType"],
    authorId: String(row.author_id),
    content: String(row.content),
    visibility: String(row.visibility) as CanonicalMessage["visibility"],
    visibleTo: parseJson<AgentId[]>(row.visible_to_json, []),
    wakeTargets: parseJson<AgentId[]>(row.wake_targets_json, []),
    replyTo: optionalString(row.reply_to),
    parentInvocationId: optionalString(row.parent_invocation_id),
    idempotencyKey: optionalString(row.idempotency_key),
    createdAt: String(row.created_at),
    ...(row.protocol_json ? { protocol: parseJson(row.protocol_json, undefined) } : {}),
  };
}

function deliveryFromRow(row: Row): Delivery {
  return {
    messageId: String(row.message_id),
    agentId: String(row.agent_id),
    status: String(row.status) as DeliveryStatus,
    attempts: asNumber(row.attempts),
    nextAttemptAt: optionalString(row.next_attempt_at),
    ackedAt: optionalString(row.acked_at),
    lastError: optionalString(row.last_error),
  };
}

function invocationFromRow(row: Row): Invocation {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    sourceMessageId: String(row.source_message_id),
    targetAgentId: String(row.target_agent_id),
    parentInvocationId: optionalString(row.parent_invocation_id),
    rootInvocationId: String(row.root_invocation_id),
    depth: asNumber(row.depth),
    status: String(row.status) as InvocationStatus,
    generation: asNumber(row.generation),
    attempts: asNumber(row.attempts),
    idempotencyKey: String(row.idempotency_key),
    leaseToken: optionalString(row.lease_token),
    leaseUntil: optionalString(row.lease_until),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastError: optionalString(row.last_error),
    ...(row.outcome_json ? { outcome: parseJson<InvocationOutcome | undefined>(row.outcome_json, undefined) } : {}),
  };
}

function agentFromRow(row: Row): PersistentAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    clientId: optionalString(row.client_id),
    provider: String(row.provider),
    model: String(row.model),
    thinking: optionalString(row.thinking),
    skillPaths: parseJson<string[]>(row.skills_json, []),
    aliases: parseJson<string[]>(row.aliases_json, []),
    roleProfile: optionalRoleProfile(row.role_profile_json),
    rolePrompt: optionalString(row.role_prompt),
    runtimePolicy: String(row.runtime_policy) as PersistentAgent["runtimePolicy"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function teamFromRow(row: Row): Team {
  return {
    id: String(row.id),
    name: String(row.name),
    ownerId: String(row.owner_id),
    defaultAgentId: optionalString(row.default_agent_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: optionalString(row.archived_at),
  };
}

function memberFromRow(row: Row): TeamMember {
  return {
    teamId: String(row.team_id),
    agentId: String(row.agent_id),
    name: String(row.name),
    role: optionalString(row.role),
    provider: String(row.provider),
    model: String(row.model),
    aliases: parseJson<string[]>(row.aliases_json, []),
    enabled: bool(row.enabled),
    joinedAt: String(row.joined_at),
  };
}

function threadFromRow(row: Row): TeamThread {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    folderId: optionalString(row.folder_id),
    title: optionalString(row.title),
    status: String(row.status) as TeamThread["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function folderFromRow(row: Row): ThreadFolder {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    name: String(row.name),
    position: asNumber(row.position),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function sessionFromRow(row: Row): SessionBinding {
  return {
    threadId: String(row.thread_id),
    agentId: String(row.agent_id),
    piSessionId: String(row.pi_session_id),
    sessionFile: optionalString(row.session_file),
    cwd: String(row.cwd),
    provider: String(row.provider),
    model: String(row.model),
    thinking: optionalString(row.thinking),
    runtimeConfigKey: optionalString(row.runtime_config_key),
    modelRef: optionalString(row.model_ref),
    contextInitialized: row.context_initialized == null ? undefined : asNumber(row.context_initialized) === 1,
    contextThroughSeq: row.context_through_seq == null ? undefined : asNumber(row.context_through_seq),
    status: String(row.status) as SessionBinding["status"],
    generation: asNumber(row.generation),
    lastVisibleSeq: asNumber(row.last_visible_seq),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The durable coordinator store for a Persistent PI Agent Team.
 *
 * All methods are synchronous because DatabaseSync is synchronous. This is
 * intentional: a coordinator operation is a small SQLite transaction and
 * callers can hand its result straight to the scheduler without a race
 * between a read and a write.
 */
export class TeamStore {
  readonly db: InstanceType<typeof DatabaseSync>;
  private transactionDepth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    // WAL is a no-op for :memory:, while file-backed stores get crash-safe
    // concurrent readers without changing the caller's API.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.createSchema();
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        client_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT,
        skills_json TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        role_profile_json TEXT,
        role_prompt TEXT,
        runtime_policy TEXT NOT NULL CHECK (runtime_policy IN ('always_on','idle_timeout','on_demand')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        default_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (team_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS thread_folders (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        folder_id TEXT REFERENCES thread_folders(id) ON DELETE SET NULL,
        title TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','sealed','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        author_type TEXT NOT NULL CHECK (author_type IN ('user','agent','system')),
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('team','direct','private')),
        visible_to_json TEXT NOT NULL,
        wake_targets_json TEXT NOT NULL,
        reply_to TEXT REFERENCES messages(id),
        parent_invocation_id TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, seq),
        UNIQUE (thread_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS message_targets (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        reason TEXT NOT NULL DEFAULT 'wake',
        selector TEXT,
        PRIMARY KEY (message_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued','leased','acked','failed','dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        acked_at TEXT,
        last_error TEXT,
        lease_token TEXT,
        lease_until TEXT,
        PRIMARY KEY (message_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS cursors (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        last_visible_seq INTEGER NOT NULL DEFAULT 0,
        last_acked_delivery TEXT,
        PRIMARY KEY (thread_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS session_bindings (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        pi_session_id TEXT NOT NULL,
        session_file TEXT,
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','sealing','sealed')),
        generation INTEGER NOT NULL DEFAULT 0,
        last_visible_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS host_contexts (
        host_session_id TEXT PRIMARY KEY,
        principal_id TEXT,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invocations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        parent_invocation_id TEXT,
        root_invocation_id TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','dead_letter')),
        generation INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL,
        lease_token TEXT,
        lease_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        UNIQUE (thread_id, target_agent_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq);
      CREATE INDEX IF NOT EXISTS idx_deliveries_agent_status ON deliveries(agent_id, status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_invocations_queue ON invocations(status, thread_id, target_agent_id);

      CREATE TABLE IF NOT EXISTS invocation_process (
        invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        session_file TEXT,
        message_start INTEGER,
        data_json TEXT NOT NULL,
        PRIMARY KEY (invocation_id, generation)
      );
    `);
    const bindingColumns = this.db.prepare("PRAGMA table_info(session_bindings)").all() as Row[];
    for (const [table, column] of [["messages", "protocol_json"], ["invocations", "outcome_json"]]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    for (const [name, type] of [["runtime_config_key", "TEXT"], ["model_ref", "TEXT"], ["context_initialized", "INTEGER"], ["context_through_seq", "INTEGER"]]) {
      if (!bindingColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE session_bindings ADD COLUMN ${name} ${type}`);
    }
    const agentColumns = this.db.prepare("PRAGMA table_info(agents)").all() as Row[];
    if (!agentColumns.some((column) => column.name === "client_id")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN client_id TEXT");
    }
    if (!agentColumns.some((column) => column.name === "role_profile_json")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN role_profile_json TEXT");
    }
    if (!agentColumns.some((column) => column.name === "role_prompt")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN role_prompt TEXT");
    }
    const hostContextColumns = this.db.prepare("PRAGMA table_info(host_contexts)").all() as Row[];
    if (!hostContextColumns.some((column) => column.name === "principal_id")) {
      this.db.exec("ALTER TABLE host_contexts ADD COLUMN principal_id TEXT");
    }
    const threadColumns = this.db.prepare("PRAGMA table_info(threads)").all() as Row[];
    if (!threadColumns.some((column) => column.name === "folder_id")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN folder_id TEXT");
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_host_contexts_principal
        ON host_contexts(principal_id) WHERE principal_id IS NOT NULL;
    `);
  }

  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private requireTeam(teamId: TeamId): Team {
    const team = this.getTeam(teamId);
    if (!team) throw new TeamRuntimeError("not_found", `Team not found: ${teamId}`, { teamId });
    return team;
  }

  private requireThread(threadId: ThreadId): TeamThread {
    const thread = this.getThread(threadId);
    if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${threadId}`, { threadId });
    return thread;
  }

  private requireAgent(agentId: AgentId): PersistentAgent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new TeamRuntimeError("not_found", `Agent not found: ${agentId}`, { agentId });
    return agent;
  }

  private requireMember(teamId: TeamId, agentId: AgentId): TeamMember {
    const member = this.getMember(teamId, agentId);
    if (!member) {
      throw new TeamRuntimeError("permission_denied", `Agent ${agentId} is not a member of team ${teamId}`, { teamId, agentId });
    }
    return member;
  }

  private requireFolder(folderId: ThreadFolderId): ThreadFolder {
    const folder = this.getThreadFolder(folderId);
    if (!folder) throw new TeamRuntimeError("not_found", `Thread folder not found: ${folderId}`, { folderId });
    return folder;
  }

  private requireFolderInTeam(teamId: TeamId, folderId: ThreadFolderId | undefined): void {
    if (!folderId) return;
    const folder = this.requireFolder(folderId);
    if (folder.teamId !== teamId) {
      throw new TeamRuntimeError("permission_denied", `Thread folder ${folderId} does not belong to team ${teamId}`, { teamId, folderId });
    }
  }

  private threadAgent(threadId: ThreadId, agentId: AgentId): TeamMember {
    const thread = this.requireThread(threadId);
    return this.requireMember(thread.teamId, agentId);
  }

  private requireThreadIdle(threadId: ThreadId): void {
    const invocationRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM invocations
      WHERE thread_id = ? AND status IN ('queued', 'running')
    `).get(threadId) as Row;
    const deliveryRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      WHERE m.thread_id = ? AND d.status IN ('queued', 'leased', 'failed')
    `).get(threadId) as Row;
    const activeInvocations = asNumber(invocationRow.count);
    const activeDeliveries = asNumber(deliveryRow.count);
    if (activeInvocations > 0 || activeDeliveries > 0) {
      throw new TeamRuntimeError("busy", `Thread ${threadId} has active work`, {
        threadId,
        activeInvocations,
        activeDeliveries,
      });
    }
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as Row | undefined;
    return Boolean(row?.present);
  }

  // ---- Persistent agent, team, membership, and thread CRUD ----

  upsertAgent(agent: PersistentAgent): PersistentAgent {
    this.db.prepare(`
      INSERT INTO agents (id,name,client_id,provider,model,thinking,skills_json,aliases_json,role_profile_json,role_prompt,runtime_policy,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, client_id=excluded.client_id, provider=excluded.provider, model=excluded.model, thinking=excluded.thinking,
        skills_json=excluded.skills_json, aliases_json=excluded.aliases_json,
        role_profile_json=excluded.role_profile_json, role_prompt=excluded.role_prompt,
        runtime_policy=excluded.runtime_policy, updated_at=excluded.updated_at
    `).run(agent.id, agent.name, agent.clientId ?? null, agent.provider, agent.model, agent.thinking ?? null,
      json(agent.skillPaths ?? agent.skills ?? []), json(agent.aliases), agent.roleProfile ? JSON.stringify(agent.roleProfile) : null, agent.rolePrompt ?? null,
      agent.runtimePolicy, agent.createdAt, agent.updatedAt);
    return this.requireAgent(agent.id);
  }

  createAgent(agent: PersistentAgent): PersistentAgent { return this.upsertAgent(agent); }

  getAgent(agentId: AgentId): PersistentAgent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Row | undefined;
    return row ? agentFromRow(row) : undefined;
  }

  listAgents(): PersistentAgent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY id").all() as Row[]).map(agentFromRow);
  }

  deleteAgent(agentId: AgentId): boolean {
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes > 0;
  }

  upsertTeam(team: Team): Team {
    this.db.prepare(`
      INSERT INTO teams (id,name,owner_id,default_agent_id,created_at,updated_at,archived_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, owner_id=excluded.owner_id, default_agent_id=excluded.default_agent_id,
        updated_at=excluded.updated_at, archived_at=excluded.archived_at
    `).run(team.id, team.name, team.ownerId, team.defaultAgentId ?? null, team.createdAt, team.updatedAt, team.archivedAt ?? null);
    return this.requireTeam(team.id);
  }

  createTeam(team: Team): Team { return this.upsertTeam(team); }

  createTeamWithThread(team: Team, thread: TeamThread): { team: Team; thread: TeamThread } {
    return this.transaction(() => ({
      team: this.createTeam(team),
      thread: this.createThread(thread),
    }));
  }

  getTeam(teamId: TeamId): Team | undefined {
    const row = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as Row | undefined;
    return row ? teamFromRow(row) : undefined;
  }

  listTeams(includeArchived = true): Team[] {
    const sql = includeArchived ? "SELECT * FROM teams ORDER BY id" : "SELECT * FROM teams WHERE archived_at IS NULL ORDER BY id";
    return (this.db.prepare(sql).all() as Row[]).map(teamFromRow);
  }

  archiveTeam(teamId: TeamId, archivedAt = nowIso()): Team {
    this.requireTeam(teamId);
    this.db.prepare("UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?").run(archivedAt, archivedAt, teamId);
    return this.requireTeam(teamId);
  }

  upsertMember(member: TeamMember): TeamMember {
    this.requireTeam(member.teamId);
    this.requireAgent(member.agentId);
    this.db.prepare(`
      INSERT INTO team_members (team_id,agent_id,name,role,provider,model,aliases_json,enabled,joined_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(team_id,agent_id) DO UPDATE SET
        name=excluded.name, role=excluded.role, provider=excluded.provider, model=excluded.model,
        aliases_json=excluded.aliases_json, enabled=excluded.enabled
    `).run(member.teamId, member.agentId, member.name, member.role ?? null, member.provider, member.model,
      json(member.aliases), member.enabled ? 1 : 0, member.joinedAt);
    return this.getMember(member.teamId, member.agentId)!;
  }

  addMember(member: TeamMember): TeamMember { return this.upsertMember(member); }

  upsertAgentWithMember(agent: PersistentAgent, member: TeamMember, makeDefault: boolean): PersistentAgent {
    return this.transaction(() => {
      const saved = this.upsertAgent(agent);
      this.upsertMember(member);
      if (makeDefault) {
        const team = this.requireTeam(member.teamId);
        this.upsertTeam({ ...team, defaultAgentId: agent.id, updatedAt: agent.updatedAt });
      }
      return saved;
    });
  }

  getMember(teamId: TeamId, agentId: AgentId): TeamMember | undefined {
    const row = this.db.prepare("SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?").get(teamId, agentId) as Row | undefined;
    return row ? memberFromRow(row) : undefined;
  }

  listMembers(teamId: TeamId, enabledOnly = false): TeamMember[] {
    this.requireTeam(teamId);
    const sql = enabledOnly
      ? "SELECT * FROM team_members WHERE team_id = ? AND enabled = 1 ORDER BY agent_id"
      : "SELECT * FROM team_members WHERE team_id = ? ORDER BY agent_id";
    return (this.db.prepare(sql).all(teamId) as Row[]).map(memberFromRow);
  }

  removeMember(teamId: TeamId, agentId: AgentId): boolean {
    this.requireTeam(teamId);
    return this.db.prepare("DELETE FROM team_members WHERE team_id = ? AND agent_id = ?").run(teamId, agentId).changes > 0;
  }

  createThreadFolder(folder: ThreadFolder): ThreadFolder {
    this.requireTeam(folder.teamId);
    this.db.prepare(`
      INSERT INTO thread_folders (id,team_id,name,position,created_at,updated_at)
      VALUES (?,?,?,?,?,?)
    `).run(folder.id, folder.teamId, folder.name, folder.position, folder.createdAt, folder.updatedAt);
    return this.requireFolder(folder.id);
  }

  getThreadFolder(folderId: ThreadFolderId): ThreadFolder | undefined {
    const row = this.db.prepare("SELECT * FROM thread_folders WHERE id = ?").get(folderId) as Row | undefined;
    return row ? folderFromRow(row) : undefined;
  }

  listThreadFolders(teamId: TeamId): ThreadFolder[] {
    this.requireTeam(teamId);
    return (this.db.prepare("SELECT * FROM thread_folders WHERE team_id = ? ORDER BY position, created_at, id").all(teamId) as Row[]).map(folderFromRow);
  }

  renameThreadFolder(folderId: ThreadFolderId, name: string, updatedAt = nowIso()): ThreadFolder {
    this.requireFolder(folderId);
    this.db.prepare("UPDATE thread_folders SET name = ?, updated_at = ? WHERE id = ?").run(name, updatedAt, folderId);
    return this.requireFolder(folderId);
  }

  reorderThreadFolders(teamId: TeamId, folderIds: ThreadFolderId[], updatedAt = nowIso()): ThreadFolder[] {
    return this.transaction(() => {
      this.requireTeam(teamId);
      const folders = this.listThreadFolders(teamId);
      const expected = new Set(folders.map((folder) => folder.id));
      const requested = new Set(folderIds);
      if (folderIds.length !== folders.length || requested.size !== folderIds.length) {
        throw new TeamRuntimeError("conflict", "Folder reorder must include each folder exactly once", { teamId });
      }
      for (const folderId of folderIds) {
        if (!expected.has(folderId)) {
          throw new TeamRuntimeError("permission_denied", `Thread folder ${folderId} does not belong to team ${teamId}`, { teamId, folderId });
        }
      }
      const update = this.db.prepare("UPDATE thread_folders SET position = ?, updated_at = ? WHERE id = ?");
      folderIds.forEach((folderId, position) => update.run(position, updatedAt, folderId));
      return this.listThreadFolders(teamId);
    });
  }

  deleteThreadFolder(folderId: ThreadFolderId): ThreadFolder {
    return this.transaction(() => {
      const folder = this.requireFolder(folderId);
      this.db.prepare("UPDATE threads SET folder_id = NULL, updated_at = ? WHERE folder_id = ?").run(nowIso(), folderId);
      this.db.prepare("DELETE FROM thread_folders WHERE id = ?").run(folderId);
      return folder;
    });
  }

  moveThreadToFolder(threadId: ThreadId, folderId?: ThreadFolderId, updatedAt = nowIso()): TeamThread {
    return this.transaction(() => {
      const thread = this.requireThread(threadId);
      this.requireFolderInTeam(thread.teamId, folderId);
      this.db.prepare("UPDATE threads SET folder_id = ?, updated_at = ? WHERE id = ?").run(folderId ?? null, updatedAt, threadId);
      return this.requireThread(threadId);
    });
  }

  upsertThread(thread: TeamThread): TeamThread {
    this.requireTeam(thread.teamId);
    this.requireFolderInTeam(thread.teamId, thread.folderId);
    this.db.prepare(`
      INSERT INTO threads (id,team_id,folder_id,title,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id, title=excluded.title, status=excluded.status, updated_at=excluded.updated_at
    `).run(thread.id, thread.teamId, thread.folderId ?? null, thread.title ?? null, thread.status, thread.createdAt, thread.updatedAt);
    return this.requireThread(thread.id);
  }

  createThread(thread: TeamThread): TeamThread { return this.upsertThread(thread); }

  getThread(threadId: ThreadId): TeamThread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as Row | undefined;
    return row ? threadFromRow(row) : undefined;
  }

  renameThread(threadId: ThreadId, title: string, updatedAt = nowIso()): TeamThread {
    this.requireThread(threadId);
    this.db.prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?").run(title, updatedAt, threadId);
    return this.requireThread(threadId);
  }

  listThreads(teamId: TeamId, includeArchived = true): TeamThread[] {
    this.requireTeam(teamId);
    const sql = includeArchived
      ? "SELECT * FROM threads WHERE team_id = ? ORDER BY created_at, id"
      : "SELECT * FROM threads WHERE team_id = ? AND status <> 'archived' ORDER BY created_at, id";
    return (this.db.prepare(sql).all(teamId) as Row[]).map(threadFromRow);
  }

  setThreadStatus(threadId: ThreadId, status: TeamThread["status"], updatedAt = nowIso()): TeamThread {
    this.requireThread(threadId);
    this.db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, threadId);
    return this.requireThread(threadId);
  }

  sealThread(threadId: ThreadId, updatedAt = nowIso()): TeamThread {
    return this.transaction(() => {
      const thread = this.requireThread(threadId);
      if (thread.status === "sealed") return thread;
      if (thread.status === "archived") {
        throw new TeamRuntimeError("thread_sealed", `Thread ${threadId} is archived`, { threadId });
      }

      this.requireThreadIdle(threadId);
      this.db.prepare("UPDATE threads SET status = 'sealed', updated_at = ? WHERE id = ?").run(updatedAt, threadId);
      this.db.prepare("UPDATE session_bindings SET status = 'sealed', updated_at = ? WHERE thread_id = ?").run(updatedAt, threadId);
      return this.requireThread(threadId);
    });
  }

  archiveThread(threadId: ThreadId, updatedAt = nowIso()): TeamThread {
    return this.transaction(() => {
      const thread = this.requireThread(threadId);
      if (thread.status === "archived") return thread;
      this.requireThreadIdle(threadId);
      this.db.prepare("UPDATE threads SET status = 'archived', updated_at = ? WHERE id = ?").run(updatedAt, threadId);
      this.db.prepare("UPDATE session_bindings SET status = 'sealed', updated_at = ? WHERE thread_id = ?").run(updatedAt, threadId);
      return this.requireThread(threadId);
    });
  }

  restoreThread(threadId: ThreadId, updatedAt = nowIso()): TeamThread {
    return this.transaction(() => {
      const thread = this.requireThread(threadId);
      if (thread.status !== "archived") return thread;
      this.db.prepare("UPDATE threads SET status = 'active', updated_at = ? WHERE id = ?").run(updatedAt, threadId);
      this.db.prepare("DELETE FROM session_bindings WHERE thread_id = ?").run(threadId);
      return this.requireThread(threadId);
    });
  }

  archiveThreads(threadIds: ThreadId[], updatedAt = nowIso()): TeamThread[] {
    return this.transaction(() => {
      const threads = threadIds.map((threadId) => this.requireThread(threadId));
      for (const thread of threads) {
        if (thread.status !== "archived") this.requireThreadIdle(thread.id);
      }
      return threads.map((thread) => this.archiveThread(thread.id, updatedAt));
    });
  }

  moveThreadsToFolder(threadIds: ThreadId[], folderId?: ThreadFolderId, updatedAt = nowIso()): TeamThread[] {
    return this.transaction(() => {
      const threads = threadIds.map((threadId) => this.requireThread(threadId));
      for (const thread of threads) this.requireFolderInTeam(thread.teamId, folderId);
      return threads.map((thread) => this.moveThreadToFolder(thread.id, folderId, updatedAt));
    });
  }

  deleteThread(threadId: ThreadId): TeamThread {
    return this.transaction(() => {
      const thread = this.requireThread(threadId);
      this.requireThreadIdle(threadId);
      if (this.hasTable("agent_slots")) {
        this.db.prepare("DELETE FROM agent_slots WHERE thread_id = ?").run(threadId);
      }
      this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      return thread;
    });
  }

  deleteThreads(threadIds: ThreadId[]): TeamThread[] {
    return this.transaction(() => {
      const threads = threadIds.map((threadId) => this.requireThread(threadId));
      for (const thread of threads) this.requireThreadIdle(thread.id);
      return threads.map((thread) => this.deleteThread(thread.id));
    });
  }

  // ---- Canonical transcript, target snapshots, and durable deliveries ----

  appendMessage(input: AppendMessageInput): CanonicalMessage {
    return this.transaction(() => {
      const thread = this.requireThread(input.threadId);
      const existingByKey = input.idempotencyKey
        ? this.db.prepare("SELECT * FROM messages WHERE thread_id = ? AND idempotency_key = ?").get(input.threadId, input.idempotencyKey) as Row | undefined
        : undefined;
      if (existingByKey) return messageFromRow(existingByKey);
      if (input.id) {
        const existingById = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(input.id) as Row | undefined;
        if (existingById) return messageFromRow(existingById);
      }
      if (thread.status !== "active") {
        throw new TeamRuntimeError("thread_sealed", `Thread ${input.threadId} is ${thread.status}`, { threadId: input.threadId });
      }

      const visibility = input.visibility ?? "team";
      const visibleTo = [...new Set(input.visibleTo ?? [])];
      const wakeTargets = [...new Set(input.wakeTargets ?? [])];
      if (visibility !== "team" && visibleTo.length === 0) {
        throw new TeamRuntimeError("permission_denied", "Direct/private messages require visibleTo", { threadId: input.threadId });
      }
      if (visibility !== "team" && wakeTargets.some((agentId) => !visibleTo.includes(agentId))) {
        throw new TeamRuntimeError("permission_denied", "Direct/private wake targets must be included in visibleTo", {
          threadId: input.threadId,
          wakeTargets,
          visibleTo,
        });
      }
      for (const agentId of [...new Set([...visibleTo, ...wakeTargets])]) this.threadAgent(input.threadId, agentId);

      const question = input.replyTo ? this.getMessage(input.replyTo) : undefined;
      const waiting = input.authorType === "user" && question?.protocol?.disposition === "awaiting_user"
        ? question.parentInvocationId && this.getInvocation(question.parentInvocationId) : undefined;
      if (input.authorType === "user" && question?.protocol?.disposition === "awaiting_user") {
        if (!waiting || waiting.threadId !== thread.id || waiting.targetAgentId !== question.authorId ||
            waiting.status !== "completed" || waiting.outcome?.disposition !== "awaiting_user" || waiting.outcome.resolvedByMessageId ||
            this.getTeam(thread.teamId)?.ownerId !== input.authorId ||
            wakeTargets.length !== 1 || wakeTargets[0] !== waiting.targetAgentId ||
            visibility !== question.visibility || (visibility !== "team" && visibleTo.some(id => !question.visibleTo.includes(id)))) {
          throw new TeamRuntimeError("conflict", "Waiting question is already resolved or the reply is out of scope");
        }
      }

      const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE thread_id = ?").get(input.threadId) as Row;
      const seq = asNumber(seqRow.next_seq);
      const id = input.id ?? randomUUID();
      const createdAt = nowIso();
      this.db.prepare(`
        INSERT INTO messages
          (id,thread_id,seq,author_type,author_id,content,visibility,visible_to_json,wake_targets_json,reply_to,parent_invocation_id,idempotency_key,created_at,protocol_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, input.threadId, seq, input.authorType, input.authorId, input.content, visibility,
        json(visibleTo), json(wakeTargets), input.replyTo ?? null, input.parentInvocationId ?? null,
        input.idempotencyKey ?? null, createdAt, input.protocol ? json(input.protocol) : null);

      const targetStmt = this.db.prepare("INSERT INTO message_targets (message_id,agent_id,reason,selector) VALUES (?,?,?,?)");
      const deliveryStmt = this.db.prepare("INSERT INTO deliveries (message_id,agent_id,status,attempts) VALUES (?,?,?,0)");
      for (const agentId of wakeTargets) {
        const selectors = input.targetSelectors?.[agentId];
        targetStmt.run(id, agentId, "wake", selectors?.length ? json(selectors) : null);
        deliveryStmt.run(id, agentId, "queued");
      }
      this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(createdAt, input.threadId);
      if (waiting) {
        this.db.prepare("UPDATE invocations SET outcome_json=?, updated_at=? WHERE id=?")
          .run(json({ ...waiting.outcome, resolvedByMessageId: id }), createdAt, waiting.id);
      }
      return messageFromRow(this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row);
    });
  }

  getMessage(messageId: MessageId): CanonicalMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Row | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  /** List only messages the requesting agent is authorized to see. */
  listMessages(threadId: ThreadId, viewerAgentId?: AgentId, options: { afterSeq?: number; limit?: number } = {}): CanonicalMessage[] {
    const thread = this.requireThread(threadId);
    if (viewerAgentId) this.requireMember(thread.teamId, viewerAgentId);
    const clauses = ["thread_id = ?"];
    const params: SQLInputValue[] = [threadId];
    if (options.afterSeq !== undefined) { clauses.push("seq > ?"); params.push(options.afterSeq); }
    const rows = this.db.prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`).all(...params, options.limit ?? -1) as Row[];
    return rows.map(messageFromRow).filter(message => {
      if (!viewerAgentId) return true;
      if (message.visibility === "team") return true;
      return message.visibleTo.includes(viewerAgentId) || message.authorId === viewerAgentId;
    });
  }

  getMessages(threadId: ThreadId, viewerAgentId?: AgentId, options?: { afterSeq?: number; limit?: number }): CanonicalMessage[] {
    return this.listMessages(threadId, viewerAgentId, options);
  }

  listMessageTargets(messageId: MessageId): AgentId[] {
    return (this.db.prepare("SELECT agent_id FROM message_targets WHERE message_id = ? ORDER BY agent_id").all(messageId) as Row[]).map(row => String(row.agent_id));
  }

  listMessageTargetDetails(messageId: MessageId): Array<{ agentId: AgentId; reason: string; selectors: string[] }> {
    return (this.db.prepare(`
      SELECT agent_id, reason, selector FROM message_targets WHERE message_id = ? ORDER BY agent_id
    `).all(messageId) as Row[]).map((row) => ({
      agentId: String(row.agent_id),
      reason: String(row.reason),
      selectors: parseJson<string[]>(row.selector, []),
    }));
  }

  /** Host principals see Team-visible events and messages they authored. */
  listMessagesForPrincipal(
    threadId: ThreadId,
    principalId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): CanonicalMessage[] {
    const thread = this.requireThread(threadId);
    const team = this.requireTeam(thread.teamId);
    if (team.ownerId !== principalId) {
      throw new TeamRuntimeError("permission_denied", `Principal does not own Team ${team.id}`, {
        principalId,
        teamId: team.id,
      });
    }
    return this.listMessages(threadId, undefined, options).filter((message) => (
      message.visibility === "team" || (message.authorType === "user" && message.authorId === principalId)
    ));
  }

  getDelivery(messageId: MessageId, agentId: AgentId): Delivery | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE message_id = ? AND agent_id = ?").get(messageId, agentId) as Row | undefined;
    return row ? deliveryFromRow(row) : undefined;
  }

  listDeliveries(filter: DeliveryFilter = {}): Delivery[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.threadId) { clauses.push("m.thread_id = ?"); params.push(filter.threadId); }
    if (filter.agentId) { clauses.push("d.agent_id = ?"); params.push(filter.agentId); }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      clauses.push(`d.status IN (${statuses.map(() => "?").join(",")})`); params.push(...statuses);
    }
    if (filter.dueAt) { clauses.push("(d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)"); params.push(filter.dueAt); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT d.* FROM deliveries d JOIN messages m ON m.id = d.message_id ${where} ORDER BY m.thread_id, m.seq, d.agent_id`).all(...params) as Row[]).map(deliveryFromRow);
  }

  listPendingDeliveries(threadId: ThreadId, agentId: AgentId, at = nowIso()): Delivery[] {
    return this.listDeliveries({ threadId, agentId, status: ["queued", "failed"], dueAt: at });
  }

  claimDelivery(messageId: MessageId, agentId: AgentId, leaseToken: string = randomUUID(), leaseUntil = defaultLeaseUntil()): ClaimDeliveryResult {
    return this.transaction(() => {
      const delivery = this.getDelivery(messageId, agentId);
      if (!delivery) throw new TeamRuntimeError("not_found", "Delivery not found", { messageId, agentId });
      if (!["queued", "failed"].includes(delivery.status)) {
        throw new TeamRuntimeError("busy", `Delivery is ${delivery.status}`, { messageId, agentId });
      }
      this.db.prepare(`UPDATE deliveries SET status='leased', attempts=attempts+1, lease_token=?, lease_until=? WHERE message_id=? AND agent_id=?`).run(leaseToken, leaseUntil, messageId, agentId);
      return { delivery: this.getDelivery(messageId, agentId)!, leaseToken };
    });
  }

  /**
   * Extends a Delivery only while the Invocation that owns the same token is
   * still live. The Invocation heartbeat happens first, so a concurrent
   * reclaimer can use that durable lease as the hand-off fence between these
   * two short transactions.
   */
  heartbeatDelivery(
    messageId: MessageId,
    agentId: AgentId,
    leaseToken: string,
    leaseUntil: string,
    at = nowIso(),
  ): Delivery {
    const changed = this.db.prepare(`
      UPDATE deliveries
      SET lease_until = ?
      WHERE message_id = ? AND agent_id = ? AND status = 'leased' AND lease_token = ?
        AND EXISTS (
          SELECT 1
          FROM invocations i
          WHERE i.source_message_id = deliveries.message_id
            AND i.target_agent_id = deliveries.agent_id
            AND i.status = 'running'
            AND i.lease_token = deliveries.lease_token
            AND i.lease_until = ?
            AND i.lease_until > ?
        )
    `).run(leaseUntil, messageId, agentId, leaseToken, leaseUntil, at).changes;
    if (Number(changed) !== 1) {
      throw new TeamRuntimeError("stale_lease", "Delivery no longer shares a live Invocation lease", {
        messageId,
        agentId,
      });
    }
    return this.getDelivery(messageId, agentId)!;
  }

  ackDelivery(messageId: MessageId, agentId: AgentId, leaseToken?: string, ackedAt = nowIso()): Delivery {
    return this.transaction(() => {
      const current = this.getDelivery(messageId, agentId);
      if (!current) throw new TeamRuntimeError("not_found", "Delivery not found", { messageId, agentId });
      if (current.status === "acked") return current;
      if (current.status !== "leased") throw new TeamRuntimeError("stale_lease", `Delivery is ${current.status}`, { messageId, agentId });
      if (leaseToken) {
        const row = this.db.prepare("SELECT lease_token FROM deliveries WHERE message_id=? AND agent_id=?").get(messageId, agentId) as Row;
        if (row.lease_token !== leaseToken) throw new TeamRuntimeError("stale_lease", "Delivery lease token is stale", { messageId, agentId });
      }
      this.db.prepare("UPDATE deliveries SET status='acked', acked_at=?, lease_token=NULL, lease_until=NULL WHERE message_id=? AND agent_id=?").run(ackedAt, messageId, agentId);
      return this.getDelivery(messageId, agentId)!;
    });
  }

  failDelivery(
    messageId: MessageId,
    agentId: AgentId,
    error: string,
    nextAttemptAt?: string,
    deadLetter = false,
    expectedLeaseToken?: string,
  ): Delivery {
    const status: DeliveryStatus = deadLetter ? "dead_letter" : "failed";
    const current = this.getDelivery(messageId, agentId);
    if (!current) throw new TeamRuntimeError("not_found", "Delivery not found", { messageId, agentId });
    const leaseToken = expectedLeaseToken === undefined
      ? undefined
      : (this.db.prepare("SELECT lease_token FROM deliveries WHERE message_id=? AND agent_id=?").get(messageId, agentId) as Row | undefined)?.lease_token;
    if (expectedLeaseToken !== undefined && leaseToken !== expectedLeaseToken) throw new TeamRuntimeError("stale_lease", "Delivery lease token is stale", { messageId, agentId });
    const whereToken = expectedLeaseToken === undefined ? "" : " AND lease_token = ?";
    const params: Array<string | null> = [status, error, nextAttemptAt ?? null, messageId, agentId];
    if (expectedLeaseToken !== undefined) params.push(expectedLeaseToken);
    const result = this.db.prepare(`UPDATE deliveries SET status=?, last_error=?, next_attempt_at=?, lease_token=NULL, lease_until=NULL WHERE message_id=? AND agent_id=?${whereToken}`).run(...params);
    if (expectedLeaseToken !== undefined && Number(result.changes ?? 0) !== 1) {
      throw new TeamRuntimeError("stale_lease", "Delivery lease token is stale", { messageId, agentId });
    }
    const delivery = this.getDelivery(messageId, agentId);
    return delivery;
  }

  /** Return crashed/expired leases to the durable queue for another worker. */
  reclaimExpiredDeliveries(at = nowIso()): Delivery[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT d.message_id, d.agent_id
        FROM deliveries d
        WHERE d.status = 'leased' AND d.lease_until IS NOT NULL AND d.lease_until <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM invocations i
            WHERE i.source_message_id = d.message_id
              AND i.target_agent_id = d.agent_id
              AND i.status = 'running'
              AND i.lease_token = d.lease_token
              AND i.lease_until IS NOT NULL
              AND i.lease_until > ?
          )
        ORDER BY d.message_id, d.agent_id
      `).all(at, at) as Row[];
      if (rows.length > 0) {
        this.db.prepare(`
          UPDATE deliveries AS d
          SET status = 'queued', lease_token = NULL, lease_until = NULL
          WHERE d.status = 'leased' AND d.lease_until IS NOT NULL AND d.lease_until <= ?
            AND NOT EXISTS (
              SELECT 1
              FROM invocations i
              WHERE i.source_message_id = d.message_id
                AND i.target_agent_id = d.agent_id
                AND i.status = 'running'
                AND i.lease_token = d.lease_token
                AND i.lease_until IS NOT NULL
                AND i.lease_until > ?
            )
        `).run(at, at);
      }
      return rows.map(row => this.getDelivery(String(row.message_id), String(row.agent_id))!).filter(Boolean);
    });
  }

  // ---- Cursor and PI session binding persistence ----

  getCursor(threadId: ThreadId, agentId: AgentId): CursorState | undefined {
    const row = this.db.prepare("SELECT * FROM cursors WHERE thread_id=? AND agent_id=?").get(threadId, agentId) as Row | undefined;
    return row ? { threadId, agentId, lastVisibleSeq: asNumber(row.last_visible_seq), lastAckedDelivery: optionalString(row.last_acked_delivery) } : undefined;
  }

  listCursors(threadId: ThreadId): CursorState[] {
    return (this.db.prepare(`
      SELECT * FROM cursors WHERE thread_id=? ORDER BY agent_id
    `).all(threadId) as Row[]).map((row) => ({
      threadId: String(row.thread_id),
      agentId: String(row.agent_id),
      lastVisibleSeq: asNumber(row.last_visible_seq),
      lastAckedDelivery: optionalString(row.last_acked_delivery),
    }));
  }

  upsertCursor(cursor: CursorState): CursorState {
    this.threadAgent(cursor.threadId, cursor.agentId);
    this.db.prepare(`
      INSERT INTO cursors (thread_id,agent_id,last_visible_seq,last_acked_delivery) VALUES (?,?,?,?)
      ON CONFLICT(thread_id,agent_id) DO UPDATE SET
        last_visible_seq=MAX(cursors.last_visible_seq, excluded.last_visible_seq),
        last_acked_delivery=COALESCE(excluded.last_acked_delivery, cursors.last_acked_delivery)
    `).run(cursor.threadId, cursor.agentId, cursor.lastVisibleSeq, cursor.lastAckedDelivery ?? null);
    return this.getCursor(cursor.threadId, cursor.agentId)!;
  }

  advanceCursor(threadId: ThreadId, agentId: AgentId, lastVisibleSeq: number, lastAckedDelivery?: string): CursorState {
    return this.upsertCursor({ threadId, agentId, lastVisibleSeq, lastAckedDelivery });
  }

  deleteCursor(threadId: ThreadId, agentId: AgentId): boolean {
    return this.db.prepare("DELETE FROM cursors WHERE thread_id=? AND agent_id=?").run(threadId, agentId).changes > 0;
  }

  getSessionBinding(threadId: ThreadId, agentId: AgentId): SessionBinding | undefined {
    const row = this.db.prepare("SELECT * FROM session_bindings WHERE thread_id=? AND agent_id=?").get(threadId, agentId) as Row | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  upsertSessionBinding(binding: SessionBinding): SessionBinding {
    const thread = this.requireThread(binding.threadId);
    this.threadAgent(binding.threadId, binding.agentId);
    const existing = this.getSessionBinding(binding.threadId, binding.agentId);
    if (thread.status !== "active" && (!existing || binding.status !== "sealed")) {
      throw new TeamRuntimeError("thread_sealed", `Thread ${binding.threadId} is ${thread.status}`, { threadId: binding.threadId });
    }
    this.db.prepare(`
      INSERT INTO session_bindings
        (thread_id,agent_id,pi_session_id,session_file,cwd,provider,model,thinking,status,generation,last_visible_seq,created_at,updated_at,runtime_config_key,model_ref,context_initialized,context_through_seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(thread_id,agent_id) DO UPDATE SET
        pi_session_id=excluded.pi_session_id, session_file=excluded.session_file, cwd=excluded.cwd,
        provider=excluded.provider, model=excluded.model, thinking=excluded.thinking, status=excluded.status,
        generation=excluded.generation, last_visible_seq=excluded.last_visible_seq, updated_at=excluded.updated_at,
        runtime_config_key=excluded.runtime_config_key, model_ref=excluded.model_ref,
        context_initialized=excluded.context_initialized, context_through_seq=excluded.context_through_seq
    `).run(binding.threadId, binding.agentId, binding.piSessionId, binding.sessionFile ?? null, binding.cwd,
      binding.provider, binding.model, binding.thinking ?? null, binding.status, binding.generation,
      binding.lastVisibleSeq, binding.createdAt, binding.updatedAt, binding.runtimeConfigKey ?? null, binding.modelRef ?? null,
      binding.contextInitialized === undefined ? null : binding.contextInitialized ? 1 : 0, binding.contextThroughSeq ?? null);
    return this.getSessionBinding(binding.threadId, binding.agentId)!;
  }

  createSessionBinding(binding: SessionBinding): SessionBinding { return this.upsertSessionBinding(binding); }

  updateSessionBinding(threadId: ThreadId, agentId: AgentId, patch: Partial<Omit<SessionBinding, "threadId" | "agentId" | "createdAt">> & { updatedAt?: string }): SessionBinding {
    const current = this.getSessionBinding(threadId, agentId);
    if (!current) throw new TeamRuntimeError("not_found", "Session binding not found", { threadId, agentId });
    return this.upsertSessionBinding({ ...current, ...patch, updatedAt: patch.updatedAt ?? nowIso() });
  }

  deleteSessionBinding(threadId: ThreadId, agentId: AgentId): boolean {
    return this.db.prepare("DELETE FROM session_bindings WHERE thread_id=? AND agent_id=?").run(threadId, agentId).changes > 0;
  }

  getHostContext(hostSessionId: string): HostContext | undefined {
    const row = this.db.prepare("SELECT host_session_id, principal_id, team_id, thread_id, updated_at FROM host_contexts WHERE host_session_id=?").get(hostSessionId) as Row | undefined;
    if (!row) return undefined;
    return {
      hostSessionId: String(row.host_session_id),
      principalId: optionalString(row.principal_id) ?? String(row.host_session_id),
      teamId: String(row.team_id),
      threadId: String(row.thread_id),
      updatedAt: String(row.updated_at),
    };
  }

  getHostContextForPrincipal(principalId: string): HostContext | undefined {
    const row = this.db.prepare(`
      SELECT host_session_id FROM host_contexts WHERE principal_id=? ORDER BY updated_at DESC LIMIT 1
    `).get(principalId) as Row | undefined;
    return row ? this.getHostContext(String(row.host_session_id)) : undefined;
  }

  /** Backward-compatible session-scoped binding for embedded callers. */
  setHostContext(hostSessionId: string, teamId: TeamId, threadId: ThreadId, updatedAt = nowIso()): HostContext {
    return this.setHostContextForPrincipal(hostSessionId, hostSessionId, teamId, threadId, updatedAt);
  }

  setHostContextForPrincipal(
    hostSessionId: string,
    principalId: string,
    teamId: TeamId,
    threadId: ThreadId,
    updatedAt = nowIso(),
  ): HostContext {
    return this.transaction(() => {
      const team = this.requireTeam(teamId);
      const thread = this.requireThread(threadId);
      if (thread.teamId !== team.id) {
        throw new TeamRuntimeError("conflict", `Thread ${threadId} does not belong to team ${teamId}`, { teamId, threadId });
      }
      // A stable principal has exactly one active Team context. Rotating the
      // physical host Session transfers that binding instead of losing it.
      this.db.prepare("DELETE FROM host_contexts WHERE principal_id=? AND host_session_id<>?").run(principalId, hostSessionId);
      this.db.prepare(`
        INSERT INTO host_contexts (host_session_id,principal_id,team_id,thread_id,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(host_session_id) DO UPDATE SET
          principal_id=excluded.principal_id, team_id=excluded.team_id,
          thread_id=excluded.thread_id, updated_at=excluded.updated_at
      `).run(hostSessionId, principalId, teamId, threadId, updatedAt);
      return this.getHostContext(hostSessionId)!;
    });
  }

  clearHostContext(hostSessionId: string): boolean {
    return this.db.prepare("DELETE FROM host_contexts WHERE host_session_id=?").run(hostSessionId).changes > 0;
  }

  clearHostContextForPrincipal(principalId: string): boolean {
    return this.db.prepare("DELETE FROM host_contexts WHERE principal_id=?").run(principalId).changes > 0;
  }

  // ---- Optional invocation persistence used by the scheduler ----

  createInvocation(invocation: Invocation): Invocation {
    const thread = this.requireThread(invocation.threadId);
    const existing = this.db.prepare(`
      SELECT * FROM invocations
      WHERE thread_id=? AND target_agent_id=? AND idempotency_key=?
    `).get(invocation.threadId, invocation.targetAgentId, invocation.idempotencyKey) as Row | undefined;
    if (existing) return invocationFromRow(existing);
    // A sealed Thread is closed to new work, but crash recovery may still
    // record a terminal result produced before sealing. Queued/running routes
    // remain fenced; archived Threads stay immutable.
    const terminalStatus = ["completed", "failed", "cancelled", "dead_letter"].includes(invocation.status);
    if (thread.status !== "active" && !(thread.status === "sealed" && terminalStatus)) {
      throw new TeamRuntimeError("thread_sealed", `Thread ${invocation.threadId} is ${thread.status}`, { threadId: invocation.threadId });
    }
    this.requireMember(thread.teamId, invocation.targetAgentId);
    const sourceMessage = this.getMessage(invocation.sourceMessageId);
    if (!sourceMessage) {
      throw new TeamRuntimeError("not_found", `Source message not found: ${invocation.sourceMessageId}`, {
        sourceMessageId: invocation.sourceMessageId,
      });
    }
    if (sourceMessage.threadId !== invocation.threadId) {
      throw new TeamRuntimeError("conflict", "Invocation source message belongs to a different thread", {
        sourceMessageId: invocation.sourceMessageId,
        sourceThreadId: sourceMessage.threadId,
        threadId: invocation.threadId,
      });
    }
    this.db.prepare(`
      INSERT INTO invocations
        (id,thread_id,source_message_id,target_agent_id,parent_invocation_id,root_invocation_id,depth,status,generation,attempts,idempotency_key,lease_token,lease_until,created_at,updated_at,last_error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(thread_id,target_agent_id,idempotency_key) DO NOTHING
    `).run(invocation.id, invocation.threadId, invocation.sourceMessageId, invocation.targetAgentId,
      invocation.parentInvocationId ?? null, invocation.rootInvocationId, invocation.depth, invocation.status,
      invocation.generation, invocation.attempts, invocation.idempotencyKey, invocation.leaseToken ?? null,
      invocation.leaseUntil ?? null, invocation.createdAt, invocation.updatedAt, invocation.lastError ?? null);
    const row = this.db.prepare("SELECT * FROM invocations WHERE thread_id=? AND target_agent_id=? AND idempotency_key=?").get(invocation.threadId, invocation.targetAgentId, invocation.idempotencyKey) as Row;
    return invocationFromRow(row);
  }

  getInvocation(id: string): Invocation | undefined {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id=?").get(id) as Row | undefined;
    return row ? invocationFromRow(row) : undefined;
  }

  listInvocations(filter: InvocationFilter = {}): Invocation[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.threadId) { clauses.push("thread_id=?"); params.push(filter.threadId); }
    if (filter.targetAgentId) { clauses.push("target_agent_id=?"); params.push(filter.targetAgentId); }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); params.push(...statuses);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM invocations${where} ORDER BY created_at, id`).all(...params) as Row[]).map(invocationFromRow);
  }

  updateInvocation(id: string, patch: Partial<Invocation>): Invocation {
    const current = this.getInvocation(id);
    if (!current) throw new TeamRuntimeError("not_found", `Invocation not found: ${id}`, { id });
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? nowIso() };
    this.db.prepare(`UPDATE invocations SET status=?,generation=?,attempts=?,lease_token=?,lease_until=?,updated_at=?,last_error=? WHERE id=?`).run(
      next.status, next.generation, next.attempts, next.leaseToken ?? null, next.leaseUntil ?? null, next.updatedAt, next.lastError ?? null, id);
    return this.getInvocation(id)!;
  }

  getInvocationProcess(invocationId: string): StoredProcess | undefined {
    const row = this.db.prepare(`SELECT p.* FROM invocation_process p JOIN invocations i
      ON i.id=p.invocation_id AND i.generation=p.generation WHERE i.id=?`).get(invocationId) as Row | undefined;
    if (!row) return undefined;
    return { invocationId, generation: asNumber(row.generation), sessionFile: optionalString(row.session_file),
      messageStart: row.message_start == null ? undefined : asNumber(row.message_start), data: JSON.parse(String(row.data_json)) };
  }

  hasInvocationProcess(invocationId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM invocation_process p JOIN invocations i
      ON i.id=p.invocation_id AND i.generation=p.generation WHERE i.id=?`).get(invocationId);
  }

  private writeProcess(invocation: Invocation, capture: ProcessCapture): void {
    this.db.prepare(`INSERT INTO invocation_process (invocation_id,generation,session_file,message_start,data_json)
      VALUES (?,?,?,?,?) ON CONFLICT(invocation_id,generation) DO UPDATE SET
      session_file=COALESCE(excluded.session_file,invocation_process.session_file),
      message_start=COALESCE(excluded.message_start,invocation_process.message_start),data_json=excluded.data_json
      WHERE invocation_process.data_json<>excluded.data_json`).run(invocation.id, invocation.generation,
      capture.sessionFile ?? null, capture.messageStart ?? null, JSON.stringify(capture.data));
  }

  saveInvocationProcess(lease: InvocationLease, capture: ProcessCapture): void {
    this.transaction(() => {
      const invocation = this.getInvocation(lease.invocation.id);
      if (!invocation || invocation.status !== "running" || invocation.generation !== lease.generation ||
          invocation.leaseToken !== lease.leaseToken || !invocation.leaseUntil || invocation.leaseUntil <= nowIso()) {
        throw new TeamRuntimeError("stale_lease", "Process update belongs to a stale invocation lease");
      }
      this.writeProcess(invocation, capture);
    });
  }

  saveRecoveredProcess(messageId: string, capture: ProcessCapture): void {
    this.transaction(() => {
      const message = this.getMessage(messageId);
      const invocation = message?.parentInvocationId ? this.getInvocation(message.parentInvocationId) : undefined;
      if (!message || message.authorType !== "agent" || !invocation || invocation.status !== "completed" ||
          invocation.threadId !== message.threadId || invocation.targetAgentId !== message.authorId) {
        throw new TeamRuntimeError("conflict", "Process recovery requires a committed invocation final");
      }
      if (this.getInvocationProcess(invocation.id)?.data.status === "complete") return;
      this.writeProcess(invocation, capture);
    });
  }

  /**
   * Atomically fences and commits one provider callback. The canonical final,
   * exact PI Session identity, cursor, Delivery ACK, Invocation completion,
   * and slot release either all become durable or all roll back.
   */
  commitInvocationFinal(input: CommitInvocationFinalInput): { invocation: Invocation; final: CanonicalMessage } {
    const committed = this.commitInvocationOutcome({ ...input, outcome: {
      version: 1, disposition: "completed", basedOnSeq: input.injectedThroughSeq, routing: "text", targets: input.final.wakeTargets ?? [],
    } });
    return { invocation: committed.invocation, final: committed.final! };
  }

  commitInvocationOutcome(input: CommitInvocationOutcomeInput): { invocation: Invocation; final?: CanonicalMessage } {
    return this.transaction(() => {
      const { lease } = input;
      const invocation = this.getInvocation(lease.invocation.id);
      const now = nowIso();
      if (
        !invocation || invocation.status !== "running" ||
        invocation.generation !== lease.generation || invocation.leaseToken !== lease.leaseToken ||
        !invocation.leaseUntil || invocation.leaseUntil <= now
      ) {
        throw new TeamRuntimeError("stale_lease", "Invocation lease is stale or expired", {
          invocationId: lease.invocation.id,
          generation: lease.generation,
        });
      }

      if (input.outcome.disposition === "no_action") {
        if (input.final || !input.outcome.reason?.trim() || input.outcome.targets?.length) {
          throw new TeamRuntimeError("conflict", "Silent completion requires a reason and cannot publish or dispatch");
        }
      } else if (!input.final) {
        throw new TeamRuntimeError("conflict", "A non-silent outcome requires a final message");
      }
      if (input.final && (input.final.threadId !== invocation.threadId || input.final.authorType !== "agent" || input.final.authorId !== invocation.targetAgentId ||
        (input.final.parentInvocationId !== undefined && input.final.parentInvocationId !== invocation.id) ||
        (input.final.replyTo !== undefined && input.final.replyTo !== invocation.sourceMessageId))) {
        throw new TeamRuntimeError("permission_denied", "Final does not belong to the leased invocation");
      }
      if (input.outcome.disposition === "awaiting_user" && (input.final?.wakeTargets?.length || input.outcome.targets?.length)) {
        throw new TeamRuntimeError("conflict", "A waiting turn cannot dispatch targets");
      }
      const slot = this.db.prepare(`
        SELECT invocation_id, generation, lease_token, lease_until
        FROM agent_slots WHERE thread_id=? AND agent_id=?
      `).get(invocation.threadId, invocation.targetAgentId) as Row | undefined;
      if (
        !slot || slot.invocation_id !== invocation.id || asNumber(slot.generation) !== lease.generation ||
        slot.lease_token !== lease.leaseToken || typeof slot.lease_until !== "string" || slot.lease_until <= now
      ) {
        throw new TeamRuntimeError("stale_lease", "Invocation slot lease is stale or expired", {
          invocationId: invocation.id,
        });
      }

      const delivery = this.getDelivery(invocation.sourceMessageId, invocation.targetAgentId);
      if (!delivery) throw new TeamRuntimeError("not_found", "Invocation delivery not found", { invocationId: invocation.id });
      if (delivery.status === "leased") {
        const deliveryLease = this.db.prepare(`
          SELECT lease_token, lease_until FROM deliveries WHERE message_id=? AND agent_id=?
        `).get(delivery.messageId, delivery.agentId) as Row;
        if (
          !input.deliveryToken || deliveryLease.lease_token !== input.deliveryToken ||
          typeof deliveryLease.lease_until !== "string" || deliveryLease.lease_until <= now
        ) {
          throw new TeamRuntimeError("stale_lease", "Delivery lease is stale or expired", {
            messageId: delivery.messageId,
            agentId: delivery.agentId,
          });
        }
      } else if (delivery.status !== "acked") {
        throw new TeamRuntimeError("stale_lease", `Delivery is ${delivery.status}`, {
          messageId: delivery.messageId,
          agentId: delivery.agentId,
        });
      }

      if (input.session) {
        const binding = this.getSessionBinding(invocation.threadId, invocation.targetAgentId);
        if (!binding || binding.status !== "active" || binding.generation !== lease.generation) {
          throw new TeamRuntimeError("stale_lease", "Session binding generation is stale", {
            invocationId: invocation.id,
            generation: lease.generation,
          });
        }
        this.updateSessionBinding(binding.threadId, binding.agentId, {
          ...input.session,
          generation: lease.generation,
        });
      }

      const final = input.final ? this.appendMessage(input.final) : undefined;
      if (input.process) this.writeProcess(invocation, input.process);
      if (input.session) {
        this.updateSessionBinding(invocation.threadId, invocation.targetAgentId, {
          lastVisibleSeq: input.injectedThroughSeq,
        });
      }
      this.advanceCursor(
        invocation.threadId,
        invocation.targetAgentId,
        input.injectedThroughSeq,
        delivery.messageId,
      );
      if (delivery.status === "leased") {
        this.ackDelivery(delivery.messageId, delivery.agentId, input.deliveryToken);
      }

      const invocationChanged = this.db.prepare(`
        UPDATE invocations
        SET status='completed', lease_token=NULL, lease_until=NULL, updated_at=?, last_error=NULL, outcome_json=?
        WHERE id=? AND status='running' AND generation=? AND lease_token=?
      `).run(now, json(input.outcome), invocation.id, lease.generation, lease.leaseToken).changes;
      const slotChanged = this.db.prepare(`
        UPDATE agent_slots
        SET invocation_id=NULL, lease_token=NULL, lease_until=NULL, heartbeat_at=NULL, updated_at=?
        WHERE thread_id=? AND agent_id=? AND invocation_id=? AND generation=? AND lease_token=?
      `).run(
        now,
        invocation.threadId,
        invocation.targetAgentId,
        invocation.id,
        lease.generation,
        lease.leaseToken,
      ).changes;
      if (Number(invocationChanged) !== 1 || Number(slotChanged) !== 1) {
        throw new TeamRuntimeError("stale_lease", "Invocation lease changed during final commit", {
          invocationId: invocation.id,
        });
      }
      return { invocation: this.getInvocation(invocation.id)!, final };
    });
  }
}

export function openTeamStore(path = ":memory:"): TeamStore {
  return new TeamStore(path);
}

export default TeamStore;
