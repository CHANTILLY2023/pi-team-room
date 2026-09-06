import { randomUUID } from "node:crypto";
import {
  TeamRuntimeError,
  type AgentId,
  type Invocation,
  type InvocationId,
  type InvocationLease,
  type InvocationStatus,
  type SessionBinding,
  type ThreadId,
} from "./types.ts";

/**
 * The scheduler deliberately depends on this small subset of DatabaseSync.
 * It also makes the coordinator straightforward to exercise with a test
 * double, while a real node:sqlite DatabaseSync remains the normal adapter.
 */
export interface SchedulerDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  };
}

export type SchedulerClock = () => Date | string | number;

export interface InvocationSchedulerOptions {
  /** Lease duration used by claim/heartbeat, in milliseconds. */
  leaseMs?: number;
  /** Maximum invocation depth. A root invocation has depth 0. */
  maxDepth?: number;
  /** Maximum number of invocations (including terminal ones) per root. */
  maxInvocationsPerRoot?: number;
  /** Maximum consecutive alternating edges in a two-agent ping-pong chain. */
  maxPingPong?: number;
  /** Maximum claim attempts before an expired invocation is dead-lettered. */
  maxAttempts?: number;
  /** Injectable clock; useful for deterministic tests and simulations. */
  now?: SchedulerClock;
  /** Alias accepted for callers that use the word clock. */
  clock?: SchedulerClock;
}

export interface EnqueueInvocationInput {
  id?: InvocationId;
  threadId: ThreadId;
  sourceMessageId: string;
  targetAgentId: AgentId;
  parentInvocationId?: InvocationId;
  rootInvocationId?: InvocationId;
  depth?: number;
  idempotencyKey: string;
  createdAt?: string;
}

export interface ClaimOptions {
  leaseMs?: number;
  now?: SchedulerClock;
}

export interface InvocationLeaseRef {
  invocationId: InvocationId;
  leaseToken: string;
  generation: number;
}

export interface FailOptions {
  /** Requeue instead of entering the terminal failed state. */
  retry?: boolean;
  /** Set a future retry time; only meaningful when retry is true. */
  retryAt?: string | Date | number;
}

export interface SessionBindingInput {
  threadId: ThreadId;
  agentId: AgentId;
  piSessionId: string;
  sessionFile?: string;
  cwd: string;
  provider: string;
  model: string;
  thinking?: string;
  status?: SessionBinding["status"];
  generation?: number;
  lastVisibleSeq?: number;
  createdAt?: string;
}

export interface SessionBindingPatch {
  piSessionId?: string;
  sessionFile?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  status?: SessionBinding["status"];
  generation?: number;
  lastVisibleSeq?: number;
  updatedAt?: string;
}

interface InvocationRow {
  id: string;
  thread_id: string;
  source_message_id: string;
  target_agent_id: string;
  parent_invocation_id: string | null;
  root_invocation_id: string;
  depth: number;
  status: InvocationStatus;
  generation: number;
  attempts: number;
  idempotency_key: string;
  lease_token: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  outcome_json?: string | null;
}

interface SlotRow {
  thread_id: string;
  agent_id: string;
  invocation_id: string | null;
  generation: number;
  lease_token: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  updated_at: string;
}

interface SessionRow {
  thread_id: string;
  agent_id: string;
  pi_session_id: string;
  session_file: string | null;
  cwd: string;
  provider: string;
  model: string;
  thinking: string | null;
  status: SessionBinding["status"];
  generation: number;
  last_visible_seq: number;
  created_at: string;
  updated_at: string;
}

type TransactionBody<T> = () => T;

const DEFAULTS = {
  leaseMs: 30_000,
  maxDepth: 8,
  maxInvocationsPerRoot: 32,
  maxPingPong: 4,
  maxAttempts: 3,
};

function asFiniteNonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return Math.floor(resolved);
}

function asPositive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a finite positive number`);
  }
  return resolved;
}

function iso(value: Date | string | number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${value}`);
  return date.toISOString();
}

function changes(result: { changes?: number | bigint }): number {
  return Number(result.changes ?? 0);
}

function row<T>(value: unknown): T | undefined {
  return value === undefined || value === null ? undefined : (value as T);
}

function stringOrUndefined(value: string | null | undefined): string | undefined {
  return value == null ? undefined : value;
}

function toInvocation(value: InvocationRow): Invocation {
  return {
    id: value.id,
    threadId: value.thread_id,
    sourceMessageId: value.source_message_id,
    targetAgentId: value.target_agent_id,
    parentInvocationId: stringOrUndefined(value.parent_invocation_id),
    rootInvocationId: value.root_invocation_id,
    depth: value.depth,
    status: value.status,
    generation: value.generation,
    attempts: value.attempts,
    idempotencyKey: value.idempotency_key,
    leaseToken: stringOrUndefined(value.lease_token),
    leaseUntil: stringOrUndefined(value.lease_until),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    lastError: stringOrUndefined(value.last_error),
    ...(value.outcome_json ? { outcome: JSON.parse(value.outcome_json) as Invocation["outcome"] } : {}),
  };
}

function toBinding(value: SessionRow): SessionBinding {
  return {
    threadId: value.thread_id,
    agentId: value.agent_id,
    piSessionId: value.pi_session_id,
    sessionFile: stringOrUndefined(value.session_file),
    cwd: value.cwd,
    provider: value.provider,
    model: value.model,
    thinking: stringOrUndefined(value.thinking),
    status: value.status,
    generation: value.generation,
    lastVisibleSeq: value.last_visible_seq,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function toLease(value: InvocationRow): InvocationLease {
  if (!value.lease_token) throw new Error(`Invocation ${value.id} has no active lease`);
  return {
    invocation: toInvocation(value),
    leaseToken: value.lease_token,
    generation: value.generation,
  };
}

/**
 * Durable scheduler for one Team coordinator database.
 *
 * All public mutations use a short SQLite transaction. Since DatabaseSync is
 * synchronous, BEGIN IMMEDIATE provides a simple compare-and-swap boundary
 * for multiple coordinator instances sharing the same database file.
 */
export class InvocationScheduler {
  readonly db: SchedulerDatabase;
  readonly options: Readonly<Required<Omit<InvocationSchedulerOptions, "now" | "clock" | "maxAttempts">> & {
    maxAttempts: number;
  }>;
  private readonly clock: SchedulerClock;

  constructor(db: SchedulerDatabase, options: InvocationSchedulerOptions = {}) {
    this.db = db;
    const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    if (maxAttempts !== Number.POSITIVE_INFINITY && (!Number.isFinite(maxAttempts) || maxAttempts <= 0)) {
      throw new TypeError("maxAttempts must be positive or Infinity");
    }
    this.options = {
      leaseMs: asPositive(options.leaseMs, DEFAULTS.leaseMs, "leaseMs"),
      maxDepth: asFiniteNonNegative(options.maxDepth, DEFAULTS.maxDepth, "maxDepth"),
      maxInvocationsPerRoot: asPositive(
        options.maxInvocationsPerRoot,
        DEFAULTS.maxInvocationsPerRoot,
        "maxInvocationsPerRoot",
      ),
      maxPingPong: asFiniteNonNegative(options.maxPingPong, DEFAULTS.maxPingPong, "maxPingPong"),
      maxAttempts,
    };
    this.clock = options.now ?? options.clock ?? (() => new Date());
    this.ensureSchema();
  }

  /** Creates the coordinator tables and indexes if this is a fresh database. */
  ensureSchema(): void {
    // TeamStore owns the canonical invocations/session_bindings tables. A
    // standalone DatabaseSync is still useful for scheduler-level tests, so
    // create compatible fallback tables only when those tables do not exist.
    const hasTable = (name: string): boolean => {
      const result = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name) as { present?: number } | undefined;
      return Boolean(result?.present);
    };
    if (!hasTable("invocations")) {
      this.db.exec(`
        CREATE TABLE invocations (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          parent_invocation_id TEXT,
          root_invocation_id TEXT NOT NULL,
          depth INTEGER NOT NULL CHECK (depth >= 0),
          status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','dead_letter')),
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          idempotency_key TEXT NOT NULL,
          lease_token TEXT,
          lease_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT,
          UNIQUE(thread_id, target_agent_id, idempotency_key)
        );
      `);
    }
    if (!hasTable("session_bindings")) {
      this.db.exec(`
        CREATE TABLE session_bindings (
          thread_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          pi_session_id TEXT NOT NULL,
          session_file TEXT,
          cwd TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          thinking TEXT,
          status TEXT NOT NULL CHECK (status IN ('active','sealing','sealed')),
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          last_visible_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_visible_seq >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(thread_id, agent_id)
        );
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS invocations_queue_idx
        ON invocations(thread_id, target_agent_id, status, created_at, id);
      CREATE INDEX IF NOT EXISTS invocations_root_idx
        ON invocations(root_invocation_id);
      CREATE TABLE IF NOT EXISTS agent_slots (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        invocation_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        lease_token TEXT,
        lease_until TEXT,
        heartbeat_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS agent_slots_lease_idx
        ON agent_slots(thread_id, agent_id, lease_until);
    `);
  }

  enqueue(input: EnqueueInvocationInput): Invocation {
    this.validateEnqueueInput(input);
    return this.transaction(() => {
      const duplicate = this.one<InvocationRow>(
        `SELECT * FROM invocations
         WHERE thread_id = ? AND target_agent_id = ? AND idempotency_key = ?`,
        input.threadId,
        input.targetAgentId,
        input.idempotencyKey,
      );
      if (duplicate) {
        if (input.id && input.id !== duplicate.id) {
          throw new TeamRuntimeError("conflict", "Idempotency key already belongs to another invocation", {
            idempotencyKey: input.idempotencyKey,
            invocationId: duplicate.id,
          });
        }
        return toInvocation(duplicate);
      }

      // TeamStore adds a durable Thread status table. Keep the standalone
      // scheduler fixture compatible, but enforce the sealed-thread fence when
      // this scheduler shares the canonical Team database.
      const threadTable = this.one<{ present?: number }>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
      );
      if (threadTable?.present) {
        const thread = this.one<{ status?: string }>("SELECT status FROM threads WHERE id = ?", input.threadId);
        if (!thread) {
          throw new TeamRuntimeError("not_found", `Thread ${input.threadId} was not found`, { threadId: input.threadId });
        }
        if (thread.status !== "active") {
          throw new TeamRuntimeError("thread_sealed", `Thread ${input.threadId} is ${thread.status}`, { threadId: input.threadId });
        }
      }

      const id = input.id ?? randomUUID();
      const idCollision = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", id);
      if (idCollision) {
        throw new TeamRuntimeError("conflict", `Invocation ${id} already exists`, { invocationId: id });
      }

      let parent: InvocationRow | undefined;
      if (input.parentInvocationId) {
        parent = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", input.parentInvocationId);
        if (!parent) {
          throw new TeamRuntimeError("not_found", `Parent invocation ${input.parentInvocationId} was not found`, {
            parentInvocationId: input.parentInvocationId,
          });
        }
        if (parent.thread_id !== input.threadId) {
          throw new TeamRuntimeError("conflict", "Parent invocation belongs to another thread", {
            parentThreadId: parent.thread_id,
            threadId: input.threadId,
          });
        }
      }

      const depth = parent ? parent.depth + 1 : input.depth ?? 0;
      if (input.depth !== undefined && input.depth !== depth) {
        throw new TeamRuntimeError("conflict", "Invocation depth does not match its parent", {
          expectedDepth: depth,
          receivedDepth: input.depth,
        });
      }
      if (depth > this.options.maxDepth) {
        throw new TeamRuntimeError("conflict", "Invocation depth limit exceeded", {
          reason: "max_depth",
          depth,
          maxDepth: this.options.maxDepth,
        });
      }

      const rootInvocationId = parent?.root_invocation_id ?? id;
      if (input.rootInvocationId !== undefined && input.rootInvocationId !== rootInvocationId) {
        throw new TeamRuntimeError("conflict", "Invocation root does not match its parent", {
          expectedRootInvocationId: rootInvocationId,
          receivedRootInvocationId: input.rootInvocationId,
        });
      }

      const rootCount = this.scalar<number>(
        "SELECT COUNT(*) AS count FROM invocations WHERE root_invocation_id = ?",
        rootInvocationId,
      );
      if (rootCount >= this.options.maxInvocationsPerRoot) {
        throw new TeamRuntimeError("conflict", "Invocation root budget exceeded", {
          reason: "max_invocations_per_root",
          rootInvocationId,
          count: rootCount,
          maxInvocationsPerRoot: this.options.maxInvocationsPerRoot,
        });
      }

      if (parent && this.options.maxPingPong > 0) {
        const alternatingEdges = this.pingPongEdges(input.targetAgentId, parent);
        if (alternatingEdges >= this.options.maxPingPong) {
          throw new TeamRuntimeError("conflict", "Invocation ping-pong circuit breaker tripped", {
            reason: "ping_pong",
            alternatingEdges,
            maxPingPong: this.options.maxPingPong,
          });
        }
      }

      const createdAt = iso(input.createdAt ?? this.clock());
      this.db.prepare(`
        INSERT INTO invocations (
          id, thread_id, source_message_id, target_agent_id, parent_invocation_id,
          root_invocation_id, depth, status, generation, attempts, idempotency_key,
          lease_token, lease_until, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, NULL, NULL, ?, ?, NULL)
      `).run(
        id,
        input.threadId,
        input.sourceMessageId,
        input.targetAgentId,
        input.parentInvocationId ?? null,
        rootInvocationId,
        depth,
        input.idempotencyKey,
        createdAt,
        createdAt,
      );
      return toInvocation(this.mustInvocation(id));
    });
  }

  /** Returns an invocation by ID, or undefined after a crash/restart lookup. */
  getInvocation(id: InvocationId): Invocation | undefined {
    const found = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", id);
    return found ? toInvocation(found) : undefined;
  }

  /** Alias useful to adapters that call their queue records jobs. */
  get(id: InvocationId): Invocation | undefined {
    return this.getInvocation(id);
  }

  listInvocations(filter: { threadId?: ThreadId; targetAgentId?: AgentId; status?: InvocationStatus } = {}): Invocation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.threadId !== undefined) {
      clauses.push("thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.targetAgentId !== undefined) {
      clauses.push("target_agent_id = ?");
      params.push(filter.targetAgentId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const suffix = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.all<InvocationRow>(`SELECT * FROM invocations${suffix} ORDER BY created_at, rowid`, ...params).map(toInvocation);
  }

  /**
   * Claims the oldest queued invocation for one (thread, agent) slot.
   * A live lease makes this return undefined: there is never a second
   * in-flight invocation for the same persistent AgentSession.
   */
  claimNext(threadId: ThreadId, agentId: AgentId, options?: ClaimOptions): InvocationLease | undefined;
  claimNext(input: { threadId: ThreadId; agentId: AgentId }, options?: ClaimOptions): InvocationLease | undefined;
  claimNext(
    threadOrInput: ThreadId | { threadId: ThreadId; agentId: AgentId },
    agentOrOptions?: AgentId | ClaimOptions,
    maybeOptions?: ClaimOptions,
  ): InvocationLease | undefined {
    const threadId = typeof threadOrInput === "string" ? threadOrInput : threadOrInput.threadId;
    const agentId = typeof threadOrInput === "string" ? (agentOrOptions as AgentId) : threadOrInput.agentId;
    const options = typeof threadOrInput === "string" ? maybeOptions : (agentOrOptions as ClaimOptions | undefined);
    if (!agentId) throw new TypeError("agentId is required");
    return this.transaction(() => this.claimNextInTransaction(threadId, agentId, options));
  }

  /** Claims a specific queued invocation, retaining the same slot fencing. */
  claim(invocationId: InvocationId, options: ClaimOptions = {}): InvocationLease | undefined {
    return this.transaction(() => {
      const now = iso((options.now ?? this.clock)());
      this.reclaimExpiredInTransaction(now);
      const invocation = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", invocationId);
      if (!invocation) return undefined;
      if (invocation.status === "queued" && invocation.lease_until && invocation.lease_until > now) return undefined;
      return this.claimRowInTransaction(invocation, options);
    });
  }

  /** Extends a live lease. Expired or replaced callbacks are rejected. */
  heartbeat(lease: InvocationLeaseRef | InvocationLease, options: ClaimOptions = {}): InvocationLease {
    const ref = this.leaseRef(lease);
    return this.transaction(() => {
      const now = iso((options.now ?? this.clock)());
      const current = this.assertLiveLease(ref, now);
      const until = new Date(new Date(now).getTime() + (options.leaseMs ?? this.options.leaseMs)).toISOString();
      this.db.prepare(`
        UPDATE invocations
        SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND generation = ? AND lease_token = ?
      `).run(until, now, ref.invocationId, ref.generation, ref.leaseToken);
      const slotChanged = changes(this.db.prepare(`
        UPDATE agent_slots
        SET lease_until = ?, heartbeat_at = ?, updated_at = ?
        WHERE thread_id = ? AND agent_id = ? AND invocation_id = ?
          AND generation = ? AND lease_token = ?
      `).run(
        until,
        now,
        now,
        current.thread_id,
        current.target_agent_id,
        ref.invocationId,
        ref.generation,
        ref.leaseToken,
      ));
      if (slotChanged !== 1) {
        throw new TeamRuntimeError("stale_lease", "Invocation slot no longer owns this lease", {
          invocationId: ref.invocationId,
        });
      }
      return toLease(this.mustInvocation(ref.invocationId));
    });
  }

  /** Marks a live invocation complete and releases its Agent slot. */
  complete(lease: InvocationLeaseRef | InvocationLease, at?: SchedulerClock): Invocation {
    return this.finish(lease, "completed", undefined, undefined, at);
  }

  /**
   * Fails a live invocation. `retry: true` puts it back in the durable queue;
   * the claim-attempt limit still prevents an infinite crash/retry loop.
   */
  fail(
    lease: InvocationLeaseRef | InvocationLease,
    error: string,
    options: FailOptions = {},
    at?: SchedulerClock,
  ): Invocation {
    if (!error) throw new TypeError("error must be non-empty");
    const retryAt = options.retryAt === undefined ? undefined : iso(options.retryAt);
    return this.finish(lease, options.retry ? "queued" : "failed", error, retryAt, at);
  }

  /** Cancels a queued or running invocation without making it retryable. */
  cancel(invocationId: InvocationId, reason = "Cancelled by user", at?: SchedulerClock): Invocation {
    if (!invocationId) throw new TypeError("invocationId is required");
    if (!reason) throw new TypeError("reason must be non-empty");
    return this.transaction(() => {
      const now = iso((at ?? this.clock)());
      const current = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", invocationId);
      if (!current) {
        throw new TeamRuntimeError("not_found", `Invocation ${invocationId} was not found`, { invocationId });
      }
      if (!["queued", "running"].includes(current.status)) return toInvocation(current);
      const updated = changes(this.db.prepare(`
        UPDATE invocations
        SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
            updated_at = ?, last_error = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(now, reason, invocationId));
      if (updated !== 1) return toInvocation(this.mustInvocation(invocationId));
      this.db.prepare(`
        UPDATE agent_slots
        SET invocation_id = NULL, lease_token = NULL, lease_until = NULL,
            heartbeat_at = NULL, updated_at = ?
        WHERE thread_id = ? AND agent_id = ? AND invocation_id = ?
      `).run(now, current.thread_id, current.target_agent_id, invocationId);
      return toInvocation(this.mustInvocation(invocationId));
    });
  }

  /** Reclaims expired leases and returns the number of invocations changed. */
  reclaimExpired(now: SchedulerClock | Date | string | number = this.clock): number {
    const timestamp = typeof now === "function" ? iso(now()) : iso(now);
    return this.transaction(() => this.reclaimExpiredInTransaction(timestamp));
  }

  /** Alias for queue workers that call this operation reap. */
  reapExpired(now: SchedulerClock | Date | string | number = this.clock): number {
    return this.reclaimExpired(now);
  }

  getSlot(threadId: ThreadId, agentId: AgentId): {
    threadId: ThreadId;
    agentId: AgentId;
    invocationId?: InvocationId;
    generation: number;
    leaseToken?: string;
    leaseUntil?: string;
    heartbeatAt?: string;
  } | undefined {
    const value = this.one<SlotRow>("SELECT * FROM agent_slots WHERE thread_id = ? AND agent_id = ?", threadId, agentId);
    if (!value) return undefined;
    return {
      threadId: value.thread_id,
      agentId: value.agent_id,
      invocationId: stringOrUndefined(value.invocation_id),
      generation: value.generation,
      leaseToken: stringOrUndefined(value.lease_token),
      leaseUntil: stringOrUndefined(value.lease_until),
      heartbeatAt: stringOrUndefined(value.heartbeat_at),
    };
  }

  /** Creates a binding, or updates the existing (thread, agent) mapping. */
  upsertSessionBinding(input: SessionBindingInput): SessionBinding {
    this.validateSessionInput(input);
    return this.transaction(() => {
      const now = iso(this.clock());
      const existing = this.one<SessionRow>(
        "SELECT * FROM session_bindings WHERE thread_id = ? AND agent_id = ?",
        input.threadId,
        input.agentId,
      );
      if (!existing) {
        const createdAt = iso(input.createdAt ?? now);
        this.db.prepare(`
          INSERT INTO session_bindings (
            thread_id, agent_id, pi_session_id, session_file, cwd, provider, model,
            thinking, status, generation, last_visible_seq, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.threadId,
          input.agentId,
          input.piSessionId,
          input.sessionFile ?? null,
          input.cwd,
          input.provider,
          input.model,
          input.thinking ?? null,
          input.status ?? "active",
          input.generation ?? 0,
          input.lastVisibleSeq ?? 0,
          createdAt,
          now,
        );
      } else {
        const generation = input.generation ?? existing.generation;
        if (generation < existing.generation) {
          throw new TeamRuntimeError("conflict", "Session binding generation cannot move backwards", {
            currentGeneration: existing.generation,
            receivedGeneration: generation,
          });
        }
        const lastVisibleSeq = Math.max(existing.last_visible_seq, input.lastVisibleSeq ?? existing.last_visible_seq);
        this.db.prepare(`
          UPDATE session_bindings
          SET pi_session_id = ?, session_file = ?, cwd = ?, provider = ?, model = ?,
              thinking = ?, status = ?, generation = ?, last_visible_seq = ?, updated_at = ?
          WHERE thread_id = ? AND agent_id = ?
        `).run(
          input.piSessionId,
          input.sessionFile ?? null,
          input.cwd,
          input.provider,
          input.model,
          input.thinking ?? null,
          input.status ?? existing.status,
          generation,
          lastVisibleSeq,
          now,
          input.threadId,
          input.agentId,
        );
      }
      return toBinding(this.mustSessionBinding(input.threadId, input.agentId));
    });
  }

  /** Reads the exact session bound to one persistent (thread, agent) pair. */
  getSessionBinding(threadId: ThreadId, agentId: AgentId): SessionBinding | undefined {
    const value = this.one<SessionRow>(
      "SELECT * FROM session_bindings WHERE thread_id = ? AND agent_id = ?",
      threadId,
      agentId,
    );
    return value ? toBinding(value) : undefined;
  }

  readSessionBinding(threadId: ThreadId, agentId: AgentId): SessionBinding | undefined {
    return this.getSessionBinding(threadId, agentId);
  }

  /** Updates a binding without allowing cursor or generation rollback. */
  updateSessionBinding(
    threadId: ThreadId,
    agentId: AgentId,
    patch: SessionBindingPatch,
    expectedGeneration?: number,
  ): SessionBinding {
    return this.transaction(() => {
      const current = this.mustSessionBinding(threadId, agentId);
      if (expectedGeneration !== undefined && expectedGeneration !== current.generation) {
        throw new TeamRuntimeError("conflict", "Session binding generation changed", {
          expectedGeneration,
          currentGeneration: current.generation,
        });
      }
      const generation = patch.generation ?? current.generation;
      if (generation < current.generation) {
        throw new TeamRuntimeError("conflict", "Session binding generation cannot move backwards", {
          currentGeneration: current.generation,
          receivedGeneration: generation,
        });
      }
      const lastVisibleSeq = Math.max(current.last_visible_seq, patch.lastVisibleSeq ?? current.last_visible_seq);
      const updatedAt = iso(patch.updatedAt ?? this.clock());
      this.db.prepare(`
        UPDATE session_bindings
        SET pi_session_id = ?, session_file = ?, cwd = ?, provider = ?, model = ?,
            thinking = ?, status = ?, generation = ?, last_visible_seq = ?, updated_at = ?
        WHERE thread_id = ? AND agent_id = ?
      `).run(
        patch.piSessionId ?? current.pi_session_id,
        patch.sessionFile === undefined ? current.session_file ?? null : patch.sessionFile,
        patch.cwd ?? current.cwd,
        patch.provider ?? current.provider,
        patch.model ?? current.model,
        patch.thinking === undefined ? current.thinking ?? null : patch.thinking,
        patch.status ?? current.status,
        generation,
        lastVisibleSeq,
        updatedAt,
        threadId,
        agentId,
      );
      return toBinding(this.mustSessionBinding(threadId, agentId));
    });
  }

  updateSession(
    threadId: ThreadId,
    agentId: AgentId,
    patch: SessionBindingPatch,
    expectedGeneration?: number,
  ): SessionBinding {
    return this.updateSessionBinding(threadId, agentId, patch, expectedGeneration);
  }

  private claimNextInTransaction(threadId: ThreadId, agentId: AgentId, options?: ClaimOptions): InvocationLease | undefined {
    const now = iso((options?.now ?? this.clock)());
    this.reclaimExpiredInTransaction(now, threadId, agentId);
    const slot = this.one<SlotRow>("SELECT * FROM agent_slots WHERE thread_id = ? AND agent_id = ?", threadId, agentId);
    if (slot?.invocation_id) {
      const live = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", slot.invocation_id);
      if (live?.status === "running" && live.lease_until && live.lease_until > now) return undefined;
      this.clearSlotIfMatches(slot);
    }
    const queued = this.one<InvocationRow>(
      `SELECT * FROM invocations
       WHERE thread_id = ? AND target_agent_id = ? AND status = 'queued'
         AND (lease_until IS NULL OR lease_until <= ?)
         AND (? = 0 OR attempts < ?)
       ORDER BY created_at, rowid LIMIT 1`,
      threadId,
      agentId,
      now,
      this.options.maxAttempts === Number.POSITIVE_INFINITY ? 0 : 1,
      this.options.maxAttempts === Number.POSITIVE_INFINITY ? 0 : this.options.maxAttempts,
    );
    if (!queued) {
      this.markExhaustedQueuedInTransaction(threadId, agentId, now);
      return undefined;
    }
    return this.claimRowInTransaction(queued, options);
  }

  private claimRowInTransaction(invocation: InvocationRow, options: ClaimOptions = {}): InvocationLease | undefined {
    if (invocation.status !== "queued") {
      if (invocation.status === "running" && invocation.lease_until && invocation.lease_until > iso((options.now ?? this.clock)())) {
        return undefined;
      }
      return undefined;
    }
    const now = iso((options.now ?? this.clock)());
    if (invocation.lease_until && invocation.lease_until > now) return undefined;
    const leaseMs = options.leaseMs ?? this.options.leaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError("leaseMs must be positive");
    const slot = this.one<SlotRow>(
      "SELECT * FROM agent_slots WHERE thread_id = ? AND agent_id = ?",
      invocation.thread_id,
      invocation.target_agent_id,
    );
    if (slot?.invocation_id) {
      const active = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", slot.invocation_id);
      if (active?.status === "running" && active.lease_until && active.lease_until > now) return undefined;
      this.clearSlotIfMatches(slot);
    }
    const generation = Math.max(invocation.generation, slot?.generation ?? 0) + 1;
    const leaseToken = randomUUID();
    const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
    const claimed = changes(this.db.prepare(`
      UPDATE invocations
      SET status = 'running', generation = ?, attempts = attempts + 1,
          lease_token = ?, lease_until = ?, updated_at = ?, last_error = NULL
      WHERE id = ? AND status = 'queued'
    `).run(generation, leaseToken, leaseUntil, now, invocation.id));
    if (claimed !== 1) return undefined;
    this.db.prepare(`
      INSERT INTO agent_slots (
        thread_id, agent_id, invocation_id, generation, lease_token, lease_until,
        heartbeat_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, agent_id) DO UPDATE SET
        invocation_id = excluded.invocation_id,
        generation = excluded.generation,
        lease_token = excluded.lease_token,
        lease_until = excluded.lease_until,
        heartbeat_at = excluded.heartbeat_at,
        updated_at = excluded.updated_at
    `).run(
      invocation.thread_id,
      invocation.target_agent_id,
      invocation.id,
      generation,
      leaseToken,
      leaseUntil,
      now,
      now,
    );
    return toLease(this.mustInvocation(invocation.id));
  }

  private finish(
    lease: InvocationLeaseRef | InvocationLease,
    status: "completed" | "failed" | "queued",
    error?: string,
    retryAt?: string,
    at?: SchedulerClock,
  ): Invocation {
    const ref = this.leaseRef(lease);
    return this.transaction(() => {
      const now = iso((at ?? this.clock)());
      const current = this.assertLiveLease(ref, now);
      const targetStatus = status === "queued" && this.options.maxAttempts !== Number.POSITIVE_INFINITY &&
        current.attempts >= this.options.maxAttempts ? "dead_letter" : status;
      const updated = changes(this.db.prepare(`
        UPDATE invocations
        SET status = ?, lease_token = NULL, lease_until = NULL,
            updated_at = ?, last_error = ?,
            source_message_id = source_message_id
        WHERE id = ? AND status = 'running' AND generation = ? AND lease_token = ?
      `).run(targetStatus, now, error ?? null, ref.invocationId, ref.generation, ref.leaseToken));
      if (updated !== 1) {
        throw new TeamRuntimeError("stale_lease", "Invocation lease was replaced", { invocationId: ref.invocationId });
      }
      this.db.prepare(`
        UPDATE agent_slots
        SET invocation_id = NULL, lease_token = NULL, lease_until = NULL,
            heartbeat_at = NULL, updated_at = ?
        WHERE thread_id = ? AND agent_id = ? AND invocation_id = ?
          AND generation = ? AND lease_token = ?
      `).run(now, current.thread_id, current.target_agent_id, ref.invocationId, ref.generation, ref.leaseToken);
      if (targetStatus === "queued" && retryAt) {
        this.db.prepare("UPDATE invocations SET lease_until = ? WHERE id = ? AND status = 'queued'").run(retryAt, ref.invocationId);
      }
      return toInvocation(this.mustInvocation(ref.invocationId));
    });
  }

  private reclaimExpiredInTransaction(now: string, threadId?: ThreadId, agentId?: AgentId): number {
    const clauses = ["status = 'running'", "lease_until IS NOT NULL", "lease_until <= ?"];
    const params: unknown[] = [now];
    if (threadId !== undefined) {
      clauses.push("thread_id = ?");
      params.push(threadId);
    }
    if (agentId !== undefined) {
      clauses.push("target_agent_id = ?");
      params.push(agentId);
    }
    const expired = this.all<InvocationRow>(`SELECT * FROM invocations WHERE ${clauses.join(" AND ")}`, ...params);
    for (const value of expired) {
      const nextStatus: InvocationStatus = this.options.maxAttempts !== Number.POSITIVE_INFINITY &&
        value.attempts >= this.options.maxAttempts ? "dead_letter" : "queued";
      this.db.prepare(`
        UPDATE invocations
        SET status = ?, lease_token = NULL, lease_until = NULL, updated_at = ?,
            last_error = CASE WHEN ? = 'dead_letter' THEN COALESCE(last_error, 'lease expired') ELSE last_error END
        WHERE id = ? AND status = 'running' AND generation = ? AND lease_token = ?
      `).run(nextStatus, now, nextStatus, value.id, value.generation, value.lease_token);
      this.db.prepare(`
        UPDATE agent_slots
        SET invocation_id = NULL, lease_token = NULL, lease_until = NULL,
            heartbeat_at = NULL, updated_at = ?
        WHERE thread_id = ? AND agent_id = ? AND invocation_id = ?
          AND generation = ? AND lease_token = ?
      `).run(now, value.thread_id, value.target_agent_id, value.id, value.generation, value.lease_token);
    }
    return expired.length;
  }

  private markExhaustedQueuedInTransaction(threadId: ThreadId, agentId: AgentId, now: string): void {
    if (this.options.maxAttempts === Number.POSITIVE_INFINITY) return;
    this.db.prepare(`
      UPDATE invocations
      SET status = 'dead_letter', updated_at = ?, last_error = COALESCE(last_error, 'maximum attempts exceeded')
      WHERE thread_id = ? AND target_agent_id = ? AND status = 'queued' AND attempts >= ?
    `).run(now, threadId, agentId, this.options.maxAttempts);
  }

  private assertLiveLease(ref: InvocationLeaseRef, now: string): InvocationRow {
    const current = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", ref.invocationId);
    if (
      !current ||
      current.status !== "running" ||
      current.generation !== ref.generation ||
      current.lease_token !== ref.leaseToken ||
      !current.lease_until ||
      current.lease_until <= now
    ) {
      throw new TeamRuntimeError("stale_lease", "Invocation lease is stale or expired", {
        invocationId: ref.invocationId,
        generation: ref.generation,
      });
    }
    const slot = this.one<SlotRow>(
      `SELECT * FROM agent_slots
       WHERE thread_id = ? AND agent_id = ? AND invocation_id = ?
         AND generation = ? AND lease_token = ?`,
      current.thread_id,
      current.target_agent_id,
      ref.invocationId,
      ref.generation,
      ref.leaseToken,
    );
    if (!slot || !slot.lease_until || slot.lease_until <= now) {
      throw new TeamRuntimeError("stale_lease", "Invocation slot lease is stale or expired", {
        invocationId: ref.invocationId,
      });
    }
    return current;
  }

  private clearSlotIfMatches(slot: SlotRow): void {
    if (!slot.invocation_id || !slot.lease_token) return;
    this.db.prepare(`
      UPDATE agent_slots
      SET invocation_id = NULL, lease_token = NULL, lease_until = NULL,
          heartbeat_at = NULL, updated_at = ?
      WHERE thread_id = ? AND agent_id = ? AND invocation_id = ?
        AND generation = ? AND lease_token = ?
    `).run(iso(this.clock()), slot.thread_id, slot.agent_id, slot.invocation_id, slot.generation, slot.lease_token);
  }

  private pingPongEdges(currentTarget: AgentId, parent: InvocationRow): number {
    const ids = [currentTarget];
    let cursor: InvocationRow | undefined = parent;
    while (cursor && ids.length <= this.options.maxPingPong + 2) {
      ids.push(cursor.target_agent_id);
      if (!cursor.parent_invocation_id) break;
      cursor = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", cursor.parent_invocation_id);
    }
    if (ids.length < 3 || ids[0] === ids[1]) return 0;
    const first = ids[0];
    const second = ids[1];
    let edges = 1;
    for (let i = 2; i < ids.length; i += 1) {
      const expected = i % 2 === 0 ? first : second;
      if (ids[i] !== expected) break;
      edges += 1;
    }
    return edges;
  }

  private leaseRef(value: InvocationLeaseRef | InvocationLease): InvocationLeaseRef {
    return "invocation" in value
      ? { invocationId: value.invocation.id, leaseToken: value.leaseToken, generation: value.generation }
      : value;
  }

  private validateEnqueueInput(input: EnqueueInvocationInput): void {
    for (const [name, value] of Object.entries({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      targetAgentId: input.targetAgentId,
      idempotencyKey: input.idempotencyKey,
    })) {
      if (!value || typeof value !== "string") throw new TypeError(`${name} must be a non-empty string`);
    }
    if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 0)) {
      throw new TypeError("depth must be a non-negative integer");
    }
  }

  private validateSessionInput(input: SessionBindingInput): void {
    for (const [name, value] of Object.entries({
      threadId: input.threadId,
      agentId: input.agentId,
      piSessionId: input.piSessionId,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
    })) {
      if (!value || typeof value !== "string") throw new TypeError(`${name} must be a non-empty string`);
    }
    if (input.generation !== undefined && (!Number.isInteger(input.generation) || input.generation < 0)) {
      throw new TypeError("generation must be a non-negative integer");
    }
    if (input.lastVisibleSeq !== undefined && (!Number.isInteger(input.lastVisibleSeq) || input.lastVisibleSeq < 0)) {
      throw new TypeError("lastVisibleSeq must be a non-negative integer");
    }
  }

  private mustInvocation(id: InvocationId): InvocationRow {
    const value = this.one<InvocationRow>("SELECT * FROM invocations WHERE id = ?", id);
    if (!value) throw new TeamRuntimeError("not_found", `Invocation ${id} was not found`, { invocationId: id });
    return value;
  }

  private mustSessionBinding(threadId: ThreadId, agentId: AgentId): SessionRow {
    const value = this.one<SessionRow>(
      "SELECT * FROM session_bindings WHERE thread_id = ? AND agent_id = ?",
      threadId,
      agentId,
    );
    if (!value) {
      throw new TeamRuntimeError("not_found", `Session binding ${threadId}/${agentId} was not found`, {
        threadId,
        agentId,
      });
    }
    return value;
  }

  private one<T>(sql: string, ...params: unknown[]): T | undefined {
    return row<T>(this.db.prepare(sql).get(...params));
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private scalar<T extends number>(sql: string, ...params: unknown[]): T {
    const result = this.one<{ count: number | bigint }>(sql, ...params);
    return Number(result?.count ?? 0) as T;
  }

  private transaction<T>(body: TransactionBody<T>): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error if a failed connection cannot roll back.
      }
      throw error;
    }
  }
}

export function createInvocationScheduler(
  db: SchedulerDatabase,
  options?: InvocationSchedulerOptions,
): InvocationScheduler {
  return new InvocationScheduler(db, options);
}

export default InvocationScheduler;
