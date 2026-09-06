export type AgentId = string;
export type TeamId = string;
export type ThreadId = string;
export type ThreadFolderId = string;
export type MessageId = string;
export type InvocationId = string;

export type MessageVisibility = "team" | "direct" | "private";
export type RuntimePolicy = "always_on" | "idle_timeout" | "on_demand";

export interface TurnControl {
  disposition: "completed" | "no_action" | "awaiting_user";
  reason?: string;
  /** When present, this is authoritative, including an explicitly empty list. */
  targets?: AgentId[];
}

export interface InvocationOutcome extends TurnControl {
  version: 1;
  basedOnSeq: number;
  routing: "text" | "explicit" | "parallel_suppressed" | "terminal";
  resolvedByMessageId?: MessageId;
}

export interface MessageProtocol {
  version: 1;
  mode: "handoff" | "parallel";
  disposition?: TurnControl["disposition"];
}

export interface AgentRoleProfile {
  roleDescription?: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string;
}

export interface PersistentAgent {
  id: AgentId;
  name: string;
  /** Runtime client path: pi/grok-pi use PI Agent sessions; kimi-code/claude-code/codex-cli/grok-build use local CLI prompt mode. */
  clientId?: string;
  provider: string;
  model: string;
  thinking?: string;
  /** Absolute files/directories accepted by PI's additionalSkillPaths option. */
  skillPaths: string[];
  /** @deprecated Input-only compatibility alias; persisted agents use skillPaths. */
  skills?: string[];
  aliases: string[];
  roleProfile?: AgentRoleProfile;
  /** @deprecated Prefer roleProfile; kept for already-saved freeform prompts. */
  rolePrompt?: string;
  runtimePolicy: RuntimePolicy;
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: TeamId;
  name: string;
  ownerId: string;
  defaultAgentId?: AgentId;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TeamMember {
  teamId: TeamId;
  agentId: AgentId;
  name: string;
  role?: string;
  provider: string;
  model: string;
  aliases: string[];
  enabled: boolean;
  joinedAt: string;
}

export interface TeamThread {
  id: ThreadId;
  teamId: TeamId;
  folderId?: ThreadFolderId;
  title?: string;
  status: "active" | "sealed" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface ThreadFolder {
  id: ThreadFolderId;
  teamId: TeamId;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalMessage {
  id: MessageId;
  threadId: ThreadId;
  seq: number;
  authorType: "user" | "agent" | "system";
  authorId: string;
  content: string;
  visibility: MessageVisibility;
  visibleTo: AgentId[];
  wakeTargets: AgentId[];
  replyTo?: MessageId;
  parentInvocationId?: InvocationId;
  idempotencyKey?: string;
  createdAt: string;
  protocol?: MessageProtocol;
}

export interface AppendMessageInput {
  id?: MessageId;
  threadId: ThreadId;
  authorType: CanonicalMessage["authorType"];
  authorId: string;
  content: string;
  visibility?: MessageVisibility;
  visibleTo?: AgentId[];
  wakeTargets?: AgentId[];
  /** Raw mention selectors that resolved to each durable target snapshot. */
  targetSelectors?: Record<AgentId, string[]>;
  replyTo?: MessageId;
  parentInvocationId?: InvocationId;
  idempotencyKey?: string;
  protocol?: MessageProtocol;
}

export type DeliveryStatus = "queued" | "leased" | "acked" | "failed" | "dead_letter";

export interface Delivery {
  messageId: MessageId;
  agentId: AgentId;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt?: string;
  ackedAt?: string;
  lastError?: string;
}

export type InvocationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "dead_letter";

export interface Invocation {
  id: InvocationId;
  threadId: ThreadId;
  sourceMessageId: MessageId;
  targetAgentId: AgentId;
  parentInvocationId?: InvocationId;
  rootInvocationId: InvocationId;
  depth: number;
  status: InvocationStatus;
  generation: number;
  attempts: number;
  idempotencyKey: string;
  leaseToken?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  outcome?: InvocationOutcome;
}

export interface SessionBinding {
  threadId: ThreadId;
  agentId: AgentId;
  piSessionId: string;
  sessionFile?: string;
  cwd: string;
  provider: string;
  model: string;
  thinking?: string;
  runtimeConfigKey?: string;
  modelRef?: string;
  contextInitialized?: boolean;
  contextThroughSeq?: number;
  status: "active" | "sealing" | "sealed";
  generation: number;
  lastVisibleSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface InvocationLease {
  invocation: Invocation;
  leaseToken: string;
  generation: number;
}

export interface ResolvedMentions {
  targets: AgentId[];
  selectors: string[];
  body: string;
  explicit: boolean;
}

export interface TeamRuntimeSetupInput {
  name: string;
  ownerId: string;
  title?: string;
  teamId?: TeamId;
  threadId?: ThreadId;
}

export interface AddPersistentAgentInput {
  teamId: TeamId;
  name: string;
  clientId?: string;
  provider: string;
  model: string;
  role?: string;
  thinking?: string;
  /** Skill names or PI-compatible paths; resolved before persistence. */
  skills?: string[];
  skillRefs?: string[];
  aliases?: string[];
  roleProfile?: AgentRoleProfile;
  rolePrompt?: string;
  runtimePolicy?: RuntimePolicy;
  agentId?: AgentId;
  makeDefault?: boolean;
}

export interface TeamSendResult {
  message: CanonicalMessage;
  invocations: Invocation[];
}

export type TeamRuntimeErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_mention"
  | "ambiguous_mention"
  | "permission_denied"
  | "thread_sealed"
  | "busy"
  | "stale_lease";

export class TeamRuntimeError extends Error {
  constructor(
    public readonly code: TeamRuntimeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TeamRuntimeError";
  }
}
