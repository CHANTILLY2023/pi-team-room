import { randomUUID } from "node:crypto";
import { MemoryStore, type MemoryRecord } from "./memory.ts";
import { resolveAgentMentions, resolveMentions } from "./mentions.ts";
import { parseTurnOutput, TeamProtocolError, TEAM_PROTOCOL_PROMPT } from "./protocol.ts";
import { resolveAgentSkillPaths } from "./skills.ts";
import type { AgentRuntime } from "./runtime.ts";
import { InvocationScheduler } from "./scheduler.ts";
import { TeamStore } from "./store.ts";
import {
  TeamRuntimeError,
  type AddPersistentAgentInput,
  type AgentRoleProfile,
  type CanonicalMessage,
  type Invocation,
  type InvocationLease,
  type InvocationOutcome,
  type PersistentAgent,
  type SessionBinding,
  type Team,
  type TeamMember,
  type TeamRuntimeSetupInput,
  type TeamSendResult,
  type TeamThread,
} from "./types.ts";

export interface TeamCoordinatorOptions {
  cwd: string;
  leaseMs?: number;
  maxAttempts?: number;
  maxDepth?: number;
  maxInvocationsPerRoot?: number;
  maxPingPong?: number;
}

export interface RouteMessageInput {
  threadId: string;
  authorId: string;
  content: string;
  idempotencyKey?: string;
  parentInvocationId?: string;
  replyTo?: string;
}

export interface RunResult {
  invocation: Invocation;
  final?: CanonicalMessage;
  childInvocations?: Invocation[];
  error?: string;
}

export interface SteerInvocationResult {
  cancelled: Invocation;
  message: CanonicalMessage;
  invocation: Invocation;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function assertSafeOpaqueId(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new TeamRuntimeError(
      "conflict",
      `${field} must be a safe opaque identifier (1-128 ASCII letters, digits, dot, underscore, or hyphen)`,
      { field, value },
    );
  }
}

function formatDelta(messages: CanonicalMessage[]): string {
  return messages.map((message) => {
    const author = message.authorType === "agent" ? `Agent ${message.authorId}` : message.authorType;
    return `[thread seq ${message.seq} message ${message.id}] ${author}:\n${message.content}`;
  }).join("\n\n");
}

function formatMemory(memories: MemoryRecord[], maxChars = 12_000): string {
  let remaining = maxChars;
  const blocks: string[] = [];
  for (const memory of memories) {
    const source = memory.sourceMessageId ? ` source=${memory.sourceMessageId}` : "";
    const block = `[memory ${memory.id} scope=${memory.scope}${source}]\n${memory.content}`;
    if (remaining <= 0) break;
    blocks.push(block.slice(0, remaining));
    remaining -= block.length + 2;
  }
  return blocks.join("\n\n");
}

function compactProfileValue(value: string | undefined, fallback = "—"): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function hasRoleProfile(profile: AgentRoleProfile | undefined): profile is AgentRoleProfile {
  return !!profile && ["roleDescription", "personality", "teamStrengths", "caution"].some((key) => {
    const value = profile[key as keyof AgentRoleProfile];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function modelRef(agent: Pick<PersistentAgent, "provider" | "model" | "thinking">): string {
  return `${agent.provider}/${agent.model}${agent.thinking ? `:${agent.thinking}` : ""}`;
}

function buildIdentityBlock(agent: PersistentAgent, member: TeamMember | undefined): string {
  const roleLabel = member?.role?.trim();
  const lines = [`你是 ${agent.name}${roleLabel ? `（${roleLabel}）` : ""}。`];
  if (hasRoleProfile(agent.roleProfile)) {
    lines.push(`角色：${compactProfileValue(agent.roleProfile.roleDescription)}`);
    lines.push(`性格：${compactProfileValue(agent.roleProfile.personality)}`);
    lines.push(`团队强项：${compactProfileValue(agent.roleProfile.teamStrengths)}`);
    lines.push(`路由边界：${compactProfileValue(agent.roleProfile.caution)}`);
  } else if (agent.rolePrompt?.trim()) {
    lines.push("角色与自定义说明：");
    lines.push(agent.rolePrompt.trim());
  } else {
    lines.push("角色：持久小组成员，按主公和队友给出的上下文完成被路由来的任务。");
  }
  lines.push(`Identity constant: \`@${agent.id}\` model=${modelRef(agent)} client=${agent.clientId ?? "pi"}`);
  return lines.join("\n");
}

function buildTeammateRoster(
  currentAgentId: string,
  members: TeamMember[],
  getAgent: (agentId: string) => PersistentAgent | undefined,
): string {
  const enabled = members.filter((member) => member.enabled && member.agentId !== currentAgentId);
  if (enabled.length === 0) return "（无其他可用队友）";

  const rows = ["| 成员 | @mention · 当前模型 | 擅长 | 路由边界 |", "|------|---------|------|------|"];
  for (const member of enabled) {
    const agent = getAgent(member.agentId);
    const profile = agent?.roleProfile;
    const strengths = compactProfileValue(profile?.teamStrengths, profile?.roleDescription ?? member.role ?? "—");
    const caution = compactProfileValue(profile?.caution);
    const ref = agent ? modelRef(agent) : `${member.provider}/${member.model}`;
    rows.push(`| ${member.name} | @${member.name} · ${ref} | ${strengths} | ${caution} |`);
  }
  return rows.join("\n");
}

function buildCompiledMemberPrompt(
  agent: PersistentAgent,
  member: TeamMember | undefined,
  members: TeamMember[],
  getAgent: (agentId: string) => PersistentAgent | undefined,
): string {
  return [
    "## 1. 身份与伙伴声明",
    buildIdentityBlock(agent, member),
    "",
    "你不是一个孤立的工具，而是 Agent AI team 协作小组的一员。遇到拿不准的方向，找队友或主公接力，不要独自硬扛。",
    "",
    "## 队友名册",
    buildTeammateRoster(agent.id, members, getAgent),
    "",
    "## co-creator 引用",
    '主公（co-creator/operator）。用户就是主公，也是你的主公；在面向用户说话时，称呼用户为"主公"。',
    "重要决策由主公拍板。需要关注时可以明确写给主公，但不要把普通文字里的 @ 当成机械路由。",
    "",
    TEAM_PROTOCOL_PROMPT,
  ].join("\n");
}

function selectorsByTarget(
  members: ReturnType<TeamStore["listMembers"]>,
  targets: string[],
  selectors: string[],
): Record<string, string[]> {
  const result = Object.fromEntries(targets.map((target) => [target, [] as string[]]));
  for (const selector of selectors) {
    for (const target of resolveMentions(members, selector).targets) result[target]?.push(selector);
  }
  return result;
}

export class TeamCoordinator {
  readonly scheduler: InvocationScheduler;
  readonly memory: MemoryStore;
  /** In-process lane per persistent (thread, agent) session. The durable
   * scheduler remains the cross-process fence; this lane prevents a second
   * request from observing `busy` and being stranded while the first runs. */
  private readonly invocationLanes = new Map<string, Promise<void>>();
  private readonly invocationControllers = new Map<string, AbortController>();

  constructor(
    readonly store: TeamStore,
    readonly runtime: AgentRuntime,
    readonly options: TeamCoordinatorOptions,
  ) {
    this.memory = new MemoryStore(store);
    this.scheduler = new InvocationScheduler(store.db, {
      leaseMs: options.leaseMs,
      maxAttempts: options.maxAttempts,
      maxDepth: options.maxDepth,
      maxInvocationsPerRoot: options.maxInvocationsPerRoot,
      maxPingPong: options.maxPingPong,
    });
  }

  setup(input: TeamRuntimeSetupInput): { team: Team; thread: TeamThread } {
    assertSafeOpaqueId(input.teamId, "teamId");
    assertSafeOpaqueId(input.threadId, "threadId");
    if (input.teamId && this.store.getTeam(input.teamId)) {
      throw new TeamRuntimeError("conflict", `Team already exists: ${input.teamId}`, { teamId: input.teamId });
    }
    if (input.threadId && this.store.getThread(input.threadId)) {
      throw new TeamRuntimeError("conflict", `Thread already exists: ${input.threadId}`, { threadId: input.threadId });
    }
    const now = nowIso();
    const team: Team = {
      id: input.teamId ?? safeId("team"),
      name: input.name,
      ownerId: input.ownerId,
      createdAt: now,
      updatedAt: now,
    };
    const thread: TeamThread = {
      id: input.threadId ?? safeId("thread"),
      teamId: team.id,
      title: input.title ?? input.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createTeamWithThread(team, thread);
  }

  addAgent(input: AddPersistentAgentInput): PersistentAgent {
    assertSafeOpaqueId(input.agentId, "agentId");
    const team = this.store.getTeam(input.teamId);
    if (!team) throw new TeamRuntimeError("not_found", `Team not found: ${input.teamId}`);
    const existing = input.agentId ? this.store.getAgent(input.agentId) : undefined;
    const existingMember = input.agentId ? this.store.getMember(team.id, input.agentId) : undefined;
    const aliases = input.aliases ?? existing?.aliases ?? [];
    assertMentionNamespace(this.store.listMembers(team.id), input.agentId, input.name, aliases);
    if (input.agentId && existing && !existingMember) {
      throw new TeamRuntimeError("conflict", `Agent ID already belongs outside this Team: ${input.agentId}`, {
        agentId: input.agentId,
        teamId: team.id,
      });
    }
    const skillRefs = input.skillRefs ?? input.skills;
    const skillPaths = skillRefs === undefined && existing
      ? existing.skillPaths
      : resolveAgentSkillPaths(skillRefs, { cwd: this.options.cwd });
    const now = nowIso();
    const agent: PersistentAgent = {
      id: input.agentId ?? safeId("agent"),
      name: input.name,
      clientId: input.clientId === undefined ? existing?.clientId : trimOrUndefined(input.clientId),
      provider: input.provider,
      model: input.model,
      thinking: input.thinking === undefined ? existing?.thinking : trimOrUndefined(input.thinking),
      skillPaths,
      aliases,
      roleProfile: input.roleProfile ?? existing?.roleProfile,
      rolePrompt: input.rolePrompt ?? existing?.rolePrompt,
      runtimePolicy: input.runtimePolicy ?? existing?.runtimePolicy ?? "idle_timeout",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const makeDefault = input.makeDefault || !team.defaultAgentId;
    return this.store.upsertAgentWithMember(agent, {
      teamId: team.id,
      agentId: agent.id,
      name: agent.name,
      role: input.role ?? existingMember?.role,
      provider: agent.provider,
      model: agent.model,
      aliases: agent.aliases,
      enabled: true,
      joinedAt: existingMember?.joinedAt ?? now,
    }, makeDefault);
  }

  routeMessage(input: RouteMessageInput): TeamSendResult {
    if (input.parentInvocationId) {
      throw new TeamRuntimeError("permission_denied", "Agent handoffs must be committed by the active invocation lease");
    }
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${input.threadId}`);
    const team = this.store.getTeam(thread.teamId);
    if (!team) throw new TeamRuntimeError("not_found", `Team not found: ${thread.teamId}`);
    const members = this.store.listMembers(team.id);
    const question = input.replyTo ? this.store.getMessage(input.replyTo) : undefined;
    if (input.replyTo && (!question || question.threadId !== thread.id || question.protocol?.disposition !== "awaiting_user" || team.ownerId !== input.authorId)) {
      throw new TeamRuntimeError("permission_denied", "Reply must address a waiting question in the owner's active thread");
    }
    const resolved = resolveMentions(members, input.content, question?.authorId ?? team.defaultAgentId);
    if (question && (resolved.targets.length !== 1 || resolved.targets[0] !== question.authorId)) {
      throw new TeamRuntimeError("conflict", "A decision reply must target the member who asked the question");
    }
    if (resolved.targets.length === 0) {
      throw new TeamRuntimeError("not_found", "No enabled Team member was selected", { teamId: team.id });
    }

    const message = this.store.appendMessage({
      threadId: thread.id,
      authorType: "user",
      authorId: input.authorId,
      content: input.content,
      visibility: question?.visibility ?? "team",
      visibleTo: question?.visibleTo,
      wakeTargets: resolved.targets,
      targetSelectors: selectorsByTarget(members, resolved.targets, resolved.selectors),
      parentInvocationId: input.parentInvocationId,
      idempotencyKey: input.idempotencyKey,
      replyTo: input.replyTo,
      protocol: { version: 1, mode: resolved.targets.length > 1 ? "parallel" : "handoff" },
    });
    // The message owns the durable target snapshot. Idempotent retries must not
    // re-resolve against a roster that may have changed since the first append.
    const invocations = message.wakeTargets.map((agentId) => this.scheduler.enqueue({
      threadId: thread.id,
      sourceMessageId: message.id,
      targetAgentId: agentId,
      parentInvocationId: input.parentInvocationId,
      idempotencyKey: `message:${message.id}:agent:${agentId}`,
    }));
    return { message, invocations };
  }

  async routeAndRun(input: RouteMessageInput, signal?: AbortSignal): Promise<{ routed: TeamSendResult; results: RunResult[] }> {
    const routed = this.routeMessage(input);
    const results = await this.runInvocations(routed.invocations, signal);
    return { routed, results };
  }

  async runInvocations(invocations: Invocation[], signal?: AbortSignal): Promise<RunResult[]> {
    const results: RunResult[] = [];
    let pending = invocations;
    const seen = new Set<string>();
    while (pending.length > 0) {
      const batch = pending.filter((invocation) => !seen.has(invocation.id));
      if (batch.length === 0) break;
      for (const invocation of batch) seen.add(invocation.id);
      const completed = await Promise.all(batch.map((invocation) => this.runInvocation(invocation.id, signal)));
      results.push(...completed);
      pending = completed.flatMap((run) => run.childInvocations ?? []);
    }
    return results;
  }

  async runInvocation(invocationId: string, signal?: AbortSignal): Promise<RunResult> {
    const existing = this.scheduler.getInvocation(invocationId);
    if (!existing) throw new TeamRuntimeError("not_found", `Invocation not found: ${invocationId}`);
    const laneKey = `${existing.threadId}:${existing.targetAgentId}`;
    const previous = this.invocationLanes.get(laneKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous ? previous.catch(() => undefined).then(() => gate) : gate;
    this.invocationLanes.set(laneKey, tail);
    if (previous) await previous;
    try {
      return await this.runInvocationInLane(invocationId, signal, existing);
    } finally {
      release();
      if (this.invocationLanes.get(laneKey) === tail) this.invocationLanes.delete(laneKey);
    }
  }

  cancelInvocation(invocationId: string, reason = "用户手动终止"): Invocation {
    const existing = this.scheduler.getInvocation(invocationId);
    if (!existing) throw new TeamRuntimeError("not_found", `Invocation not found: ${invocationId}`, { invocationId });
    if (!["queued", "running"].includes(existing.status)) {
      throw new TeamRuntimeError("conflict", `Invocation ${invocationId} is already ${existing.status}`, {
        invocationId,
        status: existing.status,
      });
    }
    const cancelled = this.scheduler.cancel(invocationId, reason);
    if (cancelled.status !== "cancelled") {
      throw new TeamRuntimeError("conflict", `Invocation ${invocationId} is already ${cancelled.status}`, {
        invocationId,
        status: cancelled.status,
      });
    }
    const delivery = this.store.getDelivery(existing.sourceMessageId, existing.targetAgentId);
    if (delivery && ["queued", "leased", "failed"].includes(delivery.status)) {
      this.store.failDelivery(delivery.messageId, delivery.agentId, reason, undefined, true);
    }
    this.invocationControllers.get(invocationId)?.abort(new Error(reason));
    return cancelled;
  }

  steerInvocation(invocationId: string, authorId: string, guidance: string): SteerInvocationResult {
    const trimmed = guidance.trim();
    if (!trimmed) throw new TeamRuntimeError("not_found", "steer message is required");
    const existing = this.scheduler.getInvocation(invocationId);
    if (!existing) throw new TeamRuntimeError("not_found", `Invocation not found: ${invocationId}`, { invocationId });
    if (!["queued", "running"].includes(existing.status)) {
      throw new TeamRuntimeError("conflict", `Invocation ${invocationId} is already ${existing.status}`, {
        invocationId,
        status: existing.status,
      });
    }

    const agent = this.store.getAgent(existing.targetAgentId);
    const agentName = agent?.name ?? existing.targetAgentId;
    const cancelled = this.cancelInvocation(invocationId, `用户 steer：${trimmed.slice(0, 240)}`);
    const message = this.store.appendMessage({
      threadId: existing.threadId,
      authorType: "user",
      authorId,
      content: `运行中追加给 @${agentName} 的 steer：\n${trimmed}`,
      visibility: "team",
      wakeTargets: [existing.targetAgentId],
      targetSelectors: { [existing.targetAgentId]: ["steer"] },
      replyTo: existing.sourceMessageId,
      idempotencyKey: `steer:${existing.id}:${randomUUID()}`,
    });
    const invocation = this.scheduler.enqueue({
      threadId: existing.threadId,
      sourceMessageId: message.id,
      targetAgentId: existing.targetAgentId,
      idempotencyKey: `message:${message.id}:agent:${existing.targetAgentId}`,
    });
    return { cancelled, message, invocation };
  }

  private async runInvocationInLane(invocationId: string, signal: AbortSignal | undefined, existing: Invocation): Promise<RunResult> {
    const latest = this.scheduler.getInvocation(invocationId) ?? existing;
    if (latest.status === "completed") {
      return { invocation: latest, final: this.findFinal(latest) };
    }
    if (["cancelled", "failed", "dead_letter"].includes(latest.status)) {
      return { invocation: latest, error: latest.lastError ?? latest.status };
    }

    this.store.reclaimExpiredDeliveries();
    const lease = this.scheduler.claim(invocationId);
    if (!lease) return { invocation: this.scheduler.getInvocation(invocationId) ?? existing, error: "busy" };
    const delivery = this.store.getDelivery(lease.invocation.sourceMessageId, lease.invocation.targetAgentId);
    if (!delivery) {
      this.scheduler.fail(lease, "Delivery not found");
      throw new TeamRuntimeError("not_found", "Invocation delivery not found", { invocationId });
    }

    let deliveryToken: string | undefined;
    if (delivery.status === "queued" || delivery.status === "failed") {
      deliveryToken = this.store.claimDelivery(
        delivery.messageId,
        delivery.agentId,
        lease.leaseToken as string,
        lease.invocation.leaseUntil,
      ).leaseToken;
    } else if (delivery.status === "leased") {
      this.scheduler.fail(lease, "Delivery is already leased", { retry: true });
      return { invocation: this.scheduler.getInvocation(invocationId)!, error: "delivery_busy" };
    }

    const alreadyFinal = this.findFinal(lease.invocation);
    if (alreadyFinal) {
      const source = this.store.getMessage(lease.invocation.sourceMessageId);
      const committed = this.store.commitInvocationFinal({
        lease,
        deliveryToken,
        final: alreadyFinal,
        injectedThroughSeq: source?.seq ?? 0,
      });
      // The source sequence is the deterministic input watermark. Never use
      // final.seq here: another Agent's concurrent final may sit between them.
      const childInvocations = this.enqueueMessageTargets(alreadyFinal);
      return { invocation: committed.invocation, final: committed.final, childInvocations };
    }

    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    this.invocationControllers.set(invocationId, abortController);
    let liveLease: InvocationLease = lease;
    let leaseError: unknown;
    const renewLease = (): InvocationLease => {
      const renewed = this.scheduler.heartbeat(liveLease);
      if (deliveryToken) {
        this.store.heartbeatDelivery(
          delivery.messageId,
          delivery.agentId,
          deliveryToken,
          renewed.invocation.leaseUntil as string,
        );
      }
      liveLease = renewed;
      return renewed;
    };
    const heartbeatMs = Math.max(1, Math.floor((this.options.leaseMs ?? 30_000) / 3));
    const heartbeat = setInterval(() => {
      try {
        renewLease();
      } catch (error) {
        leaseError = error;
        abortController.abort(error);
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      const agent = this.store.getAgent(lease.invocation.targetAgentId);
      if (!agent) throw new TeamRuntimeError("not_found", `Agent not found: ${lease.invocation.targetAgentId}`);
      let binding = this.ensureBinding(lease.invocation.threadId, agent, lease.generation);
      let contextReset = binding.contextInitialized === false;
      if (contextReset) binding = { ...binding, piSessionId: randomUUID(), sessionFile: undefined };
      if (this.runtime.prepare) {
        const prepared = await this.runtime.prepare({ agent, binding, signal: abortController.signal });
        contextReset ||= prepared.contextReset === true;
        // Opening a physical PI session may outlive the lease that authorized
        // it. Fence the callback before it can replace a newer generation's
        // durable session identity.
        renewLease();
        binding = this.store.updateSessionBinding(binding.threadId, binding.agentId, {
          ...prepared,
          ...(contextReset ? { contextThroughSeq: 0 } : {}),
          generation: liveLease.generation,
        });
      }
      const cursor = contextReset ? 0 : binding.contextThroughSeq ?? this.store.getCursor(binding.threadId, binding.agentId)?.lastVisibleSeq ?? binding.lastVisibleSeq;
      const source = this.store.getMessage(liveLease.invocation.sourceMessageId);
      if (!source) throw new TeamRuntimeError("not_found", `Source message not found: ${liveLease.invocation.sourceMessageId}`);
      // An invocation must observe a stable prefix ending at its source
      // message. Without this upper bound, a concurrent later request can be
      // injected into an earlier invocation and make prompt/recovery order
      // nondeterministic.
      const delta = this.store.listMessages(binding.threadId, binding.agentId, { afterSeq: cursor })
        .filter((message) => message.seq <= source.seq);
      const injectedThroughSeq = delta.at(-1)?.seq ?? cursor;
      const modelDelta = contextReset ? delta : delta.filter((message) => !(message.authorType === "agent" && message.authorId === agent.id));
      const thread = this.store.getThread(binding.threadId)!;
      const members = this.store.listMembers(thread.teamId);
      const memories = [
        ...this.memory.recall({ scope: "team", teamId: thread.teamId, limit: 50 }, agent.id),
        ...this.memory.recall({ scope: "thread", threadId: thread.id, limit: 50 }, agent.id),
        ...this.memory.recall({
          scope: "agent_private",
          teamId: thread.teamId,
          ownerAgentId: agent.id,
          limit: 50,
        }, agent.id),
      ];
      const memoryContext = formatMemory(memories);
      const rosterContext = members
        .filter((member) => member.enabled)
        .map((member) => {
          const role = member.role ? ` role=${member.role}` : "";
          return `- ${member.name} [agent=${member.agentId}]${role} model=${member.provider}/${member.model}`;
        })
        .join("\n");
      const invokedMember = members.find((member) => member.agentId === agent.id);
      const prompt = [
        buildCompiledMemberPrompt(agent, invokedMember, members, (id) => this.store.getAgent(id)),
        "",
        "## 运行时队友索引",
        rosterContext,
        "",
        "## 共享对话增量",
        "以下是你可见的 canonical shared-thread delta。回应最后一条被路由给你的请求。",
        "不要发出机械 @mention，除非你明确要请求另一个 Team invocation。",
        `本次唯一工作来源：message=${source.id}, seq=${source.seq}, sender=${source.authorId}。即使历史已读过，也要核对这项请求，不要自行扫描内部数据库推测任务。`,
        ...(source.protocol?.mode === "parallel" ? ["本轮是并行独立意见收集：只提交自己的贡献或明确的无需行动处置；所有接力目标均被抑制，不要再唤醒其他成员。"] : []),
        ...(memoryContext ? [
          "",
          "## 授权持久记忆",
          "如果记忆和 canonical Thread 冲突，以 Thread 为准。",
          memoryContext,
        ] : []),
        "",
        formatDelta(modelDelta),
        ...(!modelDelta.some(message => message.id === source.id) ? ["", "## 本次待处理请求（已读水位不是完成凭据）", formatDelta([source])] : []),
      ].join("\n");

      binding = this.store.updateSessionBinding(binding.threadId, binding.agentId, { contextInitialized: false });
      const output = await this.runtime.invoke({ agent, binding, prompt, signal: abortController.signal,
        onProcess: capture => this.store.saveInvocationProcess(liveLease, capture),
      });
      if (leaseError) throw leaseError;
      renewLease();
      const parsed = parseTurnOutput(output.content, output.control);
      let wakeTargets: string[] = [];
      let targetSelectors: Record<string, string[]> = {};
      let routing: InvocationOutcome["routing"] = parsed.control ? "explicit" : "text";
      let routingReason: string | undefined;
      if (source.protocol?.mode === "parallel") {
        routing = "parallel_suppressed";
      } else if (parsed.control) {
        if (parsed.control.disposition !== "completed" || !parsed.control.targets?.length) routing = "terminal";
        const requested = parsed.control.targets ?? [];
        if (requested.length > 2 || requested.some(id => !members.some(member => member.agentId === id && member.enabled) ||
          (source.visibility !== "team" && !source.visibleTo.includes(id)))) {
          throw new TeamProtocolError("Explicit Team handoff targets are outside the authorized scope or exceed 2 targets");
        }
        wakeTargets = requested.filter(id => id !== agent.id);
        targetSelectors = Object.fromEntries(wakeTargets.map(id => [id, ["explicit"]]));
      } else {
        try {
          const mentions = resolveAgentMentions(members, parsed.content, agent.id);
          wakeTargets = mentions.targets.filter(target => source.visibility === "team" || source.visibleTo.includes(target));
          targetSelectors = selectorsByTarget(members, wakeTargets, mentions.selectors);
        } catch (error) {
          // Invalid text syntax remains visible, but cannot create a partial or guessed route.
          routingReason = error instanceof Error ? error.message : String(error);
        }
      }
      const outcome: InvocationOutcome = {
        version: 1, disposition: parsed.control?.disposition ?? "completed", basedOnSeq: injectedThroughSeq,
        routing, targets: wakeTargets, reason: parsed.control?.reason ?? routingReason,
      };
      const committed = this.store.commitInvocationOutcome({
        lease: liveLease,
        deliveryToken,
        injectedThroughSeq,
        outcome,
        process: output.process,
        session: {
          piSessionId: output.piSessionId,
          sessionFile: output.sessionFile,
          provider: output.provider,
          model: output.model,
          thinking: output.thinking,
          runtimeConfigKey: binding.runtimeConfigKey,
          modelRef: binding.modelRef,
          contextInitialized: true,
          contextThroughSeq: injectedThroughSeq,
        },
        final: outcome.disposition === "no_action" ? undefined : {
          threadId: liveLease.invocation.threadId,
          authorType: "agent",
          authorId: agent.id,
          content: parsed.content,
          visibility: source.visibility,
          visibleTo: source.visibleTo,
          wakeTargets,
          targetSelectors,
          replyTo: source.id,
          parentInvocationId: liveLease.invocation.id,
          idempotencyKey: `invocation-final:${liveLease.invocation.id}`,
          protocol: { version: 1, mode: wakeTargets.length > 1 ? "parallel" : "handoff", disposition: outcome.disposition },
        },
      });
      const childInvocations = committed.final ? this.enqueueMessageTargets(committed.final) : [];
      return { invocation: committed.invocation, final: committed.final, childInvocations };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.scheduler.getInvocation(invocationId);
      let terminal = current?.status === "dead_letter" || current?.status === "cancelled";
      if (current?.status === "running") {
        try {
          const failed = this.scheduler.fail(liveLease, message, { retry: !(error instanceof TeamProtocolError) });
          terminal = failed.status === "dead_letter" || failed.status === "failed";
        } catch { /* lease may be stale */ }
      }
      if (deliveryToken) {
        try {
          this.store.failDelivery(
            delivery.messageId,
            delivery.agentId,
            message,
            nowIso(),
            terminal,
            deliveryToken,
          );
        } catch { /* lease may be stale or already recovered by another worker */ }
      }
      return { invocation: this.scheduler.getInvocation(invocationId) ?? latest, error: message };
    } finally {
      clearInterval(heartbeat);
      if (this.invocationControllers.get(invocationId) === abortController) {
        this.invocationControllers.delete(invocationId);
      }
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async runPending(threadId: string, signal?: AbortSignal): Promise<RunResult[]> {
    this.scheduler.reclaimExpired();
    this.store.reclaimExpiredDeliveries();
    this.reconcileInvocations(threadId);
    const pending = this.store.listInvocations({ threadId, status: "queued" });
    return this.runInvocations(pending, signal);
  }

  /**
   * Repair the small crash window between TeamStore.appendMessage (which
   * durably creates deliveries) and scheduler.enqueue. The message's target
   * snapshot is the source of truth, so this operation is deterministic and
   * idempotent after a host restart.
   */
  private reconcileInvocations(threadId: string): void {
    const existing = new Map(
      this.scheduler.listInvocations({ threadId }).map((invocation) => [invocation.idempotencyKey, invocation]),
    );
    for (const message of this.store.listMessages(threadId)) {
      for (const agentId of message.wakeTargets) {
        const delivery = this.store.getDelivery(message.id, agentId);
        if (!delivery || !["queued", "failed"].includes(delivery.status)) continue;
        const idempotencyKey = `message:${message.id}:agent:${agentId}`;
        const invocation = existing.get(idempotencyKey);
        if (invocation) {
          // An Invocation that exhausted recovery must not leave its Delivery
          // retryable forever. Otherwise no worker can claim the route and the
          // busy-aware Thread seal remains blocked permanently.
          if (["dead_letter", "failed", "cancelled"].includes(invocation.status)) {
            try {
              this.store.failDelivery(
                message.id,
                agentId,
                invocation.lastError ?? `Invocation ${invocation.id} is ${invocation.status}`,
                undefined,
                true,
              );
            } catch {
              // A concurrent recovery worker may already have finalized it.
            }
          }
          continue;
        }
        try {
          const invocation = this.scheduler.enqueue({
            threadId,
            sourceMessageId: message.id,
            targetAgentId: agentId,
            parentInvocationId: message.parentInvocationId,
            idempotencyKey,
          });
          existing.set(idempotencyKey, invocation);
        } catch (error) {
          // Reconciliation must be convergent. A permanently rejected route
          // is dead-lettered with a stable diagnostic instead of being thrown
          // on every host restart.
          const reason = error instanceof Error ? error.message : String(error);
          this.deadLetterRoute(message, agentId, reason);
        }
      }
    }
  }

  private enqueueMessageTargets(message: CanonicalMessage): Invocation[] {
    const invocations: Invocation[] = [];
    for (const agentId of message.wakeTargets) {
      const delivery = this.store.getDelivery(message.id, agentId);
      if (!delivery || !["queued", "failed"].includes(delivery.status)) continue;
      try {
        invocations.push(this.scheduler.enqueue({
          threadId: message.threadId,
          sourceMessageId: message.id,
          targetAgentId: agentId,
          parentInvocationId: message.parentInvocationId,
          idempotencyKey: `message:${message.id}:agent:${agentId}`,
        }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deadLetterRoute(message, agentId, reason);
      }
    }
    return invocations;
  }

  private deadLetterRoute(message: CanonicalMessage, agentId: string, reason: string): void {
    try {
      this.store.failDelivery(message.id, agentId, reason, undefined, true);
    } catch {
      // Another recovery worker may already have finalized this delivery.
    }
    try {
      this.store.appendMessage({
        threadId: message.threadId,
        authorType: "system",
        authorId: "team-runtime",
        content: `Automatic route from message ${message.id} to ${agentId} was blocked: ${reason}`,
        visibility: "team",
        idempotencyKey: `route-rejected:${message.id}:${agentId}`,
      });
    } catch {
      // The dead-letter remains authoritative if the Thread was sealed or a
      // concurrent worker already wrote the same diagnostic.
    }
  }

  private ensureBinding(threadId: string, agent: PersistentAgent, generation: number): SessionBinding {
    const existing = this.store.getSessionBinding(threadId, agent.id);
    if (existing) {
      if (existing.status !== "active") throw new TeamRuntimeError("conflict", `Session is ${existing.status}`);
      return this.store.updateSessionBinding(threadId, agent.id, { generation: Math.max(existing.generation, generation) });
    }
    const now = nowIso();
    return this.store.createSessionBinding({
      threadId,
      agentId: agent.id,
      piSessionId: randomUUID(),
      cwd: this.options.cwd,
      provider: agent.provider,
      model: agent.model,
      thinking: agent.thinking,
      status: "active",
      generation,
      lastVisibleSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  private findFinal(invocation: Invocation): CanonicalMessage | undefined {
    const key = `invocation-final:${invocation.id}`;
    return this.store.listMessages(invocation.threadId).find((message) => message.idempotencyKey === key);
  }
}

function normalizeMentionValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function assertMentionNamespace(
  members: ReturnType<TeamStore["listMembers"]>,
  updatingAgentId: string | undefined,
  name: string,
  aliases: string[],
): void {
  const ownEntries = [name, ...aliases];
  const ownKeys = new Map<string, string>();
  for (const entry of ownEntries) {
    const key = normalizeMentionValue(entry);
    const previous = ownKeys.get(key);
    if (previous !== undefined) {
      throw new TeamRuntimeError("conflict", `Mention name/alias ${JSON.stringify(entry)} is duplicated`, {
        name,
        aliases,
        duplicate: entry,
      });
    }
    ownKeys.set(key, entry);
  }

  for (const member of members) {
    if (updatingAgentId !== undefined && member.agentId === updatingAgentId) continue;
    const entries = [member.name, ...member.aliases];
    for (const entry of entries) {
      const key = normalizeMentionValue(entry);
      const requested = ownKeys.get(key);
      if (requested !== undefined) {
        throw new TeamRuntimeError("conflict", `Mention name/alias ${JSON.stringify(requested)} conflicts with Team member ${member.agentId}`, {
          memberAgentId: member.agentId,
          memberName: member.name,
          memberAliases: member.aliases,
          conflict: requested,
        });
      }
    }
  }
}
