import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS,
  CODEX_CLI_THINKING_LEVEL_OPTIONS,
  GROK_CLI_THINKING_LEVEL_OPTIONS,
  GROK_PI_THINKING_LEVEL_OPTIONS,
  KIMI_CLI_THINKING_LEVEL_OPTIONS,
  TEAM_RUNTIME_CLIENT_LABELS,
  TEAM_RUNTIME_THINKING_LEVEL_OPTIONS,
  buildRuntimeCapabilities,
  createPiModelOption,
  discoverRuntimeCliModelOptions,
  RuntimeCapabilityDiscovery,
  normalizeRuntimeClientId,
  runtimeModelKey,
  type RuntimeClientId,
  type RuntimeCliModelOptions,
  type RuntimeModelLike,
  type TeamRuntimeClientCapability,
  type TeamRuntimeModelOption,
} from "./capabilities.ts";
import { TeamCoordinator } from "./coordinator.ts";
import { projectCollections, type TeamCollection } from "./protocol.ts";
import {
  formatRuntimeDoctor,
  inspectRuntimeConnectors,
  type TeamRuntimeDoctorRecord,
} from "./doctor.ts";
import type { MemoryScope, MemoryVisibility } from "./memory.ts";
import {
  PiWebChatBridge,
  renderPiWebChatHtml,
  type PiWebChatModelOption,
} from "./pi-web-chat.ts";
import { piWebSessionIdFromMarker } from "./providers/adapters.ts";
import { PiAgentRuntime, type AgentRuntime } from "./runtime.ts";
import { TeamStore, type HostContext } from "./store.ts";
import { recoverTurnProcess, type TurnProcess } from "./process-history.ts";
import { createAgentMemoryTool } from "./tools.ts";
import {
  TEAM_WEB_SHARE_DEFAULT_LOGIN_TTL_MS,
  TEAM_WEB_SHARE_DEFAULT_SESSION_TTL_HOURS,
  buildTeamWebShareTunnelCommand,
  buildTeamWebShareLoginUrl,
  describeTeamWebShareDoctor,
  inspectTeamWebShareProvider,
  resolveTeamWebShareConfig,
  type TeamWebShareProviderConfig,
} from "./share.ts";
import {
  TeamRuntimeError,
  type AgentRoleProfile,
  type CanonicalMessage,
  type Delivery,
  type Invocation,
  type PersistentAgent,
  type SessionBinding,
  type Team,
  type TeamMember,
  type ThreadFolder,
  type TeamThread,
} from "./types.ts";
import { WebSocketServer } from "ws";

export type { TeamRuntimeClientCapability, TeamRuntimeModelOption } from "./capabilities.ts";

const require = createRequire(import.meta.url);
const QrCodeSvg = require("qrcode-svg") as new (options: {
  content: string;
  padding?: number;
  width?: number;
  height?: number;
  color?: string;
  background?: string;
  ecl?: "L" | "M" | "Q" | "H";
}) => { svg(): string };

const TEAM_WEB_SHARE_SESSION_COOKIE = "pi_team_web_share";
const TEAM_WEB_SHARE_PIN_DIGITS = 6;

export interface TeamRuntimeActionParams {
  name?: string;
  agentId?: string;
  teamId?: string;
  threadId?: string;
  threadIds?: string[];
  invocationId?: string;
  reason?: string;
  folderId?: string;
  folderIds?: string[];
  clientId?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  role?: string;
  roleDescription?: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string;
  roleProfile?: AgentRoleProfile;
  rolePrompt?: string;
  skills?: string[];
  skillRefs?: string[];
  aliases?: string[];
  runtimePolicy?: "always_on" | "idle_timeout" | "on_demand";
  makeDefault?: boolean;
  title?: string;
  message?: string;
  replyTo?: string;
  memoryId?: string;
  sourceMessageId?: string;
  scope?: MemoryScope;
  visibility?: MemoryVisibility;
  visibleTo?: string[];
  metadata?: Record<string, unknown>;
  limit?: number;
  idempotencyKey?: string;
  port?: number;
  open?: boolean;
  memberLimit?: number;
  share?: boolean;
  shareTtlHours?: number;
  shareProvider?: string;
  shareUrl?: string;
  shareCommand?: string;
  shareConfigPath?: string;
  shareAutoStart?: boolean;
  probe?: boolean;
  turns?: number;
}

export interface TeamWebShareTunnelStartInput {
  config: TeamWebShareProviderConfig;
  cwd: string;
  localPort: number;
}

export interface TeamWebShareTunnelHandle {
  pid?: number;
  command: string;
  stop: () => void | Promise<void>;
}

export interface TeamWebShareHealth {
  status: "ok" | "failed" | "not_checked";
  publicRootStatus?: number;
  loginStatus?: number;
  message: string;
}

export interface TeamRuntimeManagerOptions {
  runtimeFactory?: (input: { cwd: string; sessionDir: string; agentDir: string }) => AgentRuntime;
  databasePath?: (cwd: string) => string;
  sessionDir?: (cwd: string) => string;
  leaseMs?: number;
  /** Stable user/principal identity. It must not be derived from a PI host session. */
  principalId?: (ctx: ExtensionContext) => string;
  cliModelOptions?: RuntimeCliModelOptions;
  locateRuntimeCommand?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
  now?: () => number;
  shareTunnelRunner?: (input: TeamWebShareTunnelStartInput) => Promise<TeamWebShareTunnelHandle> | TeamWebShareTunnelHandle;
  shareHealthChecker?: (input: { share: ActiveTeamWebShare; localPort: number }) => Promise<TeamWebShareHealth> | TeamWebShareHealth;
  piWebBaseUrl?: string;
  usePiWebForTeamAgents?: boolean;
  piWebPollMs?: number;
  piWebIdleTimeoutMs?: number;
}

export interface TeamRuntimeOverlaySnapshot {
  principal?: string;
  active?: HostContext;
  team?: Team;
  thread?: TeamThread;
  teams: Team[];
  folders: ThreadFolder[];
  threads: TeamThread[];
  archivedThreads: TeamThread[];
  agents: PersistentAgent[];
  members: TeamMember[];
  messages: CanonicalMessage[];
  processAvailable?: string[];
  collections?: TeamCollection[];
  activeProcesses?: Array<{ invocationId: string; agentId: string; generation: number; data: TurnProcess }>;
  deliveries: Delivery[];
  invocations: Invocation[];
  runtimeSessions: TeamRuntimeAgentSessionProjection[];
  runtimeStatus: TeamRuntimeStatusProjection;
  queuedInvocations: Invocation[];
  runningInvocations: Invocation[];
  failedInvocations: Invocation[];
  unavailableReason?: string;
  modelOptions?: TeamRuntimeModelOption[];
  thinkingLevels?: string[];
  runtimeCapabilities?: TeamRuntimeClientCapability[];
}

interface TeamWebSession {
  token: string;
  context?: HostContext;
  chatSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

interface TeamWebShareSession {
  token: string;
  context?: HostContext;
  chatSessionId?: string;
  createdAt: number;
  expiresAt: number;
}

interface ActiveTeamWebShare {
  config: TeamWebShareProviderConfig;
  loginToken?: string;
  loginTokenCreatedAt: number;
  loginTokenExpiresAt: number;
  pin: string;
  sessionTtlMs: number;
  sessionTtlHours: number;
  localToken: string;
  context?: HostContext;
  qrSvg: string;
  loginUrl: string;
  sessions: Map<string, TeamWebShareSession>;
  tunnel?: TeamWebShareTunnelStatus;
  health?: TeamWebShareHealth;
}

interface TeamWebShareStartInfo {
  enabled: boolean;
  provider: TeamWebShareProviderConfig["provider"];
  publicUrl: string;
  loginUrl: string;
  pin: string;
  loginTokenExpiresAt: string;
  sessionTtlHours: number;
  qrSvg: string;
  qrUrl: string;
  tunnelStarted: boolean;
  tunnelCommand?: string;
  tunnelPid?: number;
  tunnelMessage?: string;
  localTarget: string;
  doctor: string;
  activeSessions: number;
  configSource: TeamWebShareProviderConfig["configSource"];
  health: TeamWebShareHealth;
  warning?: string;
}

interface TeamWebShareTunnelStatus {
  started: boolean;
  command?: string;
  pid?: number;
  message: string;
}

interface ActiveTeamWebShareTunnel {
  provider: TeamWebShareProviderConfig["provider"];
  command: string;
  pid?: number;
  stop: () => void | Promise<void>;
}

type TeamWebAuth =
  | { kind: "local"; session: TeamWebSession }
  | { kind: "share"; session: TeamWebShareSession };

interface ActiveContextSlot {
  context?: HostContext;
}

interface ModelScopeEntry {
  model: RuntimeModelLike;
  thinking?: string;
}

export type TeamRuntimeWorkStatus =
  | "queued"
  | "awakened"
  | "running"
  | "handled"
  | "terminal_silent"
  | "awaiting_user"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type TeamRuntimeWorkTone = "queued" | "active" | "done" | "silent" | "failed" | "waiting";

export interface TeamRuntimeMessageSummary {
  id: string;
  seq: number;
  authorType: CanonicalMessage["authorType"];
  authorId: string;
  preview: string;
  createdAt: string;
}

export interface TeamRuntimeWaitInfo {
  kind: "active_turn" | "target_dispatch";
  label: string;
  blockingInvocationId?: string;
}

export interface TeamRuntimeWorkItem {
  id: string;
  invocationId?: string;
  deliveryMessageId?: string;
  targetAgentId: string;
  sourceMessageId: string;
  status: TeamRuntimeWorkStatus;
  statusLabel: string;
  tone: TeamRuntimeWorkTone;
  deliveryStatus?: Delivery["status"];
  invocationStatus?: Invocation["status"];
  attempts: number;
  depth?: number;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  lastError?: string;
  source?: TeamRuntimeMessageSummary;
  final?: TeamRuntimeMessageSummary;
  wait?: TeamRuntimeWaitInfo;
  lineageInvocationIds: string[];
}

export interface TeamRuntimeStatusProjection {
  generatedAt: string;
  active: TeamRuntimeWorkItem[];
  queued: TeamRuntimeWorkItem[];
  recent: TeamRuntimeWorkItem[];
  waiting?: TeamRuntimeWorkItem[];
  counts: {
    queued: number;
    active: number;
    handled: number;
    terminalSilent: number;
    failed: number;
  };
}

export interface TeamRuntimeAgentSessionProjection {
  threadId: string;
  agentId: string;
  clientId: string;
  sessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  thinking?: string;
  piWeb: boolean;
  eventStreamId?: string;
}

function runtimeKey(messageId: string, agentId: string): string {
  return `${messageId}\u0000${agentId}`;
}

function compactRuntimeText(value: string | undefined, limit = 96): string {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw.length > limit ? `${raw.slice(0, Math.max(1, limit - 3))}...` : raw;
}

function shouldAutoTitleThread(title: string | undefined): boolean {
  const value = String(title ?? "").trim();
  return !value || value === "新对话" || /^对话\s+\d+$/.test(value);
}

function titleFromMessage(content: string): string {
  const cleaned = content
    .replace(/@"(?:\\.|[^"\\])*"/g, " ")
    .replace(/@[^\s，。！？,.!?；;：:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = cleaned.split(/[。！？!?；;\n\r]/).find(Boolean)?.trim() ?? cleaned;
  const title = firstSentence || cleaned || "新对话";
  return title.length > 28 ? `${title.slice(0, 28)}...` : title;
}

function summarizeRuntimeMessage(message: CanonicalMessage | undefined): TeamRuntimeMessageSummary | undefined {
  if (!message) return undefined;
  return {
    id: message.id,
    seq: message.seq,
    authorType: message.authorType,
    authorId: message.authorId,
    preview: compactRuntimeText(message.content, 72),
    createdAt: message.createdAt,
  };
}

function latestFinalForInvocation(
  messages: readonly CanonicalMessage[],
  invocationId: string | undefined,
): CanonicalMessage | undefined {
  if (!invocationId) return undefined;
  return messages
    .filter((message) => message.authorType === "agent" && message.parentInvocationId === invocationId)
    .sort((left, right) => left.seq - right.seq)
    .at(-1);
}

function runtimeTime(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function runtimeLineageIds(
  invocation: Invocation | undefined,
  invocationById: ReadonlyMap<string, Invocation>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor = invocation;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    ids.unshift(cursor.id);
    cursor = cursor.parentInvocationId ? invocationById.get(cursor.parentInvocationId) : undefined;
  }
  return ids;
}

function classifyRuntimeWork(
  delivery: Delivery | undefined,
  invocation: Invocation | undefined,
  final: CanonicalMessage | undefined,
): { status: TeamRuntimeWorkStatus; statusLabel: string; tone: TeamRuntimeWorkTone } {
  const deliveryStatus = delivery?.status;
  const invocationStatus = invocation?.status;
  if (invocationStatus === "completed" && invocation?.outcome?.disposition === "awaiting_user" && !invocation.outcome.resolvedByMessageId) {
    return { status: "awaiting_user", statusLabel: "等待用户决定", tone: "waiting" };
  }
  if (final) return { status: "handled", statusLabel: `已由回复明确处理 #${final.seq}`, tone: "done" };
  if (invocationStatus === "running") return { status: "running", statusLabel: "当前轮处理中", tone: "active" };
  if (deliveryStatus === "leased") return { status: "awakened", statusLabel: "已唤醒", tone: "active" };
  if (invocationStatus === "queued") {
    return {
      status: "queued",
      statusLabel: deliveryStatus === "failed" ? "上次失败，等待重试" : "排队中",
      tone: "queued",
    };
  }
  if (deliveryStatus === "queued") return { status: "queued", statusLabel: "未读 · 排队中", tone: "queued" };
  if (invocationStatus === "completed" || deliveryStatus === "acked") {
    return { status: "terminal_silent", statusLabel: "已完成 · 无需新回复", tone: "silent" };
  }
  if (invocationStatus === "cancelled") return { status: "cancelled", statusLabel: "已终止", tone: "failed" };
  if (invocationStatus === "dead_letter" || deliveryStatus === "dead_letter") {
    return { status: "dead_letter", statusLabel: "已失败终止", tone: "failed" };
  }
  if (invocationStatus === "failed" || deliveryStatus === "failed") {
    return { status: "failed", statusLabel: "失败 · 已停止", tone: "failed" };
  }
  return { status: "queued", statusLabel: "待路由", tone: "queued" };
}

function buildRuntimeWorkItem(input: {
  delivery?: Delivery;
  invocation?: Invocation;
  final?: CanonicalMessage;
  source?: CanonicalMessage;
  invocationById: ReadonlyMap<string, Invocation>;
}): TeamRuntimeWorkItem {
  const { delivery, invocation, final, source, invocationById } = input;
  const targetAgentId = invocation?.targetAgentId ?? delivery?.agentId ?? "";
  const sourceMessageId = invocation?.sourceMessageId ?? delivery?.messageId ?? "";
  const state = classifyRuntimeWork(delivery, invocation, final);
  return {
    id: invocation ? `invocation:${invocation.id}` : `delivery:${sourceMessageId}:${targetAgentId}`,
    invocationId: invocation?.id,
    deliveryMessageId: delivery?.messageId,
    targetAgentId,
    sourceMessageId,
    status: state.status,
    statusLabel: state.statusLabel,
    tone: state.tone,
    deliveryStatus: delivery?.status,
    invocationStatus: invocation?.status,
    attempts: invocation?.attempts ?? delivery?.attempts ?? 0,
    depth: invocation?.depth,
    createdAt: invocation?.createdAt,
    updatedAt: final?.createdAt ?? invocation?.updatedAt ?? delivery?.ackedAt ?? delivery?.nextAttemptAt,
    startedAt: invocation?.status === "running" ? invocation.updatedAt : delivery?.status === "leased" ? invocation?.updatedAt : undefined,
    lastError: invocation?.lastError ?? delivery?.lastError,
    source: summarizeRuntimeMessage(source),
    final: summarizeRuntimeMessage(final),
    lineageInvocationIds: runtimeLineageIds(invocation, invocationById),
  };
}

export function buildRuntimeStatusProjection(input: {
  members: readonly TeamMember[];
  messages: readonly CanonicalMessage[];
  deliveries: readonly Delivery[];
  invocations: readonly Invocation[];
  now?: Date | string | number;
}): TeamRuntimeStatusProjection {
  const generatedAt = (input.now instanceof Date ? input.now : new Date(input.now ?? Date.now())).toISOString();
  const messageById = new Map(input.messages.map((message) => [message.id, message]));
  const deliveryByRoute = new Map(input.deliveries.map((delivery) => [runtimeKey(delivery.messageId, delivery.agentId), delivery]));
  const invocationById = new Map(input.invocations.map((invocation) => [invocation.id, invocation]));
  const memberNameById = new Map(input.members.map((member) => [member.agentId, member.name]));
  const items: TeamRuntimeWorkItem[] = [];
  const coveredRoutes = new Set<string>();

  for (const invocation of input.invocations) {
    const route = runtimeKey(invocation.sourceMessageId, invocation.targetAgentId);
    coveredRoutes.add(route);
    const delivery = deliveryByRoute.get(route);
    items.push(buildRuntimeWorkItem({
      delivery,
      invocation,
      final: latestFinalForInvocation(input.messages, invocation.id),
      source: messageById.get(invocation.sourceMessageId),
      invocationById,
    }));
  }

  for (const delivery of input.deliveries) {
    const route = runtimeKey(delivery.messageId, delivery.agentId);
    if (coveredRoutes.has(route)) continue;
    items.push(buildRuntimeWorkItem({
      delivery,
      source: messageById.get(delivery.messageId),
      invocationById,
    }));
  }

  const active = items
    .filter((item) => item.tone === "active")
    .sort((left, right) => runtimeTime(left.startedAt ?? left.updatedAt ?? left.createdAt) - runtimeTime(right.startedAt ?? right.updatedAt ?? right.createdAt));
  const activeByAgent = new Map(active.map((item) => [item.targetAgentId, item]));
  const queued = items
    .filter((item) => item.tone === "queued" || (item.deliveryStatus === "failed" && item.invocationStatus !== "failed"))
    .map((item) => {
      const blocker = activeByAgent.get(item.targetAgentId);
      const targetName = memberNameById.get(item.targetAgentId) ?? item.targetAgentId;
      return {
        ...item,
        wait: blocker
          ? {
              kind: "active_turn" as const,
              label: `等待 @${targetName} 当前轮`,
              blockingInvocationId: blocker.invocationId,
            }
          : {
              kind: "target_dispatch" as const,
              label: `等待 @${targetName} 调度`,
            },
      };
    })
    .sort((left, right) => (left.source?.seq ?? Number.MAX_SAFE_INTEGER) - (right.source?.seq ?? Number.MAX_SAFE_INTEGER));
  const recent = items
    .filter((item) => item.tone !== "active" && !queued.some((queuedItem) => queuedItem.id === item.id))
    .sort((left, right) => runtimeTime(right.updatedAt ?? right.createdAt) - runtimeTime(left.updatedAt ?? left.createdAt))
    .slice(0, 6);

  return {
    generatedAt,
    active,
    queued,
    recent,
    waiting: items.filter(item => item.status === "awaiting_user"),
    counts: {
      queued: queued.length,
      active: active.length,
      handled: items.filter((item) => item.status === "handled").length,
      terminalSilent: items.filter((item) => item.status === "terminal_silent").length,
      failed: items.filter((item) => item.tone === "failed").length,
    },
  };
}

const DEFAULT_WEB_TEAM_ID = "default-model-team";
const DEFAULT_WEB_THREAD_ID = "default-model-thread";
const DEFAULT_WEB_TEAM_NAME = "Default Model Team";
const DEFAULT_WEB_MEMBER_LIMIT = 4;
const THINKING_LEVELS = new Set<string>(TEAM_RUNTIME_THINKING_LEVEL_OPTIONS.filter(Boolean));
const LEGACY_DEFAULT_ROLE_MARKERS = [
  ["你是咪咪，团队里的", "长文理解、中文整理、资料归纳"],
  ["你是跳跳，团队里的", "快速侦察、灵感发散、复现报错"],
  ["你是鲸鲸，团队里的", "深潜推理、复杂问题拆解、代码审查"],
  ["你是汪汪，团队里的", "步骤、实现方案、验证清单"],
] as const;
const LEGACY_DEFAULT_PROFILE_MARKERS = [
  ["Kimi CLI 本地成员", "软乎、耐心"],
  ["Grok CLI 本地成员", "快速侦察"],
  ["Grok Build CLI 本地账号成员", "快速侦察"],
  ["DeepSeek via Pi Agent direct provider", "慢慢下潜"],
  ["GPT via Pi Agent direct provider", "笨笨但很能收尾"],
] as const;

interface DefaultWebMemberProfile {
  slotId: string;
  name: string;
  role: string;
  aliases: string[];
  clientId: string;
  preferredModels: string[];
  providerHints: string[];
  modelHints: string[];
  roleProfile: Required<AgentRoleProfile>;
}

const DEFAULT_WEB_MEMBER_PROFILES = [
  {
    slotId: "default-mimi",
    name: "咪咪",
    role: "归纳",
    aliases: ["mimi", "mi", "kimi", "moonshot"],
    clientId: "kimi-code",
    preferredModels: ["kimi-code/kimi-for-coding", "kimi-code/k3-256k"],
    providerHints: ["kimi-code", "kimi"],
    modelHints: ["kimi", "k3"],
    roleProfile: {
      roleDescription: "Kimi Code CLI 接入，偏长文理解、中文整理、资料归纳和代码阅读。",
      personality: "耐心、细致，会先把需求和上下文捋顺，再给出清楚、可复用的整理结果。",
      teamStrengths: "长文理解、中文整理、资料归纳、代码阅读",
      caution: "偏信息整理和阅读；重实现可交给汪汪落地。",
    },
  },
  {
    slotId: "default-tiaotiao",
    name: "跳跳",
    role: "探路",
    aliases: ["tiaotiao", "grok", "xai"],
    clientId: "grok-build",
    preferredModels: ["grok-build/grok-4.6"],
    providerHints: ["grok-build", "grok"],
    modelHints: ["grok"],
    roleProfile: {
      roleDescription: "Grok Build CLI 本地账号接入，偏快速验证、灵感发散、复现报错和找线索。",
      personality: "轻快、好奇、反应快，会先扫出可疑点、风险和多个可能方向。",
      teamStrengths: "快速侦察、灵感发散、复现报错、找线索",
      caution: "适合先照亮可能路径；复杂结论建议交给鲸鲸复核。",
    },
  },
  {
    slotId: "default-codex",
    name: "码码",
    role: "实现",
    aliases: ["codex", "codex-cli", "ma"],
    clientId: "codex-cli",
    preferredModels: ["codex-cli/default", "codex-cli/gpt-5.6-sol", "codex-cli/gpt-5.6-terra", "codex-cli/gpt-5.6-luna"],
    providerHints: ["codex-cli", "codex"],
    modelHints: ["gpt", "codex"],
    roleProfile: {
      roleDescription: "Codex CLI 本地账号接入，偏代码修改、工程验证、测试修复和仓库级执行。",
      personality: "清楚、稳健，喜欢先对齐边界，再把改动做成可验证的结果。",
      teamStrengths: "代码修改、工程验证、测试修复、仓库级执行",
      caution: "会读写同一工作区；工具权限不是操作系统级沙箱，敏感项目请谨慎授权。",
    },
  },
  {
    slotId: "default-jingjing",
    name: "鲸鲸",
    role: "深潜",
    aliases: ["jingjing", "whale", "deepseek", "ds"],
    clientId: "pi",
    preferredModels: ["deepseek/deepseek-v4-flash"],
    providerHints: ["deepseek"],
    modelHints: ["deepseek"],
    roleProfile: {
      roleDescription: "DeepSeek via PI Agent，偏深潜推理、复杂问题拆解、代码审查和风险判断。",
      personality: "安静、稳、重证据，适合把复杂问题下潜到结构、逻辑和前提层。",
      teamStrengths: "深潜推理、复杂问题拆解、代码审查、风险判断",
      caution: "不抢快；适合需要下潜、复核和把关的判断。",
    },
  },
  {
    slotId: "default-wangwang",
    name: "汪汪",
    role: "落地",
    aliases: ["wangwang", "gpt", "gpt-pi"],
    clientId: "pi",
    preferredModels: ["codex-chatgptclub/gpt-5.6-luna", "openai/gpt-5.6-luna"],
    providerHints: ["codex-chatgptclub", "openai"],
    modelHints: ["gpt", "luna"],
    roleProfile: {
      roleDescription: "GPT via PI Agent，偏工程落地、实现、集成、测试修复和收尾。",
      personality: "可靠、执行感强，拿到清楚方向后，会把方案拆成步骤、改动和验证清单。",
      teamStrengths: "工程落地、实现、集成、测试修复、收尾",
      caution: "适合动手落地；重大架构和风险判断先让鲸鲸把关。",
    },
  },
] as const satisfies readonly DefaultWebMemberProfile[];

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => typeof item === "string" ? item.trim() : "");
  return items.every(Boolean) ? items : undefined;
}

function isLegacyDefaultRolePrompt(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  return LEGACY_DEFAULT_ROLE_MARKERS.some(([prefix, marker]) => text.startsWith(prefix) && text.includes(marker));
}

function isLegacyDefaultRoleProfile(profile: AgentRoleProfile | undefined): boolean {
  if (!profile) return false;
  const text = [
    profile.roleDescription,
    profile.personality,
    profile.teamStrengths,
    profile.caution,
  ].filter(Boolean).join("\n");
  return LEGACY_DEFAULT_PROFILE_MARKERS.some(([primary, marker]) => text.includes(primary) && text.includes(marker));
}

function defaultRoleLabel(existing: string | undefined, fallback: string): string {
  const value = existing?.trim();
  if (!value) return fallback;
  const legacyPrefixes: Record<string, string> = {
    "归纳": "整理",
    "探路": "侦察",
    "深潜": "深潜",
    "落地": "执行",
  };
  const legacyPrefix = legacyPrefixes[fallback];
  return legacyPrefix && value.startsWith(legacyPrefix) && value.length <= legacyPrefix.length + 1
    ? fallback
    : value;
}

function defaultWebProfileSlotForAgentId(agentId: string): string | undefined {
  const normalized = agentId.toLocaleLowerCase();
  return DEFAULT_WEB_MEMBER_PROFILES.find((profile) => {
    const slot = profile.slotId.toLocaleLowerCase();
    if (normalized === slot) return true;
    if (!normalized.startsWith(`${slot}-`)) return false;
    return /^\d+$/.test(normalized.slice(slot.length + 1));
  })?.slotId;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseModel(params: TeamRuntimeActionParams): { provider: string; model: string } {
  const raw = params.model?.trim();
  let provider = params.provider?.trim();
  let model = raw;
  if (raw?.includes("/")) {
    const slash = raw.indexOf("/");
    provider ??= raw.slice(0, slash);
    model = raw.slice(slash + 1);
  }
  if (!provider || !model) {
    throw new TeamRuntimeError("not_found", "provider and model are required (or use model: provider/model)");
  }
  return { provider, model };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function roleProfileFromParams(params: TeamRuntimeActionParams): AgentRoleProfile | undefined {
  const hasStructuredInput = params.roleProfile !== undefined ||
    params.roleDescription !== undefined ||
    params.personality !== undefined ||
    params.teamStrengths !== undefined ||
    params.caution !== undefined;
  if (!hasStructuredInput) return undefined;

  return {
    roleDescription: params.roleDescription ?? params.roleProfile?.roleDescription ?? "",
    personality: params.personality ?? params.roleProfile?.personality ?? "",
    teamStrengths: params.teamStrengths ?? params.roleProfile?.teamStrengths ?? "",
    caution: params.caution ?? params.roleProfile?.caution ?? "",
  };
}

function splitCommandArgs(input: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    result.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, "$1"));
  }
  return result;
}

interface WebCommandOptions {
  memberLimit?: number;
  port?: number;
  open?: boolean;
  share?: boolean;
  shareTtlHours?: number;
  shareProvider?: string;
  shareUrl?: string;
  shareCommand?: string;
  shareConfigPath?: string;
  shareAutoStart?: boolean;
  revoke?: boolean;
  shareDoctor?: boolean;
}

function parseWebCommandArgs(args: string[]): WebCommandOptions {
  const options: WebCommandOptions = {};
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    const next = () => args[++index];
    if (item === "--share") {
      options.share = true;
      continue;
    }
    if (item === "--no-open") {
      options.open = false;
      continue;
    }
    if (item === "--port") {
      options.port = parseWebPort(next());
      continue;
    }
    if (item.startsWith("--port=")) {
      options.port = parseWebPort(item.slice("--port=".length));
      continue;
    }
    if (item === "--revoke" || item === "revoke" || item === "stop") {
      options.revoke = true;
      continue;
    }
    if (item === "--share-doctor" || item === "share-doctor") {
      options.shareDoctor = true;
      continue;
    }
    if (item === "--provider" || item === "--share-provider") {
      options.shareProvider = next();
      continue;
    }
    if (item === "--url" || item === "--share-url") {
      options.shareUrl = next();
      continue;
    }
    if (item === "--config" || item === "--share-config") {
      options.shareConfigPath = next();
      continue;
    }
    if (item === "--command" || item === "--share-command") {
      options.shareCommand = next();
      continue;
    }
    if (item === "--share-auto-start") {
      options.shareAutoStart = true;
      continue;
    }
    if (item === "--no-share-auto-start" || item === "--manual-tunnel") {
      options.shareAutoStart = false;
      continue;
    }
    if (item === "--ttl" || item === "--share-ttl") {
      options.shareTtlHours = parseShareTtlHours(next());
      continue;
    }
    if (item.startsWith("--ttl=")) {
      options.shareTtlHours = parseShareTtlHours(item.slice("--ttl=".length));
      continue;
    }
    if (item.startsWith("--share-ttl=")) {
      options.shareTtlHours = parseShareTtlHours(item.slice("--share-ttl=".length));
      continue;
    }
    const parsedMemberLimit = Number.parseInt(item, 10);
    if (!Number.isFinite(options.memberLimit) && Number.isFinite(parsedMemberLimit) && String(parsedMemberLimit) === item) {
      options.memberLimit = parsedMemberLimit;
    }
  }
  return options;
}

function parseWebPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || String(port) !== value || port < 0 || port > 65535) return undefined;
  return port;
}

function parseShareTtlHours(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(m|h|d)?$/i);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = (match[2] ?? "h").toLocaleLowerCase();
  if (unit === "m") return amount / 60;
  if (unit === "d") return amount * 24;
  return amount;
}

function normalizeShareSessionTtlHours(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return TEAM_WEB_SHARE_DEFAULT_SESSION_TTL_HOURS;
  }
  return value;
}

function formatShareTtlHours(hours: number): string {
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(hours * 100) / 100}h`;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomPin(): string {
  return String(randomInt(0, 10 ** TEAM_WEB_SHARE_PIN_DIGITS)).padStart(TEAM_WEB_SHARE_PIN_DIGITS, "0");
}

function constantTimeStringEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  const length = Math.max(aBuffer.length, bBuffer.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  aBuffer.copy(paddedA);
  bBuffer.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && aBuffer.length === bBuffer.length;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineShareQrSvg(svg: string): string {
  const inline = svg.replace(/^\s*<\?xml[^>]*>\s*/i, "").trim();
  if (!inline.startsWith("<svg")) return "";
  const width = inline.match(/\bwidth="([0-9.]+)"/)?.[1] ?? "220";
  const height = inline.match(/\bheight="([0-9.]+)"/)?.[1] ?? width;
  return inline.replace(
    "<svg ",
    `<svg class="share-qr-svg" role="img" aria-label="Team Web share QR" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" `,
  );
}

export class TeamRuntimeManager {
  private store?: TeamStore;
  private runtime?: AgentRuntime;
  private coordinator?: TeamCoordinator;
  private chatBridge?: PiWebChatBridge;
  private active?: HostContext;
  private hostSessionId?: string;
  private principal?: string;
  private cwd?: string;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly abortControllers = new Set<AbortController>();
  private webServer?: Server;
  private webSocketServer?: WebSocketServer;
  private webUrl?: string;
  private webToken?: string;
  private webPort?: number;
  private readonly webSessions = new Map<string, TeamWebSession>();
  private readonly activeContextSlot = new AsyncLocalStorage<ActiveContextSlot>();
  private webShare?: ActiveTeamWebShare;
  private readonly shareSocketClosers = new Set<() => void>();
  private readonly capabilityDiscovery = new RuntimeCapabilityDiscovery();
  private webShareTunnel?: ActiveTeamWebShareTunnel;
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private processRecoveryController = new AbortController();
  private readonly processRecoveries = new Map<string, Promise<TurnProcess>>();
  private cliModelOptions?: RuntimeCliModelOptions;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: TeamRuntimeManagerOptions = {},
  ) {}

  register(): void {
    this.pi.on("input", (event, ctx) => this.handleInput(event, ctx));
    // Team storage is opened lazily. A host PI session that never enters Team
    // mode must not create `.pi/messenger` or a SQLite database on startup.
    // If a database already exists, however, restore the host's durable Team
    // context and drain work committed before the host process stopped.
    this.pi.on("session_start", async (_event, ctx) => {
      const databasePath = this.options.databasePath?.(ctx.cwd)
        ?? join(ctx.cwd, ".pi", "messenger", "team-runtime.sqlite");
      if (!existsSync(databasePath)) return;
      await this.start(ctx);
      if (this.active && this.store?.getThread(this.active.threadId)?.status === "active") {
        this.startPump(this.active.threadId);
      }
    });
    this.pi.on("session_shutdown", async () => {
      await this.shutdown();
    });
    this.pi.registerCommand("team", {
      description: "Manage and inspect the persistent PI Agent Team runtime",
      handler: async (args, ctx) => {
        const response = await this.handleCommand(args, ctx);
        this.pi.sendMessage({
          customType: "team_runtime_command",
          content: response.content[0].text,
          display: true,
          details: response.details,
        }, { triggerTurn: false });
      },
    });
  }

  async start(ctx: ExtensionContext): Promise<void> {
    const hostSessionId = ctx.sessionManager.getSessionId();
    const principal = this.resolvePrincipal(ctx);
    if (this.coordinator && this.cwd === ctx.cwd && this.hostSessionId === hostSessionId && this.principal === principal) return;
    if (this.coordinator) await this.shutdown();

    this.closing = false;
    this.processRecoveryController = new AbortController();
    this.cwd = ctx.cwd;
    this.hostSessionId = hostSessionId;
    this.principal = principal;
    const root = join(ctx.cwd, ".pi", "messenger");
    mkdirSync(root, { recursive: true });
    const databasePath = this.options.databasePath?.(ctx.cwd) ?? join(root, "team-runtime.sqlite");
    const sessionDir = this.options.sessionDir?.(ctx.cwd) ?? join(root, "team-sessions");
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    mkdirSync(sessionDir, { recursive: true });
    this.store = new TeamStore(databasePath);
    const runtime = this.options.runtimeFactory?.({ cwd: ctx.cwd, sessionDir, agentDir });
    if (runtime) this.runtime = runtime;
    else {
      // The closure is evaluated lazily when a member Session opens, after the
      // coordinator (and its durable MemoryStore) has been assigned below.
      this.runtime = new PiAgentRuntime({
        sessionDir,
        agentDir,
        idleTimeoutMs: 15 * 60_000,
        usePiWebForPiAgents: this.options.usePiWebForTeamAgents !== false,
        piWebBaseUrl: this.options.piWebBaseUrl,
        piWebPollMs: this.options.piWebPollMs,
        piWebIdleTimeoutMs: this.options.piWebIdleTimeoutMs,
        customTools: (agent, binding) => [createAgentMemoryTool(this.store!, this.coordinator!.memory, agent, binding)],
      });
    }
    this.coordinator = new TeamCoordinator(this.store, this.runtime, {
      cwd: ctx.cwd,
      leaseMs: this.options.leaseMs ?? 30_000,
      maxAttempts: 5,
      maxDepth: 8,
      maxInvocationsPerRoot: 32,
      maxPingPong: 4,
    });
    this.chatBridge = new PiWebChatBridge({
      baseUrl: this.options.piWebBaseUrl,
      cwd: ctx.cwd,
      now: () => this.now(),
    });
    const bySession = this.store.getHostContext(hostSessionId);
    const bySessionTeam = bySession ? this.store.getTeam(bySession.teamId) : undefined;
    const restored = bySession?.principalId === principal || bySessionTeam?.ownerId === principal
      ? bySession
      : this.store.getHostContextForPrincipal(principal);
    if (restored) {
      const team = this.store.getTeam(restored.teamId);
      const thread = this.store.getThread(restored.threadId);
      if (team?.ownerId === principal && thread?.teamId === team.id && thread.status !== "archived") {
        this.active = this.store.setHostContextForPrincipal(hostSessionId, principal, team.id, thread.id);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.closing = true;
      this.processRecoveryController.abort(new Error("Team process recovery stopped"));
      this.processRecoveries.clear();
      for (const controller of this.abortControllers) controller.abort(new Error("Host PI session shutting down"));
      await this.waitForIdle();
      await this.stopWebShareTunnel();
      if (this.webServer) {
        this.webSocketServer?.clients.forEach((client) => {
          try {
            client.close();
          } catch {
            // Best effort while shutting down.
          }
        });
        this.webSocketServer?.close();
        this.webSocketServer = undefined;
        await new Promise<void>((resolve) => this.webServer?.close(() => resolve()));
        this.webServer = undefined;
        this.webUrl = undefined;
        this.webToken = undefined;
        this.webPort = undefined;
        this.webSessions.clear();
        this.webShare = undefined;
      }
      await this.chatBridge?.shutdown();
      this.chatBridge = undefined;
      await this.runtime?.dispose?.();
      this.store?.close();
      this.store = undefined;
      this.runtime = undefined;
      this.coordinator = undefined;
      this.active = undefined;
      this.cwd = undefined;
      this.hostSessionId = undefined;
      this.principal = undefined;
      this.abortControllers.clear();
      this.closing = false;
    })();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = undefined;
    }
  }

  private async closeWebUiServer(): Promise<void> {
    await this.stopWebShareTunnel();
    this.webSocketServer?.clients.forEach((client) => {
      try {
        client.close();
      } catch {
        // Best effort while rotating the web server.
      }
    });
    this.webSocketServer?.close();
    this.webSocketServer = undefined;
    if (this.webServer) {
      await new Promise<void>((resolve) => this.webServer?.close(() => resolve()));
    }
    this.webServer = undefined;
    this.webUrl = undefined;
    this.webToken = undefined;
    this.webPort = undefined;
    this.webSessions.clear();
    this.webShare = undefined;
  }

  async handleAction(
    action: string,
    params: TeamRuntimeActionParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    try {
      await this.start(ctx);
      const store = this.requireStore();
      const coordinator = this.requireCoordinator();
      const principal = this.requirePrincipal();
      const operation = action.replace(/^team\.runtime\.?/, "");

      switch (operation) {
        case "doctor": {
          const connectors = await this.runtimeDoctor(ctx, params, signal);
          return result(formatRuntimeDoctor(connectors), {
            mode: "team.runtime.doctor",
            connectors,
            probe: params.probe === true,
          });
        }

        case "setup": {
          const setup = coordinator.setup({
            name: params.name?.trim() || "PI Team",
            ownerId: principal,
            title: params.name?.trim() || "PI Team",
            teamId: params.teamId,
            threadId: params.threadId,
          });
          const context = this.setCurrentActiveContext(setup.team.id, setup.thread.id);
          return result(
            `Created and entered Team ${setup.team.name}. Add persistent members with team.runtime.agent.add, then use @all or @Agent in this PI session.`,
            { mode: "team.runtime.setup", team: setup.team, thread: setup.thread, context },
          );
        }

        case "agent.add": {
          const active = this.requireActive();
          if (params.teamId && params.teamId !== active.teamId) {
            throw new TeamRuntimeError("permission_denied", "Agents can only be added to the active Team");
          }
          if (!params.name?.trim()) throw new TeamRuntimeError("not_found", "name is required");
          const model = parseModel(params);
          const agent = coordinator.addAgent({
            teamId: params.teamId ?? active.teamId,
            name: params.name.trim(),
            clientId: trimOrUndefined(params.clientId),
            provider: model.provider,
            model: model.model,
            role: params.role,
            thinking: params.thinking,
            roleProfile: roleProfileFromParams(params),
            rolePrompt: params.rolePrompt,
            skills: params.skills,
            skillRefs: params.skillRefs,
            aliases: params.aliases,
            runtimePolicy: params.runtimePolicy,
            agentId: params.agentId,
            makeDefault: params.makeDefault,
          });
          return result(`Added persistent Team member ${agent.name} (${agent.provider}/${agent.model}).`, {
            mode: "team.runtime.agent.add", agent,
          });
        }

        case "agent.update": {
          const active = this.requireActive();
          if (params.teamId && params.teamId !== active.teamId) {
            throw new TeamRuntimeError("permission_denied", "Agents can only be updated in the active Team");
          }
          if (!params.agentId) throw new TeamRuntimeError("not_found", "agentId is required");
          const existing = store.getAgent(params.agentId);
          const existingMember = store.getMember(active.teamId, params.agentId);
          if (!existing || !existingMember) {
            throw new TeamRuntimeError("not_found", `Team member not found: ${params.agentId}`, { agentId: params.agentId });
          }
          const name = params.name === undefined ? existing.name : params.name.trim();
          if (!name) throw new TeamRuntimeError("not_found", "name is required");
          const role = params.role === undefined ? existingMember.role : params.role.trim();
          const binding = params.provider === undefined && params.model === undefined
            ? { provider: existing.provider, model: existing.model }
            : parseModel({ provider: params.provider ?? existing.provider, model: params.model ?? existing.model });
          const thinking = params.thinking === undefined ? existing.thinking : params.thinking;
          const roleProfile = roleProfileFromParams(params);
          const rolePrompt = params.rolePrompt === undefined ? existing.rolePrompt : params.rolePrompt.trim();
          const agent = coordinator.addAgent({
            teamId: active.teamId,
            agentId: existing.id,
            name,
            clientId: params.clientId === undefined ? existing.clientId : trimOrUndefined(params.clientId),
            provider: binding.provider,
            model: binding.model,
            thinking,
            role,
            ...(roleProfile !== undefined ? { roleProfile } : {}),
            rolePrompt,
            aliases: params.aliases ?? existing.aliases,
            runtimePolicy: params.runtimePolicy ?? existing.runtimePolicy,
            makeDefault: false,
          });
          return result(`Updated Team member ${agent.name}.`, {
            mode: "team.runtime.agent.update",
            agent,
            member: store.getMember(active.teamId, agent.id),
          });
        }

        case "enter": {
          if (!params.teamId || !params.threadId) {
            throw new TeamRuntimeError("not_found", "teamId and threadId are required");
          }
          const team = store.getTeam(params.teamId);
          if (!team) throw new TeamRuntimeError("not_found", `Team not found: ${params.teamId}`);
          if (team.ownerId !== principal) {
            throw new TeamRuntimeError("permission_denied", `Principal does not own Team ${params.teamId}`);
          }
          const thread = store.getThread(params.threadId);
          if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${params.threadId}`);
          if (thread.teamId !== team.id) {
            throw new TeamRuntimeError("conflict", `Thread ${params.threadId} does not belong to Team ${params.teamId}`);
          }
          if (thread.status === "archived") {
            throw new TeamRuntimeError("thread_sealed", `Thread ${params.threadId} is ${thread.status}`);
          }
          const context = this.setCurrentActiveContext(params.teamId, params.threadId);
          if (thread.status === "active") this.startPump(params.threadId);
          return result(`Entered Team ${params.teamId}, Thread ${params.threadId}${thread.status === "sealed" ? " (read-only)" : ""}.`, {
            mode: "team.runtime.enter", context, readOnly: thread.status === "sealed",
          });
        }

        case "leave": {
          const previous = this.currentActive();
          this.clearCurrentActiveContext();
          return result("Left Team mode. Team members, Thread transcript, Sessions, and memory remain persisted.", {
            mode: "team.runtime.leave", previous,
          });
        }

        case "list": {
          const teams = store.listTeams(false).filter((team) => team.ownerId === principal);
          return result(this.formatTeamList(teams), { mode: "team.runtime.list", teams });
        }

        case "status": {
          return result(this.formatStatus(), { mode: "team.runtime.status", context: this.currentActive() });
        }

        case "web.revoke": {
          const revoked = await this.revokeWebShare();
          return result(
            revoked
              ? "Team Web mobile share revoked. Pending QR login token and all mobile sessions are now invalid."
              : "Team Web mobile share was not active.",
            { mode: "team.runtime.web.revoke", revoked },
          );
        }

        case "web.share.doctor": {
          const text = describeTeamWebShareDoctor({
            cwd: ctx.cwd,
            provider: params.shareProvider,
            publicUrl: params.shareUrl,
            command: params.shareCommand,
            configPath: params.shareConfigPath,
            autoStart: params.shareAutoStart,
            localPort: params.port ?? this.webPort,
          });
          return result(text, { mode: "team.runtime.web.share.doctor", shareReady: resolveTeamWebShareConfig({
            cwd: ctx.cwd,
            provider: params.shareProvider,
            publicUrl: params.shareUrl,
            command: params.shareCommand,
            configPath: params.shareConfigPath,
            autoStart: params.shareAutoStart,
            localPort: params.port ?? this.webPort,
          }).ok });
        }

        case "web": {
          if (params.share === true) {
            const preflight = resolveTeamWebShareConfig({
              cwd: ctx.cwd,
              provider: params.shareProvider,
              publicUrl: params.shareUrl,
              command: params.shareCommand,
              configPath: params.shareConfigPath,
              autoStart: params.shareAutoStart,
              localPort: params.port,
            });
            if (preflight.ok === false) {
              throw new TeamRuntimeError("conflict", describeTeamWebShareDoctor({
                cwd: ctx.cwd,
                provider: params.shareProvider,
                publicUrl: params.shareUrl,
                command: params.shareCommand,
                configPath: params.shareConfigPath,
                autoStart: params.shareAutoStart,
                localPort: params.port,
              }));
            }
          }
          const bootstrap = this.ensureDefaultWebTeam(ctx, params.memberLimit);
          const web = await this.startWebUi(ctx, {
            port: params.port,
            open: params.open !== false,
            share: params.share === true,
            shareTtlHours: params.shareTtlHours,
            shareProvider: params.shareProvider,
            shareUrl: params.shareUrl,
            shareCommand: params.shareCommand,
            shareConfigPath: params.shareConfigPath,
            shareAutoStart: params.shareAutoStart,
          });
          return result(this.formatWebStartMessage(web), { mode: "team.runtime.web", ...web, bootstrap });
        }

        case "members": {
          const active = this.requireActive();
          const members = store.listMembers(active.teamId);
          const text = members.length
            ? members.map((member) => `${member.enabled ? "active" : "disabled"} ${member.name} [${member.agentId}] ${member.provider}/${member.model}${member.role ? ` role=${member.role}` : ""}`).join("\n")
            : "No persistent members yet.";
          return result(text, { mode: "team.runtime.members", members });
        }

        case "history": {
          const active = this.requireActive();
          const messages = store.listMessagesForPrincipal(active.threadId, principal, { limit: params.limit ?? 50 });
          const text = messages.length
            ? messages.map((message) => `${message.seq}. ${message.authorType}:${message.authorId}\n${message.content}`).join("\n\n")
            : "Thread transcript is empty.";
          return result(text, { mode: "team.runtime.history", messages });
        }

        case "memory.write": {
          const active = this.requireActive();
          if (!params.message?.trim()) throw new TeamRuntimeError("not_found", "message is required");
          const scope = params.scope ?? "team";
          if (scope === "agent_private" && !params.agentId) {
            throw new TeamRuntimeError("not_found", "agentId is required for agent_private memory");
          }
          const memory = coordinator.memory.write({
            scope,
            ...(scope === "team" ? { teamId: active.teamId } : {}),
            ...(scope === "thread" ? { threadId: active.threadId } : {}),
            ...(scope === "agent_private" ? {
              teamId: active.teamId,
              threadId: active.threadId,
              ownerAgentId: params.agentId,
            } : {}),
            sourceMessageId: params.sourceMessageId,
            provenance: params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : undefined,
            writerType: "user",
            writerId: principal,
            visibility: params.visibility,
            visibleTo: params.visibleTo,
            content: params.message.trim(),
            metadata: params.metadata,
            idempotencyKey: params.idempotencyKey,
          });
          return result(`Stored ${memory.scope} memory ${memory.id}.`, {
            mode: "team.runtime.memory.write", memory,
          });
        }

        case "memory.list": {
          const active = this.requireActive();
          const scope = params.scope;
          if (scope === "agent_private") {
            throw new TeamRuntimeError("permission_denied", "Agent-private memory can only be recalled by its owner Agent");
          }
          const memories = scope === "thread"
              ? coordinator.memory.recallForPrincipal({ scope, threadId: active.threadId, limit: params.limit ?? 50 }, principal)
              : scope === "team"
                ? coordinator.memory.recallForPrincipal({ scope, teamId: active.teamId, limit: params.limit ?? 50 }, principal)
                : [
                  ...coordinator.memory.recallForPrincipal({ scope: "team", teamId: active.teamId, limit: params.limit ?? 50 }, principal),
                  ...coordinator.memory.recallForPrincipal({ scope: "thread", threadId: active.threadId, limit: params.limit ?? 50 }, principal),
                ];
          const text = memories.length
            ? memories.map((memory) => `${memory.id} [${memory.scope}] ${memory.content}`).join("\n")
            : "No matching memory.";
          return result(text, { mode: "team.runtime.memory.list", memories });
        }

        case "memory.revoke": {
          const active = this.requireActive();
          if (!params.memoryId) throw new TeamRuntimeError("not_found", "memoryId is required");
          const current = coordinator.memory.get(params.memoryId);
          if (!current) throw new TeamRuntimeError("not_found", `Memory not found: ${params.memoryId}`);
          if (current.teamId !== active.teamId) {
            throw new TeamRuntimeError("permission_denied", `Memory ${params.memoryId} does not belong to the active Team`);
          }
          const memory = coordinator.memory.revoke(params.memoryId, principal);
          return result(`Revoked memory ${memory.id}.`, { mode: "team.runtime.memory.revoke", memory });
        }

        case "send": {
          const active = this.requireActive();
          if (!params.message?.trim()) throw new TeamRuntimeError("not_found", "message is required");
          const routed = coordinator.routeMessage({
            threadId: active.threadId,
            authorId: principal,
            content: params.message,
            idempotencyKey: params.idempotencyKey,
            replyTo: params.replyTo,
          });
          this.maybeAutoTitleThread(routed.message.threadId, params.message);
          const results = await this.runAndPublish(routed.invocations, signal);
          return result(`Routed message ${routed.message.seq} to ${routed.message.wakeTargets.length} persistent member(s).`, {
            mode: "team.runtime.send", message: routed.message, results,
          });
        }

        case "send.queued": {
          const active = this.requireActive();
          if (!params.message?.trim()) throw new TeamRuntimeError("not_found", "message is required");
          const routed = coordinator.routeMessage({
            threadId: active.threadId,
            authorId: principal,
            content: params.message,
            idempotencyKey: params.idempotencyKey,
            replyTo: params.replyTo,
          });
          this.maybeAutoTitleThread(routed.message.threadId, params.message);
          this.startPump(routed.message.threadId, routed.invocations);
          return result(`Queued message ${routed.message.seq} for ${routed.message.wakeTargets.length} persistent member(s).`, {
            mode: "team.runtime.send.queued",
            message: routed.message,
            queuedInvocations: routed.invocations,
          });
        }

        case "invocation.cancel": {
          const active = this.requireActive();
          const invocation = this.requireInvocationInActiveTeam(params.invocationId, active.teamId);
          const cancelled = coordinator.cancelInvocation(invocation.id, params.reason?.trim() || "用户手动终止");
          return result(`Stopped Team invocation ${cancelled.id}.`, {
            mode: "team.runtime.invocation.cancel",
            invocation: cancelled,
          });
        }

        case "invocation.steer": {
          const active = this.requireActive();
          const invocation = this.requireInvocationInActiveTeam(params.invocationId, active.teamId);
          if (!params.message?.trim()) throw new TeamRuntimeError("not_found", "message is required");
          const piWebSteered = await this.controlPiWebInvocation(ctx, invocation, principal, "steer", params.message);
          if (piWebSteered) {
            return result(`Steered Team invocation ${invocation.id} through PI Web session ${piWebSteered.sessionId}.`, {
              mode: "team.runtime.invocation.steer",
              invocation,
              message: piWebSteered.message,
              piWebSessionId: piWebSteered.sessionId,
              piWeb: true,
            });
          }
          const steered = coordinator.steerInvocation(invocation.id, principal, params.message);
          this.startPump(steered.message.threadId, [steered.invocation]);
          return result(`Steered Team invocation ${steered.cancelled.id}.`, {
            mode: "team.runtime.invocation.steer",
            cancelledInvocation: steered.cancelled,
            message: steered.message,
            queuedInvocation: steered.invocation,
          });
        }

        case "invocation.follow": {
          const active = this.requireActive();
          const invocation = this.requireInvocationInActiveTeam(params.invocationId, active.teamId);
          if (!params.message?.trim()) throw new TeamRuntimeError("not_found", "message is required");
          const followed = await this.controlPiWebInvocation(ctx, invocation, principal, "followUp", params.message);
          if (!followed) {
            throw new TeamRuntimeError("conflict", "Follow requires a PI Web-backed running Agent session", {
              invocationId: invocation.id,
            });
          }
          return result(`Followed Team invocation ${invocation.id} through PI Web session ${followed.sessionId}.`, {
            mode: "team.runtime.invocation.follow",
            invocation,
            message: followed.message,
            piWebSessionId: followed.sessionId,
            piWeb: true,
          });
        }

        case "thread.new": {
          const active = this.requireActive();
          const threads = store.listThreads(active.teamId, false);
          const title = params.title?.trim() || `对话 ${threads.length + 1}`;
          const created = this.createAndEnterThread(active.teamId, title, params.folderId);
          return result(`Created Team Thread ${created.thread.title ?? created.thread.id}.`, {
            mode: "team.runtime.thread.new",
            thread: created.thread,
            context: created.context,
          });
        }

        case "thread.rename": {
          const active = this.requireActive();
          if (!params.threadId) throw new TeamRuntimeError("not_found", "threadId is required");
          const title = params.title?.trim();
          if (!title) throw new TeamRuntimeError("not_found", "title is required");
          const thread = store.getThread(params.threadId);
          if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${params.threadId}`);
          if (thread.teamId !== active.teamId) {
            throw new TeamRuntimeError("permission_denied", `Thread ${params.threadId} does not belong to the active Team`);
          }
          if (thread.status === "archived") {
            throw new TeamRuntimeError("thread_sealed", `Thread ${params.threadId} is archived`);
          }
          const renamed = store.renameThread(thread.id, title);
          return result(`Renamed Team Thread ${renamed.id} to ${renamed.title}.`, {
            mode: "team.runtime.thread.rename",
            thread: renamed,
          });
        }

        case "thread.move": {
          const active = this.requireActive();
          this.requireThreadInActiveTeam(params.threadId, active.teamId);
          const moved = store.moveThreadToFolder(params.threadId!, params.folderId);
          return result(`Moved Team Thread ${moved.id}.`, {
            mode: "team.runtime.thread.move",
            thread: moved,
          });
        }

        case "thread.bulk.move": {
          const active = this.requireActive();
          const threads = this.requireThreadsInActiveTeam(params.threadIds, active.teamId);
          const moved = store.moveThreadsToFolder(threads.map((thread) => thread.id), params.folderId);
          return result(`Moved ${moved.length} Team Thread(s).`, {
            mode: "team.runtime.thread.bulk.move",
            threads: moved,
          });
        }

        case "thread.folder.create": {
          const active = this.requireActive();
          const name = params.name?.trim();
          if (!name) throw new TeamRuntimeError("not_found", "name is required");
          const now = nowIso();
          const folder = store.createThreadFolder({
            id: `folder-${randomUUID()}`,
            teamId: active.teamId,
            name,
            position: store.listThreadFolders(active.teamId).length,
            createdAt: now,
            updatedAt: now,
          });
          return result(`Created Thread folder ${folder.name}.`, {
            mode: "team.runtime.thread.folder.create",
            folder,
          });
        }

        case "thread.folder.rename": {
          const active = this.requireActive();
          if (!params.folderId) throw new TeamRuntimeError("not_found", "folderId is required");
          const name = params.name?.trim();
          if (!name) throw new TeamRuntimeError("not_found", "name is required");
          const current = store.getThreadFolder(params.folderId);
          if (!current) throw new TeamRuntimeError("not_found", `Thread folder not found: ${params.folderId}`);
          if (current.teamId !== active.teamId) {
            throw new TeamRuntimeError("permission_denied", `Thread folder ${params.folderId} does not belong to the active Team`);
          }
          const folder = store.renameThreadFolder(params.folderId, name);
          return result(`Renamed Thread folder ${folder.name}.`, {
            mode: "team.runtime.thread.folder.rename",
            folder,
          });
        }

        case "thread.folder.reorder": {
          const active = this.requireActive();
          const folderIds = params.folderIds ?? [];
          const folders = store.reorderThreadFolders(active.teamId, folderIds);
          return result(`Reordered ${folders.length} Thread folder(s).`, {
            mode: "team.runtime.thread.folder.reorder",
            folders,
          });
        }

        case "thread.folder.delete": {
          const active = this.requireActive();
          if (!params.folderId) throw new TeamRuntimeError("not_found", "folderId is required");
          const folder = store.getThreadFolder(params.folderId);
          if (!folder) throw new TeamRuntimeError("not_found", `Thread folder not found: ${params.folderId}`);
          if (folder.teamId !== active.teamId) {
            throw new TeamRuntimeError("permission_denied", `Thread folder ${params.folderId} does not belong to the active Team`);
          }
          const deleted = store.deleteThreadFolder(params.folderId);
          return result(`Deleted Thread folder ${deleted.name}.`, {
            mode: "team.runtime.thread.folder.delete",
            folder: deleted,
          });
        }

        case "thread.archive": {
          const active = this.requireActive();
          const thread = this.requireThreadInActiveTeam(params.threadId, active.teamId);
          const wasActive = active.threadId === thread.id;
          const archived = store.archiveThread(thread.id);
          await this.runtime?.dispose?.(thread.id);
          const replacement = wasActive ? this.createAndEnterThread(active.teamId, "新对话") : undefined;
          return result(`Archived Team Thread ${archived.id}.`, {
            mode: "team.runtime.thread.archive",
            thread: archived,
            ...(replacement ? { replacementThread: replacement.thread, context: replacement.context } : {}),
          });
        }

        case "thread.restore": {
          const active = this.requireActive();
          const thread = this.requireThreadInActiveTeam(params.threadId, active.teamId);
          const restored = store.restoreThread(thread.id);
          return result(`Restored Team Thread ${restored.id}.`, {
            mode: "team.runtime.thread.restore",
            thread: restored,
          });
        }

        case "thread.bulk.archive": {
          const active = this.requireActive();
          const threads = this.requireThreadsInActiveTeam(params.threadIds, active.teamId);
          const wasActive = threads.some((thread) => thread.id === active.threadId);
          const archived = store.archiveThreads(threads.map((thread) => thread.id));
          await Promise.all(archived.map((thread) => this.runtime?.dispose?.(thread.id)));
          const replacement = wasActive ? this.createAndEnterThread(active.teamId, "新对话") : undefined;
          return result(`Archived ${archived.length} Team Thread(s).`, {
            mode: "team.runtime.thread.bulk.archive",
            threads: archived,
            ...(replacement ? { replacementThread: replacement.thread, context: replacement.context } : {}),
          });
        }

        case "thread.delete": {
          const active = this.requireActive();
          const thread = this.requireThreadInActiveTeam(params.threadId, active.teamId);
          const wasActive = active.threadId === thread.id;
          const deleted = store.deleteThread(thread.id);
          await this.runtime?.dispose?.(thread.id);
          const replacement = wasActive ? this.createAndEnterThread(active.teamId, "新对话") : undefined;
          return result(`Deleted Team Thread ${deleted.id}.`, {
            mode: "team.runtime.thread.delete",
            thread: deleted,
            ...(replacement ? { replacementThread: replacement.thread, context: replacement.context } : {}),
          });
        }

        case "thread.bulk.delete": {
          const active = this.requireActive();
          const threads = this.requireThreadsInActiveTeam(params.threadIds, active.teamId);
          const wasActive = threads.some((thread) => thread.id === active.threadId);
          const deleted = store.deleteThreads(threads.map((thread) => thread.id));
          await Promise.all(deleted.map((thread) => this.runtime?.dispose?.(thread.id)));
          const replacement = wasActive ? this.createAndEnterThread(active.teamId, "新对话") : undefined;
          return result(`Deleted ${deleted.length} Team Thread(s).`, {
            mode: "team.runtime.thread.bulk.delete",
            threads: deleted,
            ...(replacement ? { replacementThread: replacement.thread, context: replacement.context } : {}),
          });
        }

        case "run.pending": {
          const active = this.requireActive();
          const results = await this.runPendingAndPublish(active.threadId, signal);
          return result(`Processed ${results.length} pending invocation(s).`, { mode: "team.runtime.run.pending", results });
        }

        case "thread.seal": {
          const active = this.requireActive();
          const thread = store.sealThread(active.threadId);
          this.clearCurrentActiveContext();
          await this.runtime?.dispose?.(thread.id);
          return result(`Sealed Thread ${thread.id}.`, { mode: "team.runtime.thread.seal", thread });
        }

        default:
          return result(`Unknown Team runtime action: ${action}`, { mode: "team.runtime", error: "unknown_action", action });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof TeamRuntimeError ? error.code : "runtime_error";
      return result(`Team runtime error: ${message}`, { mode: action, error: code, message });
    }
  }

  async handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
    const restoring = !this.coordinator;
    if (!this.coordinator) {
      const databasePath = this.options.databasePath?.(ctx.cwd) ?? join(ctx.cwd, ".pi", "messenger", "team-runtime.sqlite");
      if (!existsSync(databasePath)) return { action: "continue" };
      await this.start(ctx);
    }
    if (!this.active || event.source === "extension" || event.text.trimStart().startsWith("/")) {
      return { action: "continue" };
    }
    if (this.requireStore().getThread(this.active.threadId)?.status !== "active") return { action: "continue" };

    try {
      const active = this.requireActive();
      const routed = this.requireCoordinator().routeMessage({
        threadId: active.threadId,
        authorId: this.requirePrincipal(),
        content: event.text,
        idempotencyKey: `host:${this.requirePrincipal()}:${randomUUID()}`,
      });
      this.maybeAutoTitleThread(routed.message.threadId, event.text);
      ctx.ui.notify(`Team message queued for ${routed.message.wakeTargets.length} member(s)`, "info");
      // On the first input after a host restart, drain every durable pending
      // delivery, including work committed before the process stopped.
      this.startPump(routed.message.threadId, restoring ? undefined : routed.invocations);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  }

  async waitForIdle(): Promise<void> {
    while (this.operations.size > 0) await Promise.allSettled([...this.operations]);
  }

  getActiveContext(): HostContext | undefined {
    return this.active;
  }

  private runtimeSessionProjection(
    threadId: string,
    members: readonly TeamMember[],
    agents: readonly PersistentAgent[],
  ): TeamRuntimeAgentSessionProjection[] {
    const store = this.requireStore();
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    return members
      .map((member) => {
        const binding = store.getSessionBinding(threadId, member.agentId);
        if (!binding) return undefined;
        const agent = agentById.get(member.agentId);
        const piWebSessionId = piWebSessionIdFromMarker(binding.sessionFile);
        return {
          threadId: binding.threadId,
          agentId: binding.agentId,
          clientId: agent?.clientId ?? "pi",
          sessionId: piWebSessionId ?? binding.piSessionId,
          ...(binding.sessionFile ? { sessionFile: binding.sessionFile } : {}),
          provider: binding.provider,
          model: binding.model,
          ...(binding.thinking ? { thinking: binding.thinking } : {}),
          piWeb: !!piWebSessionId,
          ...(piWebSessionId ? { eventStreamId: piWebSessionId } : {}),
        } satisfies TeamRuntimeAgentSessionProjection;
      })
      .filter((item): item is TeamRuntimeAgentSessionProjection => !!item);
  }

  private async controlPiWebInvocation(
    ctx: ExtensionContext,
    invocation: Invocation,
    principal: string,
    mode: "followUp" | "steer",
    message: string,
  ): Promise<{ sessionId: string; message: CanonicalMessage } | undefined> {
    if (invocation.status !== "running") return undefined;
    const store = this.requireStore();
    const binding = store.getSessionBinding(invocation.threadId, invocation.targetAgentId);
    const sessionId = piWebSessionIdFromMarker(binding?.sessionFile);
    if (!sessionId) return undefined;
    const trimmed = message.trim();
    if (!trimmed) throw new TeamRuntimeError("not_found", "message is required");
    await this.requireChatBridge(ctx).send({ sessionId, text: trimmed, mode });
    const agent = store.getAgent(invocation.targetAgentId);
    const agentName = agent?.name ?? invocation.targetAgentId;
    const label = mode === "steer" ? "steer" : "follow";
    const canonical = store.appendMessage({
      threadId: invocation.threadId,
      authorType: "user",
      authorId: principal,
      content: `运行中追加给 @${agentName} 的 ${label}：\n${trimmed}`,
      visibility: "team",
      wakeTargets: [],
      targetSelectors: { [invocation.targetAgentId]: [label] },
      replyTo: invocation.sourceMessageId,
      idempotencyKey: `${label}:${invocation.id}:${randomUUID()}`,
    });
    this.maybeAutoTitleThread(canonical.threadId, trimmed);
    return { sessionId, message: canonical };
  }

  getOverlaySnapshot(limit = 12, ctx?: ExtensionContext): TeamRuntimeOverlaySnapshot {
    const capabilitySnapshot = ctx ? this.capabilitySnapshot(ctx) : undefined;
    const empty = (unavailableReason?: string): TeamRuntimeOverlaySnapshot => ({
      principal: this.principal,
      active: this.currentActive(),
      teams: [],
      folders: [],
      threads: [],
      archivedThreads: [],
      agents: [],
      members: [],
      messages: [],
      deliveries: [],
      invocations: [],
      runtimeSessions: [],
      runtimeStatus: buildRuntimeStatusProjection({ members: [], messages: [], deliveries: [], invocations: [] }),
      queuedInvocations: [],
      runningInvocations: [],
      failedInvocations: [],
      ...(capabilitySnapshot ?? {}),
      unavailableReason,
    });

    const store = this.store;
    if (!store) return empty("Team runtime has not been started in this PI session.");

    try {
      const principal = this.principal;
      const teams = principal
        ? store.listTeams(false).filter((team) => team.ownerId === principal)
        : store.listTeams(false);
      const active = this.currentActive();
      if (!active) return { ...empty(), principal, teams };

      const team = store.getTeam(active.teamId);
      const thread = store.getThread(active.threadId);
      if (!team || !thread) {
        return { ...empty("The active Team or Thread is missing."), principal, active, teams };
      }

      const visibleMessages = principal
        ? store.listMessagesForPrincipal(active.threadId, principal)
        : store.listMessages(active.threadId);
      const messages = visibleMessages.slice(-limit);
      const visibleIds = new Set(visibleMessages.map(message => message.id));
      const deliveries = store.listDeliveries({ threadId: active.threadId }).filter(delivery => visibleIds.has(delivery.messageId));
      const invocations = store.listInvocations({ threadId: active.threadId }).filter(invocation => visibleIds.has(invocation.sourceMessageId));
      const members = store.listMembers(active.teamId);
      const agents = members.map((member) => store.getAgent(member.agentId)).filter((agent): agent is PersistentAgent => !!agent);
      const folders = store.listThreadFolders(active.teamId);
      const allThreads = store.listThreads(active.teamId, true);
      const runtimeSessions = this.runtimeSessionProjection(active.threadId, members, agents);

      return {
        principal,
        active,
        team,
        thread,
        teams,
        folders,
        threads: allThreads.filter((candidate) => candidate.status !== "archived"),
        archivedThreads: allThreads.filter((candidate) => candidate.status === "archived"),
        agents,
        members,
        messages,
        collections: projectCollections(visibleMessages, invocations),
        processAvailable: invocations.filter(invocation => store.hasInvocationProcess(invocation.id) &&
          (messages.some(message => message.parentInvocationId === invocation.id) || (invocation.outcome?.disposition === "no_action" && messages.some(message => message.id === invocation.sourceMessageId && message.visibility === "team"))))
          .map(invocation => invocation.id),
        activeProcesses: invocations.filter(invocation => invocation.status === "running" && messages.some(message => message.id === invocation.sourceMessageId)).flatMap(invocation => {
          const saved = store.getInvocationProcess(invocation.id);
          return saved ? [{ invocationId: invocation.id, agentId: invocation.targetAgentId, generation: saved.generation, data: saved.data }] : [];
        }),
        deliveries,
        invocations,
        runtimeSessions,
        runtimeStatus: buildRuntimeStatusProjection({ members, messages: visibleMessages, deliveries, invocations }),
        queuedInvocations: invocations.filter(invocation => invocation.status === "queued"),
        runningInvocations: invocations.filter(invocation => invocation.status === "running"),
        failedInvocations: invocations.filter(invocation => invocation.status === "failed" || invocation.status === "dead_letter"),
        ...(capabilitySnapshot ?? {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return empty(message);
    }
  }

  private async handleCommand(args: string, ctx: ExtensionContext) {
    const [command = "status", ...rest] = splitCommandArgs(args.trim());
    if (command === "setup") {
      return this.handleAction("team.runtime.setup", { name: rest.join(" ") || "PI Team" }, ctx);
    }
    if (command === "add") {
      const [name, model, role] = rest;
      return this.handleAction("team.runtime.agent.add", { name, model, role }, ctx);
    }
    if (command === "enter") {
      return this.handleAction("team.runtime.enter", { teamId: rest[0], threadId: rest[1] }, ctx);
    }
    if (command === "web") {
      const webOptions = parseWebCommandArgs(rest);
      if (webOptions.revoke) return this.handleAction("team.runtime.web.revoke", {}, ctx);
      if (webOptions.shareDoctor) {
        return this.handleAction("team.runtime.web.share.doctor", {
          port: webOptions.port,
          shareProvider: webOptions.shareProvider,
          shareUrl: webOptions.shareUrl,
          shareCommand: webOptions.shareCommand,
          shareConfigPath: webOptions.shareConfigPath,
          shareAutoStart: webOptions.shareAutoStart,
        }, ctx);
      }
      return this.handleAction("team.runtime.web", {
        memberLimit: webOptions.memberLimit,
        port: webOptions.port,
        open: webOptions.open,
        share: webOptions.share,
        shareTtlHours: webOptions.shareTtlHours,
        shareProvider: webOptions.shareProvider,
        shareUrl: webOptions.shareUrl,
        shareCommand: webOptions.shareCommand,
        shareConfigPath: webOptions.shareConfigPath,
        shareAutoStart: webOptions.shareAutoStart,
      }, ctx);
    }
    if (command === "doctor") {
      const probe = rest.includes("probe") || rest.includes("--probe");
      const clientId = rest.find((item) => item !== "probe" && item !== "--probe");
      return this.handleAction("team.runtime.doctor", { clientId, probe }, ctx);
    }
    if (command === "leave" || command === "status" || command === "members" || command === "history") {
      return this.handleAction(`team.runtime.${command}`, {}, ctx);
    }
    if (command === "new") return this.handleAction("team.runtime.thread.new", { title: rest.join(" ") || undefined }, ctx);
    if (command === "rename") return this.handleAction("team.runtime.thread.rename", {
      threadId: this.currentActive()?.threadId,
      title: rest.join(" ") || undefined,
    }, ctx);
    if (command === "pending") return this.handleAction("team.runtime.run.pending", {}, ctx);
    if (command === "seal") return this.handleAction("team.runtime.thread.seal", {}, ctx);
    if (command === "memory") {
      const [operation = "list", scopeArg = "team", ...content] = rest;
      const privateMatch = scopeArg.match(/^private:(.+)$/);
      const scope: MemoryScope = privateMatch ? "agent_private" : scopeArg === "thread" ? "thread" : "team";
      if (operation === "write") {
        return this.handleAction("team.runtime.memory.write", {
          scope,
          agentId: privateMatch?.[1],
          message: content.join(" "),
        }, ctx);
      }
      return this.handleAction("team.runtime.memory.list", {
        scope,
        agentId: privateMatch?.[1],
      }, ctx);
    }
    return result(`Unknown /team command: ${command}`, { mode: "team.runtime.command", error: "unknown_command" });
  }

  private startPump(threadId: string, invocations?: Invocation[]): void {
    if (this.closing) return;
    const promise = (async () => {
      if (invocations) await this.runAndPublish(invocations);
      else {
        await this.runPendingAndPublish(threadId);
      }
    })().catch((error) => {
      this.pi.sendMessage({
        customType: "team_runtime_error",
        content: `Team runtime error: ${error instanceof Error ? error.message : String(error)}`,
        display: true,
      }, { triggerTurn: false });
    });
    this.trackOperation(promise);
  }

  private runAndPublish(invocations: Invocation[], signal?: AbortSignal) {
    return this.trackOperation(this.withAbort(signal, async (operationSignal) => {
      const results = await this.requireCoordinator().runInvocations(invocations, operationSignal);
      for (const run of results) this.publish(run.invocation, run.final, run.error);
      return results;
    }));
  }

  private runPendingAndPublish(threadId: string, signal?: AbortSignal) {
    return this.trackOperation(this.withAbort(signal, async (operationSignal) => {
      const results = await this.requireCoordinator().runPending(threadId, operationSignal);
      for (const run of results) this.publish(run.invocation, run.final, run.error);
      return results;
    }));
  }

  private requireThreadInActiveTeam(threadId: string | undefined, teamId: string): TeamThread {
    if (!threadId) throw new TeamRuntimeError("not_found", "threadId is required");
    const thread = this.requireStore().getThread(threadId);
    if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${threadId}`);
    if (thread.teamId !== teamId) {
      throw new TeamRuntimeError("permission_denied", `Thread ${threadId} does not belong to the active Team`);
    }
    return thread;
  }

  private requireThreadsInActiveTeam(threadIds: string[] | undefined, teamId: string): TeamThread[] {
    if (!threadIds?.length) throw new TeamRuntimeError("not_found", "threadIds are required");
    const seen = new Set<string>();
    const threads: TeamThread[] = [];
    for (const threadId of threadIds) {
      if (!threadId || seen.has(threadId)) {
        throw new TeamRuntimeError("conflict", "threadIds must include each Thread exactly once", { threadId });
      }
      seen.add(threadId);
      threads.push(this.requireThreadInActiveTeam(threadId, teamId));
    }
    return threads;
  }

  private requireInvocationInActiveTeam(invocationId: string | undefined, teamId: string): Invocation {
    if (!invocationId) throw new TeamRuntimeError("not_found", "invocationId is required");
    const invocation = this.requireStore().getInvocation(invocationId);
    if (!invocation) throw new TeamRuntimeError("not_found", `Invocation not found: ${invocationId}`);
    const thread = this.requireStore().getThread(invocation.threadId);
    if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${invocation.threadId}`);
    if (thread.teamId !== teamId) {
      throw new TeamRuntimeError("permission_denied", `Invocation ${invocationId} does not belong to the active Team`);
    }
    return invocation;
  }

  private createAndEnterThread(teamId: string, title: string, folderId?: string): { thread: TeamThread; context: HostContext } {
    const store = this.requireStore();
    const now = nowIso();
    const thread = store.createThread({
      id: `thread-${randomUUID()}`,
      teamId,
      folderId,
      title,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const context = this.setCurrentActiveContext(teamId, thread.id);
    return { thread, context };
  }

  private maybeAutoTitleThread(threadId: string, content: string): void {
    const store = this.requireStore();
    const thread = store.getThread(threadId);
    if (!thread || !shouldAutoTitleThread(thread.title)) return;
    const title = titleFromMessage(content);
    if (!title || title === thread.title) return;
    store.renameThread(threadId, title);
  }

  private async withAbort<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forward, { once: true });
    this.abortControllers.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      this.abortControllers.delete(controller);
      signal?.removeEventListener("abort", forward);
    }
  }

  private trackOperation<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise);
    void promise.then(
      () => this.operations.delete(promise),
      () => this.operations.delete(promise),
    );
    return promise;
  }

  private publish(invocation: Invocation, final?: { authorId: string; content: string; seq: number }, error?: string): void {
    if (final) {
      const agent = this.store?.getAgent(final.authorId);
      this.pi.sendMessage({
        customType: "team_agent_message",
        content: `**${agent?.name ?? final.authorId}**\n\n${final.content}`,
        display: true,
        details: { invocationId: invocation.id, threadId: invocation.threadId, seq: final.seq, agentId: final.authorId },
      }, { triggerTurn: false });
    } else if (error && error !== "busy" && invocation.status !== "cancelled") {
      this.pi.sendMessage({
        customType: "team_runtime_error",
        content: `Team member ${invocation.targetAgentId} failed: ${error}`,
        display: true,
        details: { invocationId: invocation.id, threadId: invocation.threadId },
      }, { triggerTurn: false });
    }
  }

  private ensureDefaultWebTeam(ctx: ExtensionContext, requestedLimit?: number): { teamId: string; threadId: string; membersAdded: number; membersTotal: number; created: boolean } {
    const store = this.requireStore();
    const coordinator = this.requireCoordinator();
    const principal = this.requirePrincipal();
    const existingTeam = store.getTeam(DEFAULT_WEB_TEAM_ID);
    const existingThread = store.getThread(DEFAULT_WEB_THREAD_ID);
    let created = false;

    if (!this.currentActive()) {
      if (existingTeam && existingThread && existingTeam.ownerId === principal && existingThread.teamId === existingTeam.id && existingThread.status === "active") {
        this.setCurrentActiveContext(existingTeam.id, existingThread.id);
      } else if (existingTeam && existingTeam.ownerId === principal) {
        const threadId = existingThread ? `${DEFAULT_WEB_THREAD_ID}-${randomUUID()}` : DEFAULT_WEB_THREAD_ID;
        const now = nowIso();
        const thread = store.createThread({
          id: threadId,
          teamId: existingTeam.id,
          title: DEFAULT_WEB_TEAM_NAME,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        this.setCurrentActiveContext(existingTeam.id, thread.id);
        created = true;
      } else {
        const setup = coordinator.setup({
          name: DEFAULT_WEB_TEAM_NAME,
          ownerId: principal,
          title: DEFAULT_WEB_TEAM_NAME,
          teamId: existingTeam ? undefined : DEFAULT_WEB_TEAM_ID,
          threadId: existingThread ? undefined : DEFAULT_WEB_THREAD_ID,
        });
        this.setCurrentActiveContext(setup.team.id, setup.thread.id);
        created = true;
      }
    }

    const active = this.requireActive();
    const membersBeforeList = store.listMembers(active.teamId);
    const membersBefore = membersBeforeList.length;
    const shouldSyncMembers = membersBefore === 0;
    let membersAdded = 0;
    if (shouldSyncMembers) {
      const reusableAgentIds = new Set(membersBeforeList.map((member) => member.agentId));
      const occupiedAgentIds = new Set(
        store.listAgents()
          .map((agent) => agent.id)
          .filter((agentId) => !reusableAgentIds.has(agentId)),
      );
      const existingDefaultMemberBySlot = new Map<string, TeamMember>();
      for (const member of membersBeforeList) {
        const slot = defaultWebProfileSlotForAgentId(member.agentId);
        if (slot && !existingDefaultMemberBySlot.has(slot)) existingDefaultMemberBySlot.set(slot, member);
      }
      const defaults = this.defaultMembersFromModelScope(ctx, requestedLimit, occupiedAgentIds)
        .map((member) => {
          const existing = member.slotId ? existingDefaultMemberBySlot.get(member.slotId) : undefined;
          return existing ? { ...member, agentId: existing.agentId } : member;
        });
      const targetAgentIds = new Set(defaults.map((member) => member.agentId));
      if (active.teamId === DEFAULT_WEB_TEAM_ID) {
        for (const existing of store.listMembers(active.teamId)) {
          if (!targetAgentIds.has(existing.agentId)) store.removeMember(active.teamId, existing.agentId);
        }
      }
      const targetMembersTotal = defaults.length;
      for (let index = 0; index < defaults.length; index++) {
        const member = defaults[index];
        const existingAgent = store.getAgent(member.agentId);
        const existingMember = store.getMember(active.teamId, member.agentId);
        if (!existingMember && store.listMembers(active.teamId).length >= targetMembersTotal) continue;
        const binding = this.defaultWebBinding(existingAgent, member);
        coordinator.addAgent({
          teamId: active.teamId,
          name: existingMember?.name ?? member.name,
          clientId: binding.clientId,
          provider: binding.provider,
          model: binding.model,
          thinking: binding.thinking,
          role: this.defaultRoleLabel(existingMember?.role, member.role),
          roleProfile: this.defaultRoleProfile(existingAgent, member.roleProfile),
          rolePrompt: this.defaultRolePrompt(existingAgent, member.rolePrompt),
          aliases: existingAgent?.aliases ?? this.aliasesWithoutConflicts(member.aliases, store.listMembers(active.teamId), member.agentId),
          agentId: member.agentId,
          runtimePolicy: existingAgent?.runtimePolicy ?? "idle_timeout",
          makeDefault: index === 0 && membersBefore === 0,
        });
      }
      membersAdded = Math.max(0, store.listMembers(active.teamId).length - membersBefore);
    } else {
      const existingDefaultMemberBySlot = new Map<string, TeamMember>();
      for (const member of membersBeforeList) {
        const slot = defaultWebProfileSlotForAgentId(member.agentId);
        if (slot && !existingDefaultMemberBySlot.has(slot)) existingDefaultMemberBySlot.set(slot, member);
      }
      if (existingDefaultMemberBySlot.size > 0) {
        const reusableAgentIds = new Set(membersBeforeList.map((member) => member.agentId));
        const occupiedAgentIds = new Set(
          store.listAgents()
            .map((agent) => agent.id)
            .filter((agentId) => !reusableAgentIds.has(agentId)),
        );
        const defaults = this.defaultMembersFromModelScope(ctx, requestedLimit, occupiedAgentIds)
          .map((member) => {
            const existing = member.slotId ? existingDefaultMemberBySlot.get(member.slotId) : undefined;
            return existing ? { ...member, agentId: existing.agentId } : undefined;
          })
          .filter((member): member is NonNullable<typeof member> => !!member);
        for (const member of defaults) {
          const existingAgent = store.getAgent(member.agentId);
          const existingMember = store.getMember(active.teamId, member.agentId);
          if (!existingMember) continue;
          const binding = this.defaultWebBinding(existingAgent, member);
          coordinator.addAgent({
            teamId: active.teamId,
            name: existingMember.name,
            clientId: binding.clientId,
            provider: binding.provider,
            model: binding.model,
            thinking: binding.thinking,
            role: existingMember.role,
            roleProfile: this.defaultRoleProfile(existingAgent, member.roleProfile),
            rolePrompt: this.defaultRolePrompt(existingAgent, member.rolePrompt),
            aliases: existingAgent?.aliases ?? existingMember.aliases,
            agentId: member.agentId,
            runtimePolicy: existingAgent?.runtimePolicy ?? "idle_timeout",
            makeDefault: false,
          });
        }
      }
    }

    return {
      teamId: active.teamId,
      threadId: active.threadId,
      membersAdded,
      membersTotal: store.listMembers(active.teamId).length,
      created,
    };
  }

  private defaultWebBinding(
    existing: PersistentAgent | undefined,
    fallback: { clientId: string; provider: string; model: string; thinking?: string },
  ): { clientId: string; provider: string; model: string; thinking?: string } {
    if (!existing) return fallback;
    const existingClient = normalizeRuntimeClientId(existing.clientId);
    const fallbackClient = normalizeRuntimeClientId(fallback.clientId);
    const sameDefaultModel = existing.provider === fallback.provider && existing.model === fallback.model;
    const legacyGrokBuildModel = fallbackClient === "grok-build" &&
      (existing.model === fallback.model || existing.model === "grok-4.5") &&
      ["xai", "grok", "grok-build"].includes(existing.provider.toLocaleLowerCase()) &&
      (existingClient === "pi" || existingClient === "grok-build");
    const shouldRepairToFallback = sameDefaultModel || legacyGrokBuildModel;
    return {
      // Earlier Team Web builds wrote the Kimi/Grok default models with
      // clientId=pi. Repair only that self-contradictory default binding while
      // preserving user-selected access methods and models.
      clientId: shouldRepairToFallback && (existingClient !== fallbackClient || existing.clientId !== fallback.clientId)
        ? fallback.clientId
        : existing.clientId ?? fallback.clientId,
      provider: legacyGrokBuildModel ? fallback.provider : existing.provider,
      model: legacyGrokBuildModel ? fallback.model : existing.model,
      thinking: existing.thinking,
    };
  }

  private defaultRolePrompt(existing: PersistentAgent | undefined, next: string | undefined): string | undefined {
    if (!existing?.rolePrompt) return next;
    if (isLegacyDefaultRolePrompt(existing.rolePrompt)) return next;
    return existing.rolePrompt;
  }

  private defaultRoleProfile(existing: PersistentAgent | undefined, next: AgentRoleProfile | undefined): AgentRoleProfile | undefined {
    if (isLegacyDefaultRoleProfile(existing?.roleProfile)) return next;
    if (existing?.roleProfile !== undefined) return existing.roleProfile;
    if (existing?.rolePrompt && !isLegacyDefaultRolePrompt(existing.rolePrompt)) return undefined;
    return next;
  }

  private defaultRoleLabel(existing: string | undefined, next: string): string {
    return defaultRoleLabel(existing, next);
  }

  private defaultMembersFromModelScope(ctx: ExtensionContext, requestedLimit?: number, occupiedAgentIds = new Set<string>()): Array<{
    slotId?: string;
    agentId: string;
    name: string;
    clientId: string;
    provider: string;
    model: string;
    thinking?: string;
    role: string;
    roleProfile?: AgentRoleProfile;
    rolePrompt?: string;
    aliases: string[];
  }> {
    const limit = Math.max(1, Math.min(DEFAULT_WEB_MEMBER_PROFILES.length, requestedLimit ?? DEFAULT_WEB_MEMBER_LIMIT));
    const capabilities = this.runtimeCapabilities(ctx);
    const capabilityByClient = new Map(capabilities.map((capability) => [capability.clientId, capability]));
    const connectorByClient = new Map(inspectRuntimeConnectors({
      capabilities,
      locateCommand: this.options.locateRuntimeCommand,
    }).map((record) => [record.clientId, record]));

    const selected: Array<{ profile?: DefaultWebMemberProfile; option: TeamRuntimeModelOption; clientId: RuntimeClientId }> = [];
    const usedOptionKeys = new Set<string>();
    for (const profile of DEFAULT_WEB_MEMBER_PROFILES) {
      if (selected.length >= limit) break;
      const clientId = normalizeRuntimeClientId(profile.clientId);
      const capability = capabilityByClient.get(clientId);
      const connector = connectorByClient.get(clientId);
      if (clientId !== "pi" && connector?.status === "missing") continue;
      const option = this.pickDefaultModelOption(profile, capability?.modelOptions ?? [], usedOptionKeys);
      if (!option) continue;
      selected.push({ profile, option, clientId: option.clientId ?? clientId });
      usedOptionKeys.add(this.modelOptionKey(option));
    }

    const modelRefCounts = new Map<string, number>();
    for (const item of selected) {
      const modelRef = `${item.option.provider}/${item.option.model}`;
      modelRefCounts.set(modelRef, (modelRefCounts.get(modelRef) ?? 0) + 1);
    }
    const usedNames = new Set<string>();
    const usedIds = new Set<string>();
    return selected.map((item) => {
      const { profile, option, clientId } = item;
      const modelName = this.modelAgentName(option.model, option.thinking);
      const baseName = profile?.name ?? modelName;
      const name = this.uniqueName(baseName, usedNames);
      const agentId = this.uniqueOpaqueId(
        profile?.slotId ?? `default-${option.provider}-${option.model}-${option.thinking ?? "default"}`,
        usedIds,
        occupiedAgentIds,
      );
      const role = profile?.role ?? name.toLocaleLowerCase();
      const modelRef = `${option.provider}/${option.model}`;
      const duplicateModel = (modelRefCounts.get(modelRef) ?? 0) > 1;
      const aliases = [
        ...(profile?.aliases ?? []),
        ...(profile && !duplicateModel ? [modelName] : []),
        ...(duplicateModel ? [] : [option.model, modelRef]),
        ...(option.thinking ? [`${role}-${option.thinking}`] : []),
      ].filter((alias, aliasIndex, all) => all.findIndex((candidate) => candidate.toLocaleLowerCase() === alias.toLocaleLowerCase()) === aliasIndex);
      return {
        ...(profile?.slotId ? { slotId: profile.slotId } : {}),
        agentId,
        name,
        clientId,
        provider: option.provider,
        model: option.model,
        thinking: option.thinking,
        role,
        roleProfile: profile?.roleProfile,
        aliases,
      };
    });
  }

  private pickDefaultModelOption(
    profile: DefaultWebMemberProfile,
    options: TeamRuntimeModelOption[],
    used: Set<string>,
  ): TeamRuntimeModelOption | undefined {
    const clientId = normalizeRuntimeClientId(profile.clientId);
    const clientOptions = options.filter((option) => option.clientId === clientId);
    const exactRefs = new Set(profile.preferredModels.map((value) => value.toLocaleLowerCase()));
    const exact = clientOptions.filter((option) => exactRefs.has(`${option.provider}/${option.model}`.toLocaleLowerCase()));
    const hinted = clientOptions.filter((option) => {
      const provider = option.provider.toLocaleLowerCase();
      const model = option.model.toLocaleLowerCase();
      return profile.providerHints.some((hint) => provider.includes(hint)) ||
        profile.modelHints.some((hint) => model.includes(hint));
    });
    for (const pool of [exact, hinted]) {
      const unused = pool.find((option) => !used.has(this.modelOptionKey(option)));
      if (unused) return unused;
      if (pool[0]) return pool[0];
    }
    return clientId === "pi" ? undefined : clientOptions[0];
  }

  private modelOptionKey(option: Pick<TeamRuntimeModelOption, "clientId" | "provider" | "model" | "thinking">): string {
    return runtimeModelKey(option);
  }

  private async runtimeDoctor(
    ctx: ExtensionContext,
    params: TeamRuntimeActionParams,
    signal?: AbortSignal,
  ): Promise<TeamRuntimeDoctorRecord[]> {
    const capabilities = this.runtimeCapabilities(ctx);
    const records = inspectRuntimeConnectors({
      capabilities,
      clientId: params.clientId,
      locateCommand: this.options.locateRuntimeCommand,
    });
    if (params.probe !== true) return records;

    for (const record of records) {
      if (record.status === "missing") continue;
      record.probe = await this.probeRuntimeConnector(ctx, capabilities, record, params, signal);
      record.status = record.probe.ok ? "ready" : "failed";
      record.nextStep = record.probe.ok
        ? "Real two-turn probe succeeded. This connector is ready for Team Web use."
        : "Probe failed. Fix the connector setup, then rerun doctor with probe=true.";
    }
    return records;
  }

  private async probeRuntimeConnector(
    ctx: ExtensionContext,
    capabilities: readonly TeamRuntimeClientCapability[],
    record: TeamRuntimeDoctorRecord,
    params: TeamRuntimeActionParams,
    signal?: AbortSignal,
  ) {
    const capability = capabilities.find((item) => item.clientId === record.clientId);
    const rawModel = params.model?.trim();
    const splitModel = rawModel?.includes("/") ? parseModel({ model: rawModel }) : undefined;
    const provider = params.provider?.trim() || splitModel?.provider;
    const model = splitModel?.model || rawModel;
    const option = provider && model
      ? capability?.modelOptions.find((candidate) => candidate.provider === provider && candidate.model === model)
      : capability?.modelOptions[0];
    const requestedRef = provider && model ? `${provider}/${model}` : undefined;
    if (!option && !requestedRef) {
      return { ok: false, turns: 0, error: `No model is available for ${record.clientId}` };
    }
    const thinking = params.thinking && option?.thinkingLevels.includes(params.thinking)
      ? params.thinking
      : option?.thinking;
    const turns = Math.max(1, Math.min(5, params.turns ?? 2));
    const now = nowIso();
    const agent: PersistentAgent = {
      id: `doctor-${record.clientId}`,
      name: `${record.label} Doctor`,
      clientId: record.clientId,
      provider: option?.provider ?? provider!,
      model: option?.model ?? model!,
      thinking,
      skillPaths: [],
      aliases: [],
      runtimePolicy: "idle_timeout",
      createdAt: now,
      updatedAt: now,
    };
    let binding: SessionBinding = {
      threadId: `team-runtime-doctor-${record.clientId}`,
      agentId: agent.id,
      piSessionId: randomUUID(),
      cwd: ctx.cwd,
      provider: agent.provider,
      model: agent.model,
      thinking: agent.thinking,
      status: "active" as const,
      generation: 0,
      lastVisibleSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    let lastContent = "";
    try {
      for (let index = 0; index < turns; index++) {
        const prompt = index === 0
          ? "你好"
          : "第二轮：上一轮用户说了什么？只回答上一轮用户原文。";
        const result = await this.requireRuntime().invoke({ agent, binding, prompt, signal });
        lastContent = result.content;
        binding = {
          ...binding,
          piSessionId: result.piSessionId,
          sessionFile: result.sessionFile,
          provider: result.provider,
          model: result.model,
          thinking: result.thinking,
          updatedAt: nowIso(),
        };
      }
      return { ok: true, turns, assistantPreview: compactRuntimeText(lastContent, 72) };
    } catch (error) {
      return {
        ok: false,
        turns,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private availableModelOptions(ctx: ExtensionContext): TeamRuntimeModelOption[] {
    const result: TeamRuntimeModelOption[] = [];
    const seen = new Set<string>();
    const add = (model: RuntimeModelLike | undefined, thinking: string | undefined, scoped: boolean) => {
      if (!model) return;
      const option = createPiModelOption({ model, thinking, scoped });
      if (!option) return;
      const key = this.modelOptionKey(option);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(option);
    };

    const scopedModels = ctx.scopedModels ?? [];
    for (const item of scopedModels) add(item.model, item.thinkingLevel, true);
    if (result.length > 0) return result;

    for (const item of this.enabledModelsFromSettings(ctx)) add(item.model, item.thinking, true);
    if (result.length > 0) return result;

    for (const model of ctx.modelRegistry?.getAvailable?.() ?? []) add(model, undefined, false);
    if (result.length > 0) return result;

    add(ctx.model, ctx.thinkingLevel, false);
    return result;
  }

  private runtimeCapabilities(ctx: ExtensionContext): TeamRuntimeClientCapability[] {
    return buildRuntimeCapabilities(this.availableModelOptions(ctx), this.localCliModelOptions());
  }

  private capabilitySnapshot(ctx: ExtensionContext): Pick<TeamRuntimeOverlaySnapshot, "modelOptions" | "thinkingLevels" | "runtimeCapabilities"> {
    const runtimeCapabilities = this.runtimeCapabilities(ctx);
    const piCapability = runtimeCapabilities.find((capability) => capability.clientId === "pi");
    return {
      modelOptions: piCapability?.modelOptions ?? [],
      thinkingLevels: [...TEAM_RUNTIME_THINKING_LEVEL_OPTIONS],
      runtimeCapabilities,
    };
  }

  private defaultThinkingLevelsForClient(clientId: RuntimeClientId): string[] {
    if (clientId === "kimi-code") return [...KIMI_CLI_THINKING_LEVEL_OPTIONS];
    if (clientId === "claude-code") return [...CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS];
    if (clientId === "codex-cli") return [...CODEX_CLI_THINKING_LEVEL_OPTIONS];
    if (clientId === "grok-build") return [...GROK_CLI_THINKING_LEVEL_OPTIONS];
    if (clientId === "grok-pi") return [...GROK_PI_THINKING_LEVEL_OPTIONS];
    if (clientId === "kimi-pi") return [""];
    return [...TEAM_RUNTIME_THINKING_LEVEL_OPTIONS];
  }

  private localCliModelOptions(): RuntimeCliModelOptions {
    if (this.options.cliModelOptions) return this.options.cliModelOptions;
    if (!this.shouldDiscoverLocalCliModels()) return {};
    this.cliModelOptions = this.capabilityDiscovery.discover();
    return this.cliModelOptions;
  }

  private shouldDiscoverLocalCliModels(): boolean {
    const setting = process.env.PI_TEAM_DISCOVER_CLI_MODELS;
    if (setting === "0" || setting === "false") return false;
    if (setting === "1" || setting === "true") return true;
    return process.env.VITEST !== "true" && process.env.NODE_ENV !== "test";
  }

  private defaultModelScope(ctx: ExtensionContext): ModelScopeEntry[] {
    const scopedModels = ctx.scopedModels ?? [];
    if (scopedModels.length > 0) {
      return scopedModels.map((item) => ({ model: item.model, thinking: item.thinkingLevel }));
    }

    const settingsModels = this.enabledModelsFromSettings(ctx);
    if (settingsModels.length > 0) return settingsModels;

    return ctx.model
      ? [{ model: ctx.model, thinking: ctx.thinkingLevel }]
      : [];
  }

  private enabledModelsFromSettings(ctx: ExtensionContext): ModelScopeEntry[] {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const settingsPath = join(agentDir, "settings.json");
    if (!existsSync(settingsPath)) return [];
    let enabledModels: unknown;
    try {
      enabledModels = (JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledModels?: unknown }).enabledModels;
    } catch {
      return [];
    }
    if (!Array.isArray(enabledModels)) return [];

    const resolved: ModelScopeEntry[] = [];
    for (const value of enabledModels) {
      if (typeof value !== "string") continue;
      const item = this.resolveSettingsModel(value, ctx);
      if (item) resolved.push(item);
    }
    return resolved;
  }

  private resolveSettingsModel(pattern: string, ctx: ExtensionContext): ModelScopeEntry | undefined {
    let ref = pattern.trim();
    if (!ref) return undefined;

    let thinking: string | undefined;
    const colon = ref.lastIndexOf(":");
    if (colon > 0) {
      const suffix = ref.slice(colon + 1);
      if (THINKING_LEVELS.has(suffix)) {
        thinking = suffix;
        ref = ref.slice(0, colon);
      }
    }

    const slash = ref.indexOf("/");
    const registry = ctx.modelRegistry;
    if (!registry) return undefined;
    if (slash > 0) {
      const provider = ref.slice(0, slash);
      const id = ref.slice(slash + 1);
      try {
        const model = registry.find(provider, id);
        return model ? { model, thinking } : undefined;
      } catch {
        return undefined;
      }
    }

    const matches = registry.getAvailable().filter((model) => model.id === ref || model.name === ref);
    return matches.length === 1 ? { model: matches[0], thinking } : undefined;
  }

  private modelAgentName(modelId: string, thinking?: string): string {
    const normalized = modelId.toLocaleLowerCase();
    const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    const has = (value: string) => parts.includes(value) || normalized.includes(value);
    const suffix = (label: string) => thinking ? `${label}${this.titleCase(thinking)}` : label;
    if (has("luna")) return "Luna";
    if (has("sol")) return "Sol";
    if (has("terra")) return "Terra";
    if (has("grok")) return suffix(`Grok${this.compactVersion(parts)}`);
    if (has("deepseek")) {
      const variant = parts.includes("flash") ? "Flash" : parts.includes("pro") ? "Pro" : "";
      return `Deepseek${variant}`;
    }
    if (has("claude")) return parts.includes("sonnet") ? "Sonnet" : "Claude";
    if (has("gemini")) return "Gemini";
    if (has("qwen")) return "Qwen";
    if (has("kimi")) return "Kimi";
    if (has("gpt")) return `Gpt${this.compactVersion(parts)}`;
    return this.titleCase(parts.find((part) => !/^\d+$/.test(part)) ?? "Agent");
  }

  private compactVersion(parts: string[]): string {
    const digits = parts.filter((part) => /^\d+$/.test(part)).join("");
    return digits.length > 0 ? digits.slice(0, 4) : "";
  }

  private titleCase(value: string): string {
    const clean = value.replace(/[^a-z0-9]+/gi, " ");
    return clean.split(" ").filter(Boolean).map((part) => `${part[0].toLocaleUpperCase()}${part.slice(1)}`).join("");
  }

  private uniqueName(baseName: string, used: Set<string>): string {
    let name = baseName || "Agent";
    let index = 2;
    while (used.has(name.toLocaleLowerCase())) {
      name = `${baseName}${index}`;
      index++;
    }
    used.add(name.toLocaleLowerCase());
    return name;
  }

  private aliasesWithoutConflicts(aliases: string[], members: TeamMember[], updatingAgentId: string): string[] {
    const occupied = new Set<string>();
    for (const member of members) {
      if (member.agentId === updatingAgentId) continue;
      for (const value of [member.name, ...member.aliases]) {
        occupied.add(value.normalize("NFKC").toLocaleLowerCase());
      }
    }
    return aliases.filter((alias) => !occupied.has(alias.normalize("NFKC").toLocaleLowerCase()));
  }

  private uniqueOpaqueId(input: string, used: Set<string>, occupied: ReadonlySet<string> = new Set()): string {
    const base = input.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 110) || "default-agent";
    let id = base;
    let index = 2;
    while (used.has(id) || occupied.has(id)) {
      id = `${base.slice(0, 104)}-${index}`;
      index++;
    }
    used.add(id);
    return id;
  }

  private cloneHostContext(context: HostContext | undefined): HostContext | undefined {
    return context ? { ...context } : undefined;
  }

  private createWebSession(context: HostContext): TeamWebSession {
    const now = this.now();
    const session: TeamWebSession = {
      token: randomToken(),
      context: this.cloneHostContext(context),
      createdAt: now,
      updatedAt: now,
    };
    this.webSessions.set(session.token, session);
    return session;
  }

  private webUrlForToken(port: number, token: string): string {
    return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  }

  private async runWithWebAuth<T>(auth: TeamWebAuth, operation: () => Promise<T>): Promise<T> {
    const slot: ActiveContextSlot = { context: this.cloneHostContext(auth.session.context) };
    return this.activeContextSlot.run(slot, async () => {
      try {
        return await operation();
      } finally {
        auth.session.context = this.cloneHostContext(slot.context);
        if (auth.kind === "local") auth.session.updatedAt = this.now();
      }
    });
  }

  private async startWebUi(
    ctx: ExtensionContext,
    options: {
      port?: number;
      open: boolean;
      share?: boolean;
      shareTtlHours?: number;
      shareProvider?: string;
      shareUrl?: string;
      shareCommand?: string;
      shareConfigPath?: string;
      shareAutoStart?: boolean;
    },
  ): Promise<{ url: string; token: string; opened: boolean; share?: TeamWebShareStartInfo }> {
    const active = this.requireActive();
    const sharePreflight = options.share ? resolveTeamWebShareConfig({
      cwd: ctx.cwd,
      provider: options.shareProvider,
      publicUrl: options.shareUrl,
      command: options.shareCommand,
      configPath: options.shareConfigPath,
      autoStart: options.shareAutoStart,
      localPort: options.port,
    }) : undefined;
    if (sharePreflight?.ok === false) {
      throw new TeamRuntimeError("conflict", describeTeamWebShareDoctor({
        cwd: ctx.cwd,
        provider: options.shareProvider,
        publicUrl: options.shareUrl,
        command: options.shareCommand,
        configPath: options.shareConfigPath,
        autoStart: options.shareAutoStart,
        localPort: options.port,
      }));
    }

    const shareConfig = sharePreflight?.ok ? sharePreflight.config : undefined;
    if (
      options.share &&
      typeof options.port === "number" &&
      (shareConfig?.localPortSource === "local" || shareConfig?.localPortSource === "user") &&
      typeof shareConfig.localPort === "number" &&
      options.port !== shareConfig.localPort
    ) {
      const configPath = shareConfig.localConfigPath ?? shareConfig.userConfigPath ?? "the share config";
      throw new TeamRuntimeError(
        "conflict",
        `Team Web share config requires port ${shareConfig.localPort}, but --port ${options.port} was requested. Use --port ${shareConfig.localPort} or update ${configPath}.`,
      );
    }

    const listenPort = options.share && typeof shareConfig?.localPort === "number" ? shareConfig.localPort : options.port;
    if (options.share && this.webServer && this.webPort && typeof listenPort === "number" && listenPort !== this.webPort) {
      await this.closeWebUiServer();
    }

    if (this.webServer && this.webPort) {
      const session = this.createWebSession(active);
      const url = this.webUrlForToken(this.webPort, session.token);
      this.webToken = session.token;
      this.webUrl = url;
      const share = options.share ? await this.enableWebShare(this.webPort, session, { ...options, cwd: ctx.cwd }) : undefined;
      const opened = options.open ? this.openBrowser(url) : false;
      return { url, token: session.token, opened, share };
    }

    const server = createServer((req, res) => {
      void this.handleWebRequest(req, res, ctx).catch((error) => {
        this.writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      void this.handleChatWebSocketUpgrade(req, socket, head, ctx, webSocketServer);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new TeamRuntimeError("conflict", "Unable to determine Team Web UI port");
    }

    this.webServer = server;
    this.webSocketServer = webSocketServer;
    this.webPort = address.port;
    const session = this.createWebSession(active);
    const url = this.webUrlForToken(address.port, session.token);
    this.webToken = session.token;
    this.webUrl = url;
    const share = options.share ? await this.enableWebShare(address.port, session, { ...options, cwd: ctx.cwd }) : undefined;
    const opened = options.open ? this.openBrowser(url) : false;
    return { url, token: session.token, opened, share };
  }

  private async handleWebRequest(req: IncomingMessage, res: ServerResponse, ctx: ExtensionContext): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/share/qr.svg") {
      const auth = this.authenticateWebRequest(req, url);
      if (!auth || auth.kind !== "local" || !this.webShare || auth.session.token !== this.webShare.localToken) {
        this.writeText(res, 403, "Team Web share QR unavailable");
        return;
      }
      this.writeText(res, 200, this.webShare.qrSvg, "image/svg+xml; charset=utf-8");
      return;
    }
    if (url.pathname === "/share/login") {
      await this.handleShareLoginRequest(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      const auth = this.authenticateWebRequest(req, url);
      if (!auth) {
        this.writeText(res, 403, "Team Web login required");
        return;
      }
      const desktopSharePanel = auth.kind === "local" && this.webShare
        ? this.renderDesktopSharePanel(this.describeActiveWebShare(this.webShare))
        : "";
      this.writeText(res, 200, renderPiWebChatHtml({ desktopSharePanel }), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === "/team") {
      const auth = this.authenticateWebRequest(req, url);
      if (!auth) {
        this.writeText(res, 403, "Team Web login required");
        return;
      }
      this.writeText(res, 200, this.renderTeamWebHtml(auth.kind === "local" ? auth.session.token : undefined), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/share/revoke") {
      const auth = this.authenticateWebRequest(req, url);
      if (!auth || auth.kind !== "local") {
        this.writeJson(res, 403, { error: "local token required" });
        return;
      }
      const revoked = await this.revokeWebShare();
      this.writeJson(res, 200, { ok: true, revoked });
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      this.writeText(res, 404, "Not found");
      return;
    }

    const auth = this.authenticateWebRequest(req, url);
    if (!auth) {
      this.writeJson(res, 403, { error: "invalid token or session" });
      return;
    }

    if (url.pathname.startsWith("/api/chat/")) {
      await this.handleChatApiRequest(req, res, ctx, url, auth);
      return;
    }

    return this.runWithWebAuth(auth, async () => {
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      this.writeJson(res, 200, this.getOverlaySnapshot(80, ctx));
      return;
    }

    if ((req.method === "GET" && url.pathname === "/api/process") ||
        (req.method === "POST" && url.pathname === "/api/process/restore")) {
      const body = req.method === "POST" ? await this.readJsonBody(req) : {};
      const messageId = typeof body.messageId === "string" ? body.messageId : url.searchParams.get("messageId");
      const store = this.store;
      const active = this.currentActive();
      const invocationId = url.searchParams.get("invocationId");
      if (req.method === "GET" && invocationId && store && active && this.principal) {
        const invocation = store.getInvocation(invocationId);
        const source = invocation && store.listMessagesForPrincipal(active.threadId, this.principal)
          .find(message => message.id === invocation.sourceMessageId && message.visibility === "team");
        if (!source || invocation?.threadId !== active.threadId || invocation.status !== "completed" || invocation.outcome?.disposition !== "no_action") {
          this.writeJson(res, 404, { error: "process not found" }); return;
        }
        this.writeJson(res, 200, { process: store.getInvocationProcess(invocationId)?.data ?? null });
        return;
      }
      const final = store && active && this.principal
        ? store.listMessagesForPrincipal(active.threadId, this.principal).find(message => message.id === messageId && message.authorType === "agent")
        : undefined;
      if (!store || !final) { this.writeJson(res, 404, { error: "message not found" }); return; }
      if (req.method === "GET") {
        this.writeJson(res, 200, { process: final.parentInvocationId ? store.getInvocationProcess(final.parentInvocationId)?.data ?? null : null });
        return;
      }
      let recovery = this.processRecoveries.get(final.id);
      if (!recovery) {
        recovery = recoverTurnProcess(store, final.id, { baseUrl: this.options.piWebBaseUrl,
          sessionRoot: this.options.sessionDir?.(ctx.cwd), signal: this.processRecoveryController.signal });
        this.processRecoveries.set(final.id, recovery);
      }
      try {
        const process = await recovery;
        if (this.authenticateWebRequest(req, url)?.session !== auth.session) { this.writeJson(res, 403, { error: "session expired" }); return; }
        this.writeJson(res, 200, { process });
      } catch {
        this.writeJson(res, 503, { error: "历史过程暂时无法读取，原回答未更改。" });
      } finally { if (this.processRecoveries.get(final.id) === recovery) this.processRecoveries.delete(final.id); }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await this.readJsonBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        this.writeJson(res, 400, { error: "message is required" });
        return;
      }
      const response = await this.handleAction("team.runtime.send.queued", {
        message, replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && (
      url.pathname === "/api/invocation/cancel" ||
      url.pathname === "/api/invocation/follow" ||
      url.pathname === "/api/invocation/steer"
    )) {
      const body = await this.readJsonBody(req);
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : undefined;
      if (!invocationId) {
        this.writeJson(res, 400, { error: "invocationId is required" });
        return;
      }
      const operation = url.pathname.endsWith("/cancel") ? "cancel" : url.pathname.endsWith("/follow") ? "follow" : "steer";
      const message = typeof body.message === "string" ? body.message : undefined;
      if ((operation === "steer" || operation === "follow") && !message?.trim()) {
        this.writeJson(res, 400, { error: "message is required" });
        return;
      }
      const response = await this.handleAction(`team.runtime.invocation.${operation}`, {
        invocationId,
        message,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread") {
      const body = await this.readJsonBody(req);
      const response = await this.handleAction("team.runtime.thread.new", {
        title: typeof body.title === "string" ? body.title : undefined,
        folderId: typeof body.folderId === "string" ? body.folderId : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/move") {
      const body = await this.readJsonBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      const folderId = typeof body.folderId === "string" && body.folderId.trim() ? body.folderId : undefined;
      if (!threadId) {
        this.writeJson(res, 400, { error: "threadId is required" });
        return;
      }
      const response = await this.handleAction("team.runtime.thread.move", { threadId, folderId }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/enter") {
      const body = await this.readJsonBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      const teamId = typeof body.teamId === "string" ? body.teamId : this.currentActive()?.teamId;
      if (!teamId || !threadId) {
        this.writeJson(res, 400, { error: "teamId and threadId are required" });
        return;
      }
      const response = await this.handleAction("team.runtime.enter", { teamId, threadId }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/rename") {
      const body = await this.readJsonBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      const title = typeof body.title === "string" ? body.title : undefined;
      if (!threadId || !title?.trim()) {
        this.writeJson(res, 400, { error: "threadId and title are required" });
        return;
      }
      const response = await this.handleAction("team.runtime.thread.rename", { threadId, title }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/thread/archive" || url.pathname === "/api/thread/delete")) {
      const body = await this.readJsonBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      if (!threadId) {
        this.writeJson(res, 400, { error: "threadId is required" });
        return;
      }
      const operation = url.pathname.endsWith("/archive") ? "archive" : "delete";
      const response = await this.handleAction(`team.runtime.thread.${operation}`, { threadId }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/restore") {
      const body = await this.readJsonBody(req);
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      if (!threadId) {
        this.writeJson(res, 400, { error: "threadId is required" });
        return;
      }
      const response = await this.handleAction("team.runtime.thread.restore", { threadId }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && (
      url.pathname === "/api/thread/bulk/archive" ||
      url.pathname === "/api/thread/bulk/delete" ||
      url.pathname === "/api/thread/bulk/move"
    )) {
      const body = await this.readJsonBody(req);
      const threadIds = stringArray(body.threadIds);
      if (!threadIds?.length) {
        this.writeJson(res, 400, { error: "threadIds are required" });
        return;
      }
      const folderId = typeof body.folderId === "string" && body.folderId.trim() ? body.folderId : undefined;
      const operation = url.pathname.endsWith("/archive") ? "archive" : url.pathname.endsWith("/delete") ? "delete" : "move";
      const response = await this.handleAction(`team.runtime.thread.bulk.${operation}`, { threadIds, folderId }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/folder") {
      const body = await this.readJsonBody(req);
      const response = await this.handleAction("team.runtime.thread.folder.create", {
        name: typeof body.name === "string" ? body.name : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/folder/reorder") {
      const body = await this.readJsonBody(req);
      const folderIds = stringArray(body.folderIds);
      if (!folderIds) {
        this.writeJson(res, 400, { error: "folderIds are required" });
        return;
      }
      const response = await this.handleAction("team.runtime.thread.folder.reorder", { folderIds }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/folder/rename") {
      const body = await this.readJsonBody(req);
      const response = await this.handleAction("team.runtime.thread.folder.rename", {
        folderId: typeof body.folderId === "string" ? body.folderId : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/thread/folder/delete") {
      const body = await this.readJsonBody(req);
      const response = await this.handleAction("team.runtime.thread.folder.delete", {
        folderId: typeof body.folderId === "string" ? body.folderId : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
        snapshot: this.getOverlaySnapshot(80, ctx),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent") {
      const body = await this.readJsonBody(req);
      const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
      if (!agentId) {
        this.writeJson(res, 400, { error: "agentId is required" });
        return;
      }
      const response = await this.handleAction("team.runtime.agent.update", {
        agentId,
        name: typeof body.name === "string" ? body.name : undefined,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        provider: typeof body.provider === "string" ? body.provider : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        thinking: typeof body.thinking === "string" ? body.thinking : undefined,
        role: typeof body.role === "string" ? body.role : undefined,
        roleDescription: typeof body.roleDescription === "string" ? body.roleDescription : undefined,
        personality: typeof body.personality === "string" ? body.personality : undefined,
        teamStrengths: typeof body.teamStrengths === "string" ? body.teamStrengths : undefined,
        caution: typeof body.caution === "string" ? body.caution : undefined,
        rolePrompt: typeof body.rolePrompt === "string" ? body.rolePrompt : undefined,
      }, ctx);
      this.writeJson(res, 200, {
        ok: !(response.details as { error?: unknown }).error,
        text: response.content[0]?.text ?? "",
        details: response.details,
      });
      return;
    }

    this.writeText(res, 404, "Not found");
    });
  }

  private requireChatBridge(ctx: ExtensionContext): PiWebChatBridge {
    if (!this.chatBridge) {
      this.chatBridge = new PiWebChatBridge({
        baseUrl: this.options.piWebBaseUrl,
        cwd: ctx.cwd,
        now: () => this.now(),
      });
    }
    return this.chatBridge;
  }

  private chatSessionIdForAuth(auth: TeamWebAuth): string | undefined {
    return auth.session.chatSessionId;
  }

  private setChatSessionIdForAuth(auth: TeamWebAuth, sessionId: string | undefined): void {
    auth.session.chatSessionId = sessionId;
    if (auth.kind === "local") auth.session.updatedAt = this.now();
  }

  private chatModelFromBody(body: Record<string, unknown>): PiWebChatModelOption | undefined {
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const rawModel = typeof body.model === "string" ? body.model.trim() : "";
    if (!provider && !rawModel) return undefined;
    if (rawModel.includes("/")) {
      const slash = rawModel.indexOf("/");
      const modelProvider = provider || rawModel.slice(0, slash);
      const modelId = rawModel.slice(slash + 1);
      if (!modelProvider || !modelId) return undefined;
      return {
        key: `${modelProvider}/${modelId}`,
        provider: modelProvider,
        model: modelId,
      };
    }
    if (!provider || !rawModel) return undefined;
    return {
      key: `${provider}/${rawModel}`,
      provider,
      model: rawModel,
    };
  }

  private async handleChatApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ExtensionContext,
    url: URL,
    auth: TeamWebAuth,
  ): Promise<void> {
    const bridge = this.requireChatBridge(ctx);

    if (req.method === "GET" && url.pathname === "/api/chat/snapshot") {
      const requestedSessionId = url.searchParams.get("sessionId")?.trim();
      const snapshot = await bridge.snapshot(requestedSessionId || this.chatSessionIdForAuth(auth));
      if (!requestedSessionId) this.setChatSessionIdForAuth(auth, snapshot.activeSessionId);
      this.writeJson(res, 200, snapshot);
      return;
    }

    if (req.method !== "POST") {
      this.writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const body = await this.readJsonBody(req);
    const requestedSessionId = typeof body.sessionId === "string" && body.sessionId.trim()
      ? body.sessionId.trim()
      : this.chatSessionIdForAuth(auth);

    if (url.pathname === "/api/chat/session/new") {
      const snapshot = await bridge.createSession({
        model: this.chatModelFromBody(body),
        thinkingLevel: typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined,
      });
      this.setChatSessionIdForAuth(auth, snapshot.activeSessionId);
      this.writeJson(res, 200, { ok: true, snapshot });
      return;
    }

    if (!requestedSessionId && url.pathname !== "/api/chat/session/switch") {
      this.writeJson(res, 400, { error: "sessionId is required" });
      return;
    }

    if (url.pathname === "/api/chat/session/switch") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (!sessionId) {
        this.writeJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const snapshot = await bridge.switchSession(sessionId);
      this.setChatSessionIdForAuth(auth, snapshot.activeSessionId);
      this.writeJson(res, 200, { ok: true, snapshot });
      return;
    }

    if (url.pathname === "/api/chat/send" || url.pathname === "/api/chat/follow" || url.pathname === "/api/chat/steer") {
      const message = typeof body.message === "string" ? body.message : "";
      const mode = url.pathname.endsWith("/follow")
        ? "followUp"
        : url.pathname.endsWith("/steer")
          ? "steer"
          : "send";
      const snapshot = await bridge.send({
        sessionId: requestedSessionId!,
        text: message,
        mode,
      });
      this.setChatSessionIdForAuth(auth, snapshot.activeSessionId);
      this.writeJson(res, 200, { ok: true, snapshot });
      return;
    }

    if (url.pathname === "/api/chat/stop") {
      const snapshot = await bridge.stop(requestedSessionId!);
      this.setChatSessionIdForAuth(auth, snapshot.activeSessionId);
      this.writeJson(res, 200, { ok: true, snapshot });
      return;
    }

    if (url.pathname === "/api/chat/session/config") {
      const snapshot = await bridge.setConfig({
        sessionId: requestedSessionId!,
        model: this.chatModelFromBody(body),
        thinkingLevel: typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined,
      });
      this.setChatSessionIdForAuth(auth, snapshot.activeSessionId);
      this.writeJson(res, 200, { ok: true, snapshot });
      return;
    }

    this.writeJson(res, 404, { error: "not_found" });
  }

  private async handleChatWebSocketUpgrade(
    req: IncomingMessage,
    socket: any,
    head: Buffer,
    ctx: ExtensionContext,
    webSocketServer: WebSocketServer,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/chat/events") {
      socket.destroy();
      return;
    }
    const auth = this.authenticateWebRequest(req, url);
    if (!auth) {
      socket.destroy();
      return;
    }
    const streamId = url.searchParams.get("streamId")?.trim() || url.searchParams.get("sessionId")?.trim() || this.chatSessionIdForAuth(auth) || "__global__";
    const afterCursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
    if (streamId !== "__global__" && url.searchParams.get("scope") !== "team") this.setChatSessionIdForAuth(auth, streamId);
    const bridge = this.requireChatBridge(ctx);

    webSocketServer.handleUpgrade(req, socket, head, (client) => {
      let unsubscribe = () => {};
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const cleanup = () => {
        closed = true;
        unsubscribe();
        if (expiryTimer) clearTimeout(expiryTimer);
        this.shareSocketClosers.delete(close);
      };
      const close = () => {
        cleanup();
        client.close(1008, "Authorization expired");
        const timer = setTimeout(() => client.terminate(), 1_000);
        timer.unref?.();
        client.once("close", () => clearTimeout(timer));
      };
      const authorized = () => {
        if (closed) return false;
        const current = this.authenticateWebRequest(req, url);
        if (current?.session !== auth.session) { close(); return false; }
        return true;
      };
      const checkExpiry = () => {
        if (auth.kind !== "share" || !authorized()) return;
        expiryTimer = setTimeout(checkExpiry, Math.max(1, Math.min(60_000, auth.session.expiresAt - this.now())));
        expiryTimer.unref?.();
      };
      if (auth.kind === "share") { this.shareSocketClosers.add(close); checkExpiry(); }
      unsubscribe = bridge.subscribe(streamId, Number.isFinite(afterCursor) ? afterCursor : 0, (event) => {
        if (!authorized()) return;
        if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
      });
      if (closed) unsubscribe();
      client.on("message", authorized);
      client.on("close", cleanup);
      client.on("error", cleanup);
    });
  }

  private async enableWebShare(
    localPort: number,
    localSession: TeamWebSession,
    options: {
      cwd: string;
      shareTtlHours?: number;
      shareProvider?: string;
      shareUrl?: string;
      shareCommand?: string;
      shareConfigPath?: string;
      shareAutoStart?: boolean;
    },
  ): Promise<TeamWebShareStartInfo> {
    await this.revokeWebShare();
    const resolved = resolveTeamWebShareConfig({
      cwd: options.cwd,
      provider: options.shareProvider,
      publicUrl: options.shareUrl,
      command: options.shareCommand,
      configPath: options.shareConfigPath,
      autoStart: options.shareAutoStart,
      localPort,
    });
    if (!resolved.ok) {
      throw new TeamRuntimeError("conflict", describeTeamWebShareDoctor({
        cwd: options.cwd,
        provider: options.shareProvider,
        publicUrl: options.shareUrl,
        command: options.shareCommand,
        configPath: options.shareConfigPath,
        autoStart: options.shareAutoStart,
        localPort,
      }));
    }

    const now = this.now();
    const sessionTtlHours = normalizeShareSessionTtlHours(options.shareTtlHours);
    const loginToken = randomToken();
    const loginUrl = buildTeamWebShareLoginUrl(resolved.config.publicUrl, loginToken);
    this.webShare = {
      config: resolved.config,
      loginToken,
      loginTokenCreatedAt: now,
      loginTokenExpiresAt: now + TEAM_WEB_SHARE_DEFAULT_LOGIN_TTL_MS,
      pin: randomPin(),
      sessionTtlMs: Math.round(sessionTtlHours * 60 * 60 * 1000),
      sessionTtlHours,
      localToken: localSession.token,
      context: this.cloneHostContext(localSession.context),
      qrSvg: this.createShareQrSvg(loginUrl),
      loginUrl,
      sessions: new Map<string, TeamWebShareSession>(),
    };
    try {
      this.webShare.tunnel = await this.startWebShareTunnel(this.webShare, options.cwd, localPort);
      this.webShare.health = await this.checkWebShareHealth(this.webShare, localPort);
    } catch (error) {
      await this.stopWebShareTunnel();
      this.webShare = undefined;
      throw error;
    }
    this.cleanupWebShareSessions(now);
    return this.describeActiveWebShare(this.webShare);
  }

  private async revokeWebShare(): Promise<boolean> {
    const active = Boolean(this.webShare || this.webShareTunnel);
    this.webShare = undefined;
    for (const close of [...this.shareSocketClosers]) close();
    await this.stopWebShareTunnel();
    return active;
  }

  private async startWebShareTunnel(
    share: ActiveTeamWebShare,
    cwd: string,
    localPort: number,
  ): Promise<TeamWebShareTunnelStatus> {
    if (!share.config.autoStart || !share.config.configPath) {
      return {
        started: false,
        message: "Tunnel process is manual/self-hosted; no config path was provided for auto-start.",
      };
    }

    const inspection = inspectTeamWebShareProvider(share.config);
    if (!inspection.configExists) {
      throw new TeamRuntimeError("conflict", describeTeamWebShareDoctor({ cwd, ...share.config, localPort }));
    }
    if (!this.options.shareTunnelRunner && !inspection.binaryFound) {
      throw new TeamRuntimeError("conflict", describeTeamWebShareDoctor({ cwd, ...share.config, localPort }));
    }

    const command = buildTeamWebShareTunnelCommand(share.config);
    const handle = this.options.shareTunnelRunner
      ? await this.options.shareTunnelRunner({ config: share.config, cwd, localPort })
      : await this.spawnWebShareTunnel(command.command, command.args, cwd, command.display);

    this.webShareTunnel = {
      provider: share.config.provider,
      command: handle.command || command.display,
      pid: handle.pid,
      stop: handle.stop,
    };
    return {
      started: true,
      command: this.webShareTunnel.command,
      pid: this.webShareTunnel.pid,
      message: `Tunnel process started: ${this.webShareTunnel.command}${this.webShareTunnel.pid ? ` (pid ${this.webShareTunnel.pid})` : ""}`,
    };
  }

  private async spawnWebShareTunnel(command: string, args: string[], cwd: string, display: string): Promise<TeamWebShareTunnelHandle> {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let onError: (error: Error) => void;
      let onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        child.off("error", onError);
        child.off("exit", onExit);
        fn();
      };
      onError = (error: Error) => settle(() => reject(error));
      onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(() => reject(new Error(`${display} exited immediately${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`)));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      setTimeout(() => settle(resolve), 350);
    });
    child.unref();
    return {
      pid: child.pid,
      command: display,
      stop: () => this.stopChildProcess(child),
    };
  }

  private async stopChildProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async stopWebShareTunnel(): Promise<void> {
    const tunnel = this.webShareTunnel;
    this.webShareTunnel = undefined;
    if (!tunnel) return;
    try {
      await tunnel.stop();
    } catch {
      // Revoke should be best-effort for process cleanup; share state is still cleared.
    }
  }

  private async checkWebShareHealth(share: ActiveTeamWebShare, localPort: number): Promise<TeamWebShareHealth> {
    if (!share.tunnel?.started) {
      return {
        status: "not_checked",
        message: "Tunnel health not checked because the tunnel is in manual mode.",
      };
    }
    if (this.options.shareHealthChecker) {
      return this.options.shareHealthChecker({ share, localPort });
    }

    const publicRoot = await this.fetchStatusWithTimeout(`${share.config.publicUrl}/`);
    const login = await this.fetchStatusWithTimeout(share.loginUrl);
    const ok = publicRoot === 403 && login === 200;
    return {
      status: ok ? "ok" : "failed",
      publicRootStatus: publicRoot,
      loginStatus: login,
      message: ok
        ? "Public tunnel reached Team Web login guard and QR login page."
        : `Unexpected public tunnel health: root HTTP ${publicRoot ?? "unreachable"}, login HTTP ${login ?? "unreachable"}.`,
    };
  }

  private async fetchStatusWithTimeout(url: string): Promise<number | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.status;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private describeActiveWebShare(share: ActiveTeamWebShare): TeamWebShareStartInfo {
    this.cleanupWebShareSessions(this.now());
    const health = share.health ?? { status: "not_checked" as const, message: "Tunnel health has not run yet." };
    return {
      enabled: true,
      provider: share.config.provider,
      publicUrl: share.config.publicUrl,
      loginUrl: share.loginUrl,
      pin: share.pin,
      loginTokenExpiresAt: new Date(share.loginTokenExpiresAt).toISOString(),
      sessionTtlHours: share.sessionTtlHours,
      qrSvg: share.qrSvg,
      qrUrl: `http://127.0.0.1:${share.config.localPort ?? this.webPort ?? 0}/share/qr.svg?token=${encodeURIComponent(share.localToken)}`,
      tunnelStarted: share.tunnel?.started ?? false,
      tunnelCommand: share.tunnel?.command,
      tunnelPid: share.tunnel?.pid,
      tunnelMessage: share.tunnel?.message,
      localTarget: `127.0.0.1:${share.config.localPort ?? this.webPort ?? "<Team Web port>"}`,
      doctor: describeTeamWebShareDoctor({
        cwd: this.cwd,
        provider: share.config.provider,
        publicUrl: share.config.publicUrl,
        command: share.config.command,
        configPath: share.config.configPath,
        autoStart: share.config.autoStart,
        localPort: share.config.localPort ?? this.webPort,
      }),
      activeSessions: share.sessions.size,
      configSource: share.config.configSource,
      health,
      warning: share.config.httpWarning,
    };
  }

  private formatWebStartMessage(web: { url: string; share?: TeamWebShareStartInfo }): string {
    const teamUrl = (() => {
      const url = new URL(web.url);
      url.pathname = "/team";
      return url.toString();
    })();
    if (!web.share) return `PI-team 2.0 Chat: ${web.url}\nTeam mode: ${teamUrl}`;
    const lines = [
      `PI-team 2.0 Chat: ${web.url}`,
      `Team mode: ${teamUrl}`,
      "",
      `Mobile share (${web.share.provider}): ${web.share.publicUrl}`,
      web.share.warning ?? "",
      `Login URL: ${web.share.loginUrl}`,
      `PIN: ${web.share.pin}`,
      `QR login token expires: ${web.share.loginTokenExpiresAt}`,
      `Mobile session TTL: ${formatShareTtlHours(web.share.sessionTtlHours)}`,
      "QR: shown inline in the local Team Web share panel.",
      `Tunnel target: ${web.share.localTarget}`,
      `Tunnel: ${web.share.tunnelStarted ? "started" : "manual"}${web.share.tunnelPid ? ` (pid ${web.share.tunnelPid})` : ""}`,
      web.share.tunnelCommand ? `Tunnel command: ${web.share.tunnelCommand}` : "",
      web.share.tunnelMessage ? `Tunnel note: ${web.share.tunnelMessage}` : "",
      `Health: ${web.share.health.status} - ${web.share.health.message}`,
      `Config source: ${web.share.configSource}`,
      "Stop/revoke: /team web --share stop",
    ];
    return lines.filter(Boolean).join("\n");
  }

  private createShareQrSvg(loginUrl: string): string {
    return new QrCodeSvg({
      content: loginUrl,
      padding: 2,
      width: 220,
      height: 220,
      color: "#111111",
      background: "#ffffff",
      ecl: "M",
    }).svg();
  }

  private async handleShareLoginRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const share = this.webShare;
    if (!share) {
      this.writeText(res, 404, "Team Web share is not active");
      return;
    }

    const loginToken = url.searchParams.get("token") ?? "";
    const now = this.now();
    this.cleanupWebShareSessions(now);
    if (!this.isValidShareLoginToken(loginToken, now)) {
      if (req.method === "GET") {
        this.writeText(res, 403, this.renderShareLoginHtml({ error: "This QR login token has expired or was already used." }), "text/html; charset=utf-8");
      } else {
        this.writeJson(res, 403, { error: "invalid_or_expired_login_token" });
      }
      return;
    }

    if (req.method === "GET") {
      this.writeText(res, 200, this.renderShareLoginHtml({
        token: loginToken,
        provider: share.config.provider,
        expiresAt: share.loginTokenExpiresAt,
        sessionTtlHours: share.sessionTtlHours,
      }), "text/html; charset=utf-8");
      return;
    }

    if (req.method !== "POST") {
      this.writeText(res, 405, "Method not allowed");
      return;
    }

    const body = await this.readJsonBody(req);
    const pin = typeof body.pin === "string" ? body.pin.trim() : "";
    const latestNow = this.now();
    if (!this.isValidShareLoginToken(loginToken, latestNow)) {
      this.writeJson(res, 403, { error: "invalid_or_expired_login_token" });
      return;
    }
    if (!constantTimeStringEquals(pin, share.pin)) {
      this.writeJson(res, 403, { error: "invalid_pin" });
      return;
    }

    share.loginToken = undefined;
    const sessionToken = randomToken();
    const session: TeamWebShareSession = {
      token: sessionToken,
      context: this.cloneHostContext(share.context),
      createdAt: latestNow,
      expiresAt: latestNow + share.sessionTtlMs,
    };
    share.sessions.set(sessionToken, session);
    this.writeJson(res, 200, {
      ok: true,
      redirect: "/",
      expiresAt: new Date(session.expiresAt).toISOString(),
    }, {
      "set-cookie": this.buildShareSessionCookie(sessionToken, session.expiresAt),
    });
  }

  private authenticateWebRequest(req: IncomingMessage, url: URL): TeamWebAuth | undefined {
    const headerToken = req.headers["x-team-token"];
    const supplied = url.searchParams.get("token")
      ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
    if (typeof supplied === "string") {
      const session = this.webSessions.get(supplied);
      return session ? { kind: "local", session } : undefined;
    }

    const sessionToken = this.readCookie(req, TEAM_WEB_SHARE_SESSION_COOKIE);
    if (!sessionToken || !this.webShare) return undefined;
    const now = this.now();
    this.cleanupWebShareSessions(now);
    const session = this.webShare.sessions.get(sessionToken);
    if (!session || session.expiresAt <= now) return undefined;
    return { kind: "share", session };
  }

  private isValidShareLoginToken(loginToken: string, now: number): boolean {
    const share = this.webShare;
    if (!share?.loginToken || share.loginTokenExpiresAt <= now) {
      if (share?.loginTokenExpiresAt && share.loginTokenExpiresAt <= now) share.loginToken = undefined;
      return false;
    }
    return constantTimeStringEquals(loginToken, share.loginToken);
  }

  private cleanupWebShareSessions(now: number): void {
    const share = this.webShare;
    if (!share) return;
    if (share.loginToken && share.loginTokenExpiresAt <= now) share.loginToken = undefined;
    for (const [token, session] of share.sessions) {
      if (session.expiresAt <= now) share.sessions.delete(token);
    }
  }

  private buildShareSessionCookie(sessionToken: string, expiresAt: number): string {
    const maxAge = Math.max(0, Math.floor((expiresAt - this.now()) / 1000));
    const secure = this.webShare?.config.publicUrl.startsWith("https://") ? "; Secure" : "";
    return `${TEAM_WEB_SHARE_SESSION_COOKIE}=${sessionToken}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
  }

  private readCookie(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(";")) {
      const [key, ...valueParts] = part.trim().split("=");
      if (key === name) return valueParts.join("=");
    }
    return undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        raw += chunk;
        if (raw.length > 64_000) {
          reject(new TeamRuntimeError("conflict", "Request body is too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          reject(new TeamRuntimeError("conflict", "Request body must be JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  private openBrowser(url: string): boolean {
    try {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  private writeJson(res: ServerResponse, status: number, data: unknown, headers: OutgoingHttpHeaders = {}): void {
    this.writeText(res, status, JSON.stringify(data), "application/json; charset=utf-8", headers);
  }

  private writeText(
    res: ServerResponse,
    status: number,
    text: string,
    contentType = "text/plain; charset=utf-8",
    headers: OutgoingHttpHeaders = {},
  ): void {
    if (res.headersSent) return;
    res.writeHead(status, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(text);
  }

  private renderShareLoginHtml(input: { token?: string; provider?: string; expiresAt?: number; sessionTtlHours?: number; error?: string }): string {
    const expires = input.expiresAt ? new Date(input.expiresAt).toLocaleString() : "";
    const sessionTtl = formatShareTtlHours(input.sessionTtlHours ?? TEAM_WEB_SHARE_DEFAULT_SESSION_TTL_HOURS);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Team Web Mobile Login</title>
  <style>
    :root { color-scheme: dark; --bg:#11100f; --panel:#1d1917; --line:rgba(255,244,232,.16); --text:#fff5eb; --muted:#c7b7a9; --accent:#f1bd6a; --err:#ff897d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding:20px; }
    main { width:min(420px, 100%); border:1px solid var(--line); border-radius:18px; background:var(--panel); padding:20px; box-shadow:0 18px 50px rgba(0,0,0,.28); }
    h1 { margin:0 0 6px; font-size:22px; }
    p { margin:0 0 14px; color:var(--muted); }
    label { display:grid; gap:7px; color:var(--muted); font-weight:800; }
    input { width:100%; border:1px solid var(--line); border-radius:13px; padding:12px; background:#110e0d; color:var(--text); font:inherit; letter-spacing:.12em; text-align:center; }
    button { width:100%; margin-top:12px; border:0; border-radius:13px; padding:12px; background:var(--accent); color:#21120e; font-weight:950; font:inherit; }
    .error { color:var(--err); font-weight:800; }
    .small { font-size:12px; }
  </style>
</head>
<body>
  <main>
    <h1>Team Web 手机登录</h1>
    ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : `<p>${escapeHtml(input.provider ?? "share")} 分享登录。输入电脑端显示的 6 位 PIN，登录后 ${escapeHtml(sessionTtl)} 内可刷新或重连。</p>`}
    ${input.token ? `<form id="login">
      <label>PIN
        <input id="pin" name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" autofocus>
      </label>
      <button type="submit">登录 Team Web</button>
      <p class="small">二维码 token 将在 ${escapeHtml(expires)} 过期，且成功登录后立即失效。</p>
    </form>` : ""}
  </main>
  ${input.token ? `<script>
    const token = ${JSON.stringify(input.token)};
    const form = document.getElementById("login");
    const pin = document.getElementById("pin");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const response = await fetch("/share/login?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: pin.value.trim() }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert(data.error === "invalid_pin" ? "PIN 不正确" : "二维码已失效，请在电脑端重新开启分享。");
        return;
      }
      location.href = "/";
    });
  </script>` : ""}
</body>
</html>`;
  }

  private renderDesktopSharePanel(share: TeamWebShareStartInfo): string {
    const health = `${share.health.status}${share.health.publicRootStatus || share.health.loginStatus ? ` · root ${share.health.publicRootStatus ?? "?"} / login ${share.health.loginStatus ?? "?"}` : ""}`;
    return `<details class="share-panel" id="sharePanel" aria-label="Team Web mobile share" open>
      <summary class="share-summary">
        <span>
          <span class="share-kicker">手机分享</span>
          <span class="share-url">${escapeHtml(share.publicUrl)}</span>
        </span>
      </summary>
      <div class="share-body">
        ${share.warning ? `<div class="share-warning">${escapeHtml(share.warning)}</div>` : ""}
        <div class="share-qr">${inlineShareQrSvg(share.qrSvg)}</div>
        <button class="share-pin" id="sharePinCopy" type="button" data-share-pin="${escapeHtml(share.pin)}">PIN ${escapeHtml(share.pin)}</button>
        <div class="share-meta">token 过期 ${escapeHtml(share.loginTokenExpiresAt)}</div>
        <div class="share-meta">session ${escapeHtml(formatShareTtlHours(share.sessionTtlHours))}</div>
        <div class="share-meta">Tunnel ${escapeHtml(share.tunnelStarted ? "started" : "manual")}</div>
        <div class="share-meta">Health ${escapeHtml(health)}</div>
        <div class="share-actions">
          <button class="tiny-btn" id="shareCopy" type="button" data-share-login-url="${escapeHtml(share.loginUrl)}">复制链接</button>
          <button class="tiny-btn danger" id="shareRevoke" type="button">停止分享</button>
        </div>
      </div>
    </details>`;
  }

  private renderTeamWebHtml(token?: string): string {
    const desktopSharePanel = token && this.webShare ? this.renderDesktopSharePanel(this.describeActiveWebShare(this.webShare)) : "";
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent AI team · PI Team</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#0f0e0d;
      --paper:#171413;
      --paper2:#201b19;
      --sidebar:#2a2623;
      --sidebar2:#221f1d;
      --card:#302b27;
      --card2:#171312;
      --line:rgba(255,244,232,.12);
      --line2:rgba(255,244,232,.20);
      --text:#fff5eb;
      --muted:#c7b7a9;
      --soft:#9d8e82;
      --accent:#d7a48f;
      --accent2:#f1bd6a;
      --me:#6b4034;
      --me2:#7f4b3b;
      --agent-bubble:#27211f;
      --warn:#ffd36b;
      --err:#ff897d;
      --ok:#8ee6a8;
      --shadow:0 18px 60px rgba(0,0,0,.28);
    }
    * { box-sizing: border-box; }
    html, body { height:100%; }
    body {
      margin:0;
      min-height:100vh;
      background:
        radial-gradient(circle at 20% -10%, rgba(241,189,106,.18), transparent 34%),
        radial-gradient(circle at 75% 10%, rgba(215,164,143,.16), transparent 32%),
        linear-gradient(135deg, #100f0e, #15110f 58%, #0f0e0d);
      color:var(--text);
      font:14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow:hidden;
    }
    button, input, textarea, select { font:inherit; }
    button { color:inherit; }
    .app {
      height:100vh;
      min-height:0;
      display:grid;
      grid-template-columns: 392px minmax(0, 1fr) minmax(270px, 304px);
      background:rgba(10,9,8,.58);
      backdrop-filter: blur(18px);
    }
    .left {
      min-height:0;
      overflow:auto;
      background:linear-gradient(180deg, var(--sidebar), var(--sidebar2));
      border-right:1px solid var(--line);
      padding:18px 16px 26px;
    }
    .chat {
      min-width:0;
      min-height:0;
      display:grid;
      grid-template-rows:auto minmax(0, 1fr) auto;
      background:
        radial-gradient(circle at 50% 0%, rgba(215,164,143,.11), transparent 36%),
        var(--paper);
    }
	    .right {
	      min-height:0;
	      overflow:hidden;
	      display:grid;
	      grid-template-columns:minmax(0, 1fr) 38px;
	      gap:10px;
	      align-items:stretch;
	      background:linear-gradient(180deg, rgba(32,27,25,.88), rgba(17,15,14,.98));
	      border-left:1px solid var(--line);
	      padding:14px 8px 18px 12px;
	    }
	    .right-main {
	      min-width:0;
	      min-height:0;
	      display:grid;
	      grid-template-rows:auto minmax(0, 1fr);
	      gap:10px;
	    }
	    .runtime-panel {
	      min-width:0;
	      min-height:0;
	      overflow:auto;
	      display:flex;
	      flex-direction:column;
	      gap:10px;
	      padding-right:2px;
	    }
	    .runtime-head {
	      display:flex;
	      align-items:flex-start;
	      justify-content:space-between;
	      gap:8px;
	      padding:2px 0 0;
	    }
	    .runtime-title { color:#ffe7d5; font-weight:950; font-size:13px; line-height:1.2; }
	    .runtime-sub { color:var(--soft); font-size:11px; line-height:1.25; margin-top:2px; }
	    .runtime-counts { color:var(--muted); font-size:11px; white-space:nowrap; padding-top:1px; }
	    .runtime-section {
	      border:1px solid rgba(255,244,232,.12);
	      border-radius:14px;
	      background:rgba(255,244,232,.045);
	      padding:10px;
	      min-width:0;
	    }
	    .runtime-section-title {
	      display:flex;
	      align-items:center;
	      justify-content:space-between;
	      gap:8px;
	      color:var(--soft);
	      font-size:11px;
	      font-weight:950;
	      letter-spacing:.04em;
	      margin-bottom:7px;
	    }
	    .runtime-list { display:grid; gap:8px; }
	    .runtime-empty { color:var(--soft); font-size:12px; line-height:1.35; }
	    .runtime-item {
	      min-width:0;
	      border-left:3px solid var(--target-color, var(--accent));
	      border-radius:10px;
	      padding:7px 8px;
	      background:rgba(17,14,13,.52);
	    }
	    .runtime-item.active { background:rgba(241,189,106,.07); }
	    .runtime-item.failed { background:rgba(255,111,111,.06); }
	    .runtime-line { display:flex; align-items:center; gap:6px; min-width:0; }
	    .runtime-dot { width:8px; height:8px; flex:0 0 auto; border-radius:999px; background:var(--target-color, var(--accent)); box-shadow:0 0 0 2px rgba(255,244,232,.08); }
	    .runtime-agent { min-width:0; color:#ffe7d5; font-size:12px; font-weight:950; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	    .runtime-state { flex:0 0 auto; color:var(--muted); font-size:11px; font-weight:900; }
	    .runtime-item.active .runtime-state { color:var(--warn); }
	    .runtime-item.done .runtime-state { color:var(--ok); }
	    .runtime-item.failed .runtime-state { color:var(--err); }
	    .runtime-meta { color:var(--soft); font-size:11px; line-height:1.35; margin-top:4px; overflow-wrap:anywhere; }
	    .runtime-source {
	      margin-top:5px;
	      border:1px solid rgba(255,244,232,.10);
	      border-radius:999px;
	      padding:3px 7px;
	      background:rgba(255,244,232,.045);
	      color:var(--muted);
	      font-size:11px;
	      max-width:100%;
	      white-space:nowrap;
	      overflow:hidden;
	      text-overflow:ellipsis;
	      cursor:pointer;
	    }
	    .runtime-source:hover { color:var(--text); border-color:rgba(241,189,106,.32); }
	    .invocation-controls {
	      display:flex;
	      flex-wrap:wrap;
	      gap:6px;
	      margin-top:7px;
	    }
	    .invocation-control {
	      border:1px solid rgba(255,244,232,.16);
	      border-radius:999px;
	      padding:4px 8px;
	      color:var(--muted);
	      background:rgba(255,244,232,.055);
	      font-size:11px;
	      font-weight:950;
	      cursor:pointer;
	    }
	    .invocation-control:hover { color:var(--text); background:rgba(255,244,232,.11); border-color:rgba(241,189,106,.36); }
	    .invocation-control.danger { color:#ff9a9a; border-color:rgba(255,95,95,.25); }
	    .invocation-control.danger:hover { background:rgba(255,95,95,.12); border-color:rgba(255,95,95,.42); }
	    .live-bubble .invocation-controls { margin-top:9px; }
	    .agent-live {
	      margin-top:9px;
	      display:grid;
	      gap:7px;
	    }
	    .agent-live-status { color:var(--soft); font-size:11px; font-weight:900; }
	    .agent-live-text,
	    .agent-live-thinking,
	    .agent-live-tool {
	      color:var(--text);
	      font-size:12px;
	      line-height:1.45;
	      white-space:pre-wrap;
	      overflow-wrap:anywhere;
	    }
	    .agent-live-thinking { color:#baaefc; }
	    .agent-live-tool {
	      color:#9fdac0;
	      border-top:1px solid rgba(255,244,232,.08);
	      padding-top:7px;
	    }
    .turn-disclosure { min-width:0; border-top:1px solid var(--line); white-space:normal; }
    .turn-disclosure > summary { cursor:pointer; padding:9px 0; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
    .turn-disclosure > summary:focus-visible { outline:2px solid var(--accent2); outline-offset:2px; }
    .turn-disclosure > .disclosure-body { max-height:300px; overflow:auto; padding:0 0 10px; overscroll-behavior:contain; }
    .tools-disclosure > .disclosure-body { max-height:400px; }
    .tool-disclosure > summary { color:#9fdac0; }
    .answer-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.6; }
    .answer-text.is-collapsed { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:6; max-height:9.6em; overflow:hidden; }
    .answer-actions { display:flex; align-items:center; gap:12px; margin-top:8px; min-height:28px; }
    .answer-toggle { padding:4px 0; border:0; border-radius:0; background:none; color:var(--accent2); cursor:pointer; font-size:12px; text-align:left; }
    .answer-actions .copy-message { position:static; margin-left:auto; flex:0 0 auto; }
    .turn-bubble, .bubble.live-bubble.turn-bubble { padding-bottom:13px; white-space:normal; }
    .turn-alert { color:var(--err); font-size:12px; line-height:1.5; margin:8px 0; overflow-wrap:anywhere; }
    .turn-source { color:var(--soft); font-size:12px; margin-bottom:8px; }
    .process-history { color:var(--muted); font-size:12px; line-height:1.5; margin:8px 0; overflow-wrap:anywhere; }
    .process-history button { margin:4px 0; padding:6px 0; color:var(--accent2); background:transparent; border:0; cursor:pointer; }
    .answer-process-text { white-space:pre-wrap; overflow-wrap:anywhere; }
    .turn-bubble [hidden] { display:none !important; }
    .msg-row:not(.me) { width:100%; }
	    .steer-panel {
	      position:fixed;
	      z-index:35;
	      right:18px;
	      top:88px;
	      width:min(390px, calc(100vw - 24px));
	      padding:12px;
	      border:1px solid var(--line2);
	      border-radius:14px;
	      background:#171312;
	      box-shadow:0 22px 54px rgba(0,0,0,.42);
	    }
	    .steer-panel[hidden] { display:none; }
	    .steer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
	    .steer-title { min-width:0; color:#ffe7d5; font-weight:950; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	    .steer-target { color:var(--muted); font-size:12px; margin-bottom:8px; }
	    .steer-input { min-height:104px; resize:vertical; line-height:1.45; }
	    .steer-actions { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:9px; }
	    .steer-note { min-width:0; color:var(--soft); font-size:12px; }
	    .rail-column {
	      min-height:0;
	      display:flex;
	      flex-direction:column;
	      align-items:center;
	      border-left:1px solid rgba(255,244,232,.09);
	      padding-left:6px;
	    }
    .side-brand { display:flex; gap:12px; align-items:center; margin:2px 2px 16px; }
    .brand-mark {
      width:42px;
      height:42px;
      border-radius:16px;
      display:grid;
      place-items:center;
      background:#140f0e;
      border:1px solid var(--line2);
      box-shadow:var(--shadow);
      font-size:23px;
    }
    .brand-title { font-size:18px; font-weight:900; letter-spacing:-.03em; }
    .brand-sub { color:var(--muted); font-size:12px; }
    h1 { font-size:24px; margin:0; letter-spacing:-.035em; }
    h2 { font-size:12px; margin:18px 4px 10px; color:var(--muted); font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    .muted { color:var(--muted); }
    .soft { color:var(--soft); }
    ul { list-style:none; padding:0; margin:0; }
    .section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:18px 4px 10px; }
    .section-head h2 { margin:0; }
    .section-actions { display:flex; align-items:center; gap:6px; }
    .tiny-btn {
      border:1px solid var(--line);
      background:rgba(255,244,232,.05);
      color:var(--muted);
      border-radius:10px;
      padding:5px 8px;
      cursor:pointer;
      font-size:12px;
      font-weight:850;
    }
    .tiny-btn:hover { color:var(--text); background:rgba(255,244,232,.09); }
    .tiny-btn.active { color:#21120e; border-color:rgba(241,189,106,.70); background:var(--accent2); }
    .tiny-btn.danger { color:#ff9a9a; }
    .bulk-bar {
      display:grid;
      grid-template-columns:1fr auto auto auto auto;
      gap:6px;
      align-items:center;
      margin:0 0 10px;
      padding:8px;
      border:1px solid var(--line);
      border-radius:12px;
      background:rgba(255,244,232,.045);
    }
    .bulk-bar[hidden] { display:none; }
    .bulk-count { color:var(--muted); font-size:12px; font-weight:850; }
    .toolbar { display:flex; gap:8px; align-items:center; margin:10px 0 12px; }
    .new-thread {
      flex:1;
      border:0;
      border-radius:14px;
      padding:10px 12px;
      background:linear-gradient(135deg, var(--accent2), #e39773);
      color:#21120e;
      font-weight:900;
      cursor:pointer;
      box-shadow:0 12px 28px rgba(227,151,115,.22);
    }
    .icon-btn, .ghost-btn {
      border:1px solid var(--line2);
      background:rgba(255,244,232,.06);
      color:var(--text);
      border-radius:14px;
      padding:9px 11px;
      cursor:pointer;
    }
    .icon-btn:hover, .ghost-btn:hover { background:rgba(255,244,232,.10); border-color:rgba(255,244,232,.32); }
    .search {
      width:100%;
      margin-bottom:10px;
      color:var(--text);
      background:#171312;
      border:1px solid var(--line);
      border-radius:14px;
      padding:10px 12px;
      outline:none;
    }
    .search:focus, input:focus, textarea:focus, select:focus {
      border-color:rgba(241,189,106,.72);
      box-shadow:0 0 0 3px rgba(241,189,106,.13);
    }
    .thread-row {
      width:100%;
      text-align:left;
      display:grid;
      grid-template-columns:1fr auto;
      gap:8px;
      border:1px solid transparent;
      background:transparent;
      border-radius:16px;
      padding:11px 10px;
      cursor:pointer;
      margin-bottom:5px;
      color:var(--text);
    }
    .thread-row.organize { grid-template-columns:auto 1fr auto; }
    .thread-row:hover { background:rgba(255,244,232,.06); }
    .thread-row.active { background:rgba(241,189,106,.12); border-color:rgba(241,189,106,.30); }
    .thread-row.archived { opacity:.82; }
    .thread-check { width:16px; height:16px; accent-color:#f1bd6a; align-self:center; }
    .thread-name { font-weight:850; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .thread-meta { color:var(--soft); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
    .thread-pins { display:flex; align-items:center; justify-content:flex-end; gap:4px; padding-top:3px; }
    .pin { width:9px; height:9px; border-radius:999px; display:block; box-shadow:0 0 0 2px rgba(255,255,255,.10); }
    .thread-section { margin-bottom:6px; }
    .folder-head {
      display:grid;
      grid-template-columns:auto 1fr auto auto auto auto auto;
      gap:6px;
      align-items:center;
      padding:6px 4px;
      color:var(--muted);
    }
    .folder-head.drop-target { border-radius:12px; outline:1px dashed rgba(241,189,106,.38); background:rgba(241,189,106,.07); }
    .folder-toggle {
      width:22px;
      height:22px;
      border:0;
      background:transparent;
      color:var(--muted);
      cursor:pointer;
      font-size:12px;
    }
    .folder-name {
      min-width:0;
      border:1px solid transparent;
      background:transparent;
      color:var(--text);
      border-radius:8px;
      padding:5px 6px;
      font-weight:900;
      outline:none;
    }
    .folder-name:focus {
      background:#171312;
      border-color:rgba(241,189,106,.55);
      box-shadow:0 0 0 3px rgba(241,189,106,.10);
    }
    .folder-count { color:var(--soft); font-size:12px; padding-right:4px; }
    .folder-list[hidden] { display:none; }
    .folder-list { padding-left:12px; border-left:1px solid rgba(255,244,232,.08); margin-left:11px; }
    .folder-list.drop-target { border-left-color:rgba(241,189,106,.70); background:rgba(241,189,106,.05); border-radius:10px; }
    .context-menu {
      position:fixed;
      z-index:20;
      min-width:142px;
      padding:6px;
      border:1px solid var(--line2);
      border-radius:12px;
      background:#171312;
      box-shadow:0 16px 42px rgba(0,0,0,.34);
    }
    .context-menu[hidden] { display:none; }
    .menu-item {
      width:100%;
      text-align:left;
      border:0;
      border-radius:9px;
      padding:9px 10px;
      background:transparent;
      color:var(--text);
      cursor:pointer;
      font-weight:850;
    }
    .menu-item:hover { background:rgba(255,244,232,.10); }
    .menu-item.danger { color:#ff9a9a; }
    .menu-item.danger:hover { background:rgba(255,95,95,.12); }
    .move-panel {
      position:fixed;
      z-index:30;
      left:50%;
      top:90px;
      width:min(360px, calc(100vw - 24px));
      transform:translateX(-50%);
      padding:12px;
      border:1px solid var(--line2);
      border-radius:14px;
      background:#171312;
      box-shadow:0 22px 54px rgba(0,0,0,.42);
    }
    .move-panel[hidden] { display:none; }
    .move-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
    .move-title { font-weight:900; }
    .move-list { display:grid; gap:6px; max-height:260px; overflow:auto; }
    .move-option {
      border:1px solid var(--line);
      border-radius:10px;
      padding:9px 10px;
      background:rgba(255,244,232,.045);
      color:var(--text);
      cursor:pointer;
      text-align:left;
      font-weight:850;
    }
    .move-option:hover { background:rgba(255,244,232,.10); }
    .move-create { display:grid; grid-template-columns:1fr auto; gap:8px; margin-top:10px; }
    .move-create input {
      min-width:0;
      color:var(--text);
      background:#110e0d;
      border:1px solid var(--line);
      border-radius:10px;
      padding:9px 10px;
      outline:none;
    }
    .empty-list { color:var(--soft); padding:12px 8px; }
    .member-card {
      background:rgba(48,43,39,.78);
      border:1px solid var(--line);
      border-radius:20px;
      margin:0 0 12px;
      overflow:hidden;
      box-shadow:0 12px 34px rgba(0,0,0,.16);
    }
    .member-head { display:grid; grid-template-columns:46px 1fr auto; gap:10px; padding:12px; align-items:center; }
    .avatar {
      width:42px;
      height:42px;
      display:grid;
      place-items:center;
      border-radius:50%;
      color:#fff;
      border:2px solid rgba(255,248,240,.92);
      box-shadow:0 0 0 3px var(--member-color, #d7a48f), 0 8px 20px rgba(0,0,0,.22);
      font-weight:950;
      background:var(--member-color, #d7a48f);
    }
    .member-title { min-width:0; }
    .mention {
      color:#ffe9da;
      background:transparent;
      border:0;
      padding:0;
      cursor:pointer;
      font-size:17px;
      font-weight:950;
      display:block;
      max-width:100%;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      text-align:left;
    }
    .binding { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .member-badge { font-size:11px; color:#1d120e; background:var(--member-color, var(--accent2)); border-radius:999px; padding:4px 7px; font-weight:900; }
    .member-actions { display:grid; justify-items:end; gap:7px; }
    .member-toggle {
      border:1px solid rgba(255,244,232,.20);
      background:rgba(255,244,232,.06);
      color:var(--text);
      border-radius:999px;
      padding:5px 9px;
      font-size:12px;
      font-weight:900;
      cursor:pointer;
    }
    .member-toggle:hover { background:rgba(255,244,232,.12); border-color:rgba(255,244,232,.32); }
    .member-card.open .member-toggle { background:var(--accent2); color:#21120e; border-color:transparent; }
    .profile-form { background:var(--card2); border-top:1px solid var(--line); padding:12px; display:grid; gap:9px; }
    .profile-form[hidden] { display:none; }
    label { display:grid; gap:5px; color:var(--soft); font-size:12px; font-weight:800; }
    input, textarea, select {
      width:100%;
      min-width:0;
      color:var(--text);
      background:#110e0d;
      border:1px solid var(--line);
      border-radius:12px;
      padding:9px 10px;
      outline:none;
    }
    select { appearance:auto; }
    .profile-grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
    .prompt-area { min-height:78px; resize:vertical; line-height:1.46; }
    .save-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .save { color:#21120e; background:var(--accent2); border:0; border-radius:12px; padding:8px 12px; cursor:pointer; font-weight:900; }
    .save:disabled { opacity:.55; cursor:wait; }
    .note { color:var(--soft); font-size:12px; min-height:18px; }
    .warn { color:var(--warn); }
    .err { color:var(--err); }
    .ok { color:var(--ok); }
    .chat-header {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:18px;
      padding:22px 28px 16px;
      border-bottom:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,244,232,.05), rgba(255,244,232,0));
    }
    .chat-title { display:flex; align-items:center; gap:13px; min-width:0; }
    .chat-logo { width:50px; height:50px; border-radius:19px; display:grid; place-items:center; background:#100d0c; border:1px solid var(--line2); box-shadow:var(--shadow); font-size:27px; }
    .subtitle { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
    .status {
      padding:8px 12px;
      border:1px solid var(--line2);
      border-radius:999px;
      color:var(--muted);
      background:rgba(255,244,232,.05);
      white-space:nowrap;
      font-size:12px;
    }
    .share-panel {
      min-width:0;
      border:1px solid rgba(241,189,106,.28);
      border-radius:14px;
      background:rgba(241,189,106,.075);
      overflow:hidden;
    }
    .share-summary {
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:8px;
      min-width:0;
      padding:10px;
      cursor:pointer;
      list-style:none;
    }
    .share-summary::-webkit-details-marker { display:none; }
    .share-summary:after {
      content:"▾";
      flex:0 0 auto;
      color:var(--soft);
      font-size:11px;
      line-height:1.4;
      transition:transform .14s;
    }
    .share-panel:not([open]) .share-summary:after { transform:rotate(-90deg); }
    .share-kicker { display:block; color:#ffe2a4; font-size:11px; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
    .share-url { display:block; margin-top:2px; color:var(--text); font-size:12px; font-weight:900; overflow-wrap:anywhere; }
    .share-body {
      display:grid;
      gap:7px;
      padding:0 10px 10px;
    }
    .share-warning { margin-top:5px; color:var(--warn); font-size:12px; line-height:1.35; }
    .share-meta { color:var(--muted); font-size:11px; line-height:1.3; overflow-wrap:anywhere; }
    .share-qr { width:min(190px, 100%); aspect-ratio:1; display:grid; place-items:center; justify-self:center; border-radius:12px; background:#fff; padding:12px; overflow:visible; }
    .share-qr svg { display:block; width:100%; height:100%; }
    .share-pin {
      justify-self:center;
      border:1px solid rgba(241,189,106,.34);
      border-radius:999px;
      padding:7px 12px;
      color:#ffe7d5;
      background:rgba(241,189,106,.10);
      font-size:14px;
      font-weight:950;
      letter-spacing:.04em;
      cursor:pointer;
      white-space:nowrap;
    }
    .share-pin:hover { background:rgba(241,189,106,.16); border-color:rgba(241,189,106,.52); }
    .share-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; justify-items:stretch; }
    .chat-scroll { min-height:0; overflow:auto; padding:26px 28px 28px; }
    .messages { display:flex; flex-direction:column; gap:18px; }
    .msg-row { display:flex; gap:10px; align-items:flex-start; max-width:86%; }
    .msg-row.me { align-self:flex-end; flex-direction:row-reverse; }
    .msg-row.rail-focus .bubble { outline:2px solid rgba(241,189,106,.88); box-shadow:0 0 0 5px rgba(241,189,106,.14), 0 12px 34px rgba(0,0,0,.18); }
    .msg-row[data-lineage-focus="true"] .bubble { outline:2px solid rgba(79,141,247,.88); box-shadow:0 0 0 5px rgba(79,141,247,.16), 0 12px 34px rgba(0,0,0,.18); }
    .msg-row.live { opacity:.88; }
    .msg-avatar { width:36px; height:36px; flex:0 0 auto; border-radius:50%; display:grid; place-items:center; background:var(--member-color, var(--accent)); color:#fff; border:2px solid rgba(255,248,240,.92); box-shadow:0 0 0 3px var(--member-color, var(--accent)), 0 7px 16px rgba(0,0,0,.22); font-weight:950; }
    .msg-row.me .msg-avatar { background:#a86450; box-shadow:0 0 0 3px rgba(168,100,80,.72), 0 7px 16px rgba(0,0,0,.22); }
    .msg-content { min-width:0; max-width:100%; }
    .msg-head { display:flex; gap:8px; align-items:center; color:var(--soft); font-size:12px; margin:0 0 5px 2px; }
    .msg-row.me .msg-head { justify-content:flex-end; margin-right:2px; }
    .msg-author { color:#ffe7d5; font-weight:900; }
    .link-pills { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 7px 2px; max-width:100%; }
    .msg-row.me .link-pills { justify-content:flex-end; margin-left:0; margin-right:2px; }
    .relation-pill {
      max-width:100%;
      min-width:0;
      border:1px solid rgba(255,244,232,.16);
      border-radius:999px;
      padding:4px 8px;
      color:var(--muted);
      background:rgba(255,244,232,.05);
      font-size:12px;
      line-height:1.25;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    button.relation-pill { cursor:pointer; text-align:left; }
    button.relation-pill:hover { color:var(--text); background:rgba(255,244,232,.10); border-color:rgba(241,189,106,.40); }
    .reply-pill { color:#f4ccb9; }
    .handoff-pill { color:#cde9ff; border-color:rgba(79,141,247,.34); background:rgba(79,141,247,.10); }
    .route-pill { color:#ffe2a4; border-color:rgba(241,189,106,.28); background:rgba(241,189,106,.09); }
    .bubble {
      position:relative;
      min-height:52px;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      color:var(--text);
      background:linear-gradient(180deg, rgba(255,244,232,.06), rgba(255,244,232,.03)), var(--agent-bubble);
      border:1px solid var(--line);
      border-radius:20px 20px 20px 6px;
      padding:13px 15px 38px;
      box-shadow:0 12px 34px rgba(0,0,0,.18);
    }
    .bubble-text { min-width:0; }
    .bubble.live-bubble {
      min-height:46px;
      padding-bottom:13px;
      border-style:dashed;
      background:rgba(255,244,232,.045);
      color:var(--muted);
    }
    .copy-message {
      position:absolute;
      right:10px;
      bottom:8px;
      height:24px;
      border:1px solid rgba(255,244,232,.16);
      border-radius:999px;
      padding:0 9px;
      color:var(--soft);
      background:rgba(16,13,12,.54);
      font-size:10px;
      font-weight:950;
      line-height:22px;
      letter-spacing:0;
      cursor:pointer;
      opacity:.76;
      transition:opacity .14s, color .14s, background .14s, border-color .14s, transform .14s;
    }
    .copy-message:hover, .copy-message:focus-visible {
      opacity:1;
      color:var(--text);
      background:rgba(255,244,232,.12);
      border-color:rgba(241,189,106,.46);
      outline:none;
    }
    .copy-message:active { transform:translateY(1px); }
    .copy-message.copied {
      opacity:1;
      color:#c9ffd9;
      background:rgba(79,193,125,.14);
      border-color:rgba(79,193,125,.42);
    }
    .copy-message.failed {
      opacity:1;
      color:#ffd0d0;
      background:rgba(255,107,107,.14);
      border-color:rgba(255,107,107,.42);
    }
    .msg-row.me .bubble { background:linear-gradient(180deg, var(--me2), var(--me)); border-color:rgba(255,210,189,.20); border-radius:20px 20px 6px 20px; }
    .msg-row.me .copy-message { background:rgba(42,27,23,.50); border-color:rgba(255,231,213,.18); }
	    .receipt-dock { display:flex; flex-wrap:wrap; gap:6px; margin:7px 0 0 2px; max-width:100%; }
	    .msg-row.me .receipt-dock { justify-content:flex-end; margin-left:0; margin-right:2px; }
	    .receipt-item {
	      min-width:0;
	      max-width:100%;
	      display:flex;
	      align-items:center;
	      gap:6px;
	      border:1px solid rgba(255,244,232,.12);
	      border-left:3px solid var(--target-color, var(--accent));
	      border-radius:999px;
	      padding:4px 7px;
	      background:rgba(255,244,232,.04);
	      color:var(--soft);
	      font-size:11px;
	      line-height:1.25;
	    }
	    .receipt-dot { width:7px; height:7px; flex:0 0 auto; border-radius:999px; background:var(--target-color, var(--accent)); box-shadow:0 0 0 2px rgba(255,244,232,.09); }
	    .receipt-target { color:#ffe7d5; font-weight:900; white-space:nowrap; }
	    .receipt-state { color:var(--muted); font-weight:900; white-space:nowrap; }
	    .receipt-meta { min-width:0; color:var(--soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
	    .receipt-lineage {
	      border:0;
	      border-left:1px solid rgba(255,244,232,.14);
	      padding:0 0 0 6px;
	      color:#ffe2a4;
	      background:transparent;
	      cursor:pointer;
	      font-size:11px;
	      font-weight:900;
	      white-space:nowrap;
	    }
	    .receipt-lineage:hover { color:var(--text); }
	    .receipt-item.done .receipt-state { color:var(--ok); }
	    .receipt-item.silent .receipt-state { color:var(--soft); }
	    .receipt-item.running .receipt-state, .receipt-item.queued .receipt-state { color:var(--warn); }
	    .receipt-item.failed .receipt-state { color:var(--err); }
    .empty-chat { min-height:58vh; display:grid; place-items:center; text-align:center; color:var(--muted); }
    .empty-chat strong { display:block; font-size:30px; color:var(--text); margin-bottom:8px; letter-spacing:-.035em; }
    .reply-context { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; font-size:12px; }
    .reply-context[hidden] { display:none; }
    .reply-context span { min-width:0; overflow-wrap:anywhere; }
    .reply-context button { width:28px; height:28px; flex:none; }
    .collection-state, .decision-state { font-size:12px; color:var(--muted); margin:6px 0; overflow-wrap:anywhere; }
    .reply-decision { font-size:12px; padding:5px 9px; margin:6px; }
    .silent-turn .turn-source { display:none; }
    .silent-turn .bubble { padding-top:6px; padding-bottom:6px; }
    .composer {
      position:relative;
      border-top:1px solid var(--line);
      padding:16px 28px 20px;
      background:linear-gradient(180deg, rgba(23,20,19,.88), rgba(16,13,12,.98));
    }
    .mention-menu {
      position:absolute;
      left:28px;
      bottom:92px;
      width:min(520px, calc(100% - 114px));
      max-height:310px;
      overflow:auto;
      z-index:15;
      padding:8px;
      border:1px solid var(--line2);
      border-radius:18px;
      background:#211d1b;
      box-shadow:0 18px 50px rgba(0,0,0,.44);
    }
    .mention-menu[hidden] { display:none; }
    .mention-option {
      width:100%;
      display:grid;
      grid-template-columns:40px 1fr;
      gap:10px;
      align-items:center;
      border:0;
      border-radius:13px;
      padding:10px;
      background:transparent;
      color:var(--text);
      cursor:pointer;
      text-align:left;
    }
    .mention-option:hover, .mention-option.active { background:rgba(255,244,232,.10); }
    .mention-option .avatar { width:34px; height:34px; font-size:15px; box-shadow:0 0 0 2px var(--member-color, #d7a48f), 0 6px 12px rgba(0,0,0,.18); }
    .mention-main { font-size:15px; font-weight:950; color:#ffe7d5; }
    .mention-meta, .mention-desc { color:var(--muted); font-size:12px; line-height:1.34; }
    .mention-desc { color:var(--soft); margin-top:2px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    form { display:flex; gap:12px; align-items:flex-end; }
    #message {
      flex:1;
      min-height:58px;
      max-height:170px;
      resize:vertical;
      border-radius:22px;
      padding:16px 18px;
      border-color:rgba(241,189,106,.42);
      background:#110e0d;
      font-size:15px;
    }
    .send { width:58px; height:58px; border:0; border-radius:18px; color:#21120e; background:var(--accent2); cursor:pointer; font-size:24px; display:grid; place-items:center; box-shadow:0 12px 26px rgba(241,189,106,.20); }
    .send:disabled { opacity:.55; cursor:wait; }
    .tip { margin-top:8px; color:var(--soft); font-size:12px; display:flex; justify-content:space-between; gap:10px; }
    .rail-label { flex:0 0 auto; writing-mode:vertical-rl; text-orientation:mixed; color:var(--soft); opacity:.82; font-size:10px; font-weight:900; letter-spacing:.12em; margin:0 0 10px; user-select:none; }
    .message-rail { position:relative; flex:1 1 auto; min-height:0; width:32px; margin:0 auto; }
    .message-rail:before { content:""; position:absolute; left:50%; top:3px; bottom:3px; width:2px; transform:translateX(-50%); border-radius:999px; background:linear-gradient(180deg, rgba(255,244,232,.30), rgba(255,244,232,.08)); }
    .rail-marker {
      position:absolute;
      left:50%;
      width:10px;
      height:10px;
      padding:0;
      border:0;
      border-radius:999px;
      transform:translate(-50%, -50%);
      background:var(--marker-color, #a86450);
      box-shadow:0 0 0 3px rgba(255,244,232,.08), 0 0 18px rgba(0,0,0,.38);
      cursor:pointer;
      transition:width .14s, height .14s, box-shadow .14s, opacity .14s;
    }
    .rail-marker.me { width:13px; height:13px; box-shadow:0 0 0 3px rgba(255,244,232,.16), 0 0 18px rgba(168,100,80,.34); }
    .rail-marker.has-wake { width:14px; height:14px; }
    .rail-marker:hover, .rail-marker:focus-visible { width:18px; height:18px; outline:none; box-shadow:0 0 0 4px rgba(241,189,106,.20), 0 0 24px var(--marker-color, #a86450); }
    .rail-empty { position:absolute; left:50%; top:50%; transform:translate(-50%, -50%); writing-mode:vertical-rl; color:var(--soft); opacity:.72; font-size:11px; white-space:nowrap; }
    @media (max-width: 1180px) {
      .app { grid-template-columns:340px minmax(0, 1fr); }
      .right { display:none; }
      .right:has(.share-panel) {
        display:grid;
        grid-column:1 / -1;
        grid-template-columns:minmax(0, 1fr);
        min-height:auto;
        max-height:260px;
        overflow:auto;
        border-left:0;
        border-top:1px solid var(--line);
        padding:10px 18px;
      }
      .right:has(.share-panel) .right-main { grid-template-rows:auto; }
      .right:has(.share-panel) .runtime-panel,
      .right:has(.share-panel) .rail-column { display:none; }
    }
    @media (max-width: 820px) {
      body { overflow:auto; }
      .app { min-height:100vh; height:auto; grid-template-columns:1fr; }
      .left { max-height:48vh; border-right:0; border-bottom:1px solid var(--line); }
      .chat { min-height:72vh; }
      .chat-header { padding:18px; }
      .share-qr { width:min(180px, 100%); }
      .share-actions { grid-column:1 / -1; grid-template-columns:1fr 1fr; }
      .chat-scroll { padding:18px; }
      .composer { padding:14px 18px 18px; }
      .mention-menu { left:18px; bottom:90px; width:calc(100% - 94px); }
    }
  </style>
</head>
<body>
  <div class="app">
  <aside class="left">
    <div class="side-brand">
      <div class="brand-mark">AI</div>
      <div>
        <div class="brand-title">Agent AI team</div>
        <div class="brand-sub">PI Team · 协作小组</div>
      </div>
    </div>
    <div class="toolbar">
      <button class="new-thread" id="newThread" type="button">＋ 新对话</button>
      <button class="icon-btn" id="refreshBtn" type="button" title="刷新">↻</button>
    </div>
    <input class="search" id="search" placeholder="搜索对话或 Thread ID">
    <div class="section-head">
      <h2>对话</h2>
      <div class="section-actions">
        <button class="tiny-btn" id="organizeMode" type="button">整理</button>
        <button class="tiny-btn" id="newFolder" type="button">＋ 文件夹</button>
      </div>
    </div>
    <div class="bulk-bar" id="bulkBar" hidden>
      <span class="bulk-count" id="bulkCount">已选 0</span>
      <button class="tiny-btn" id="bulkMove" type="button">移动</button>
      <button class="tiny-btn" id="bulkArchive" type="button">归档</button>
      <button class="tiny-btn danger" id="bulkDelete" type="button">删除</button>
      <button class="tiny-btn" id="bulkClear" type="button">清除</button>
    </div>
    <ul id="threads"></ul>
    <h2>角色档案与模型</h2>
    <ul id="members"></ul>
  </aside>
  <main class="chat">
    <header class="chat-header">
      <div class="chat-title">
        <div class="chat-logo">AI</div>
        <div>
          <h1 id="chatTitle">Agent AI team</h1>
          <div class="subtitle" id="summary">加载团队中…</div>
        </div>
      </div>
    </header>
    <div class="chat-scroll" id="chatScroll">
      <ul id="messages"></ul>
    </div>
    <div class="composer">
      <div id="decisionReply" class="reply-context" hidden><span id="decisionReplyLabel"></span><button id="cancelDecisionReply" type="button" title="取消回复" aria-label="取消回复">×</button></div>
      <div class="mention-menu" id="mentionMenu" role="listbox" hidden></div>
      <form id="send">
        <textarea id="message" autocomplete="off" placeholder="@all 让大家一起讨论；也可以 @咪咪 / @跳跳 / @鲸鲸 / @汪汪"></textarea>
        <button class="send" id="button" type="submit" title="Send">➤</button>
      </form>
      <div class="tip"><span>右边是你，左边是团队成员；点左侧成员名会自动插入 @。</span><span id="status">connecting…</span></div>
    </div>
	  </main>
	  <aside class="right">
	    <div class="right-main">
	      ${desktopSharePanel}
	      <section class="runtime-panel" aria-label="团队协作运行态">
	        <div class="runtime-head">
	          <div>
	            <div class="runtime-title">协作运行态</div>
	            <div class="runtime-sub" id="runtimeSub">等待快照…</div>
	          </div>
	          <div class="runtime-counts" id="runtimeCounts"></div>
	        </div>
	        <section class="runtime-section">
	          <div class="runtime-section-title"><span>正在处理</span><span id="runtimeActiveCount"></span></div>
	          <div class="runtime-list" id="runtimeActive"></div>
	        </section>
	        <section class="runtime-section">
	          <div class="runtime-section-title"><span>待处理</span><span id="runtimeQueuedCount"></span></div>
	          <div class="runtime-list" id="runtimeQueued"></div>
	        </section>
	        <section class="runtime-section">
	          <div class="runtime-section-title"><span>等待用户决定</span></div>
	          <div class="runtime-list" id="runtimeWaiting"></div>
	        </section>
	        <section class="runtime-section">
	          <div class="runtime-section-title"><span>最近完成/失败</span><span id="runtimeRecentCount"></span></div>
	          <div class="runtime-list" id="runtimeRecent"></div>
	        </section>
	      </section>
	    </div>
	    <div class="rail-column">
	      <div class="rail-label">发言轨迹</div>
	      <div class="message-rail" id="messageRail" aria-label="消息发言颜色轨"></div>
	    </div>
	  </aside>
  </div>
  <div class="context-menu" id="threadMenu" hidden>
    <button class="menu-item" id="renameThread" type="button">重命名</button>
    <button class="menu-item" id="moveThread" type="button">移动到文件夹</button>
    <button class="menu-item" id="archiveThread" type="button">归档</button>
    <button class="menu-item" id="restoreThread" type="button">恢复</button>
    <button class="menu-item danger" id="deleteThread" type="button">删除</button>
  </div>
  <div class="move-panel" id="movePanel" hidden>
    <div class="move-head">
      <div class="move-title" id="moveTitle">移动对话</div>
      <button class="tiny-btn" id="moveClose" type="button">关闭</button>
    </div>
    <div class="move-list" id="moveFolderList"></div>
    <div class="move-create">
      <input id="moveFolderName" placeholder="新文件夹名称">
      <button class="tiny-btn" id="moveCreate" type="button">新建并移动</button>
    </div>
  </div>
  <div class="steer-panel" id="steerPanel" hidden>
    <div class="steer-head">
      <div class="steer-title" id="steerTitle">Steer Agent</div>
      <button class="tiny-btn" id="steerClose" type="button">关闭</button>
    </div>
    <div class="steer-target" id="steerTarget"></div>
    <textarea class="steer-input" id="steerInput" placeholder="写下要追加给这个 Agent 的方向。提交后会终止当前尝试，并用这条指导重新唤醒它。"></textarea>
    <div class="steer-actions">
      <span class="steer-note" id="steerNote"></span>
      <button class="tiny-btn active" id="steerSubmit" type="button">发送 Steer</button>
    </div>
  </div>
  <script>
    const token = ${JSON.stringify(token ?? "")};
    const defaultMentionProfiles = ${JSON.stringify(DEFAULT_WEB_MEMBER_PROFILES.map((profile) => ({
      slotId: profile.slotId,
      name: profile.name,
      role: profile.role,
      clientId: profile.clientId,
      preferredModels: profile.preferredModels,
      aliases: profile.aliases,
      providerHints: profile.providerHints,
      modelHints: profile.modelHints,
      roleProfile: profile.roleProfile,
    })))};
    const runtimeClientLabels = ${JSON.stringify(TEAM_RUNTIME_CLIENT_LABELS)};
    const fallbackThinkingLevelsByClient = ${JSON.stringify({
      pi: [...TEAM_RUNTIME_THINKING_LEVEL_OPTIONS],
      "kimi-code": [...KIMI_CLI_THINKING_LEVEL_OPTIONS],
      "claude-code": [...CLAUDE_CODE_CLI_THINKING_LEVEL_OPTIONS],
      "codex-cli": [...CODEX_CLI_THINKING_LEVEL_OPTIONS],
      "grok-build": [...GROK_CLI_THINKING_LEVEL_OPTIONS],
      "grok-pi": [...GROK_PI_THINKING_LEVEL_OPTIONS],
      "kimi-pi": [""],
    })};
    const qs = token ? "?token=" + encodeURIComponent(token) : "";
    const statusEl = document.getElementById("status");
    const summaryEl = document.getElementById("summary");
    const chatTitleEl = document.getElementById("chatTitle");
    const threadsEl = document.getElementById("threads");
    const searchEl = document.getElementById("search");
    const membersEl = document.getElementById("members");
	    const messagesEl = document.getElementById("messages");
	    const chatScrollEl = document.getElementById("chatScroll");
	    const messageRailEl = document.getElementById("messageRail");
	    const runtimeSubEl = document.getElementById("runtimeSub");
	    const runtimeCountsEl = document.getElementById("runtimeCounts");
	    const runtimeActiveCountEl = document.getElementById("runtimeActiveCount");
	    const runtimeQueuedCountEl = document.getElementById("runtimeQueuedCount");
	    const runtimeRecentCountEl = document.getElementById("runtimeRecentCount");
	    const runtimeActiveEl = document.getElementById("runtimeActive");
	    const runtimeQueuedEl = document.getElementById("runtimeQueued");
	    const runtimeRecentEl = document.getElementById("runtimeRecent");
	    const form = document.getElementById("send");
    let decisionReply = null;
    const decisionReplyEl = document.getElementById("decisionReply");
    function setDecisionReply(message) {
      decisionReply = message ? { id: message.id, threadId: renderedThreadId } : null;
      decisionReplyEl.hidden = !message;
      text(document.getElementById("decisionReplyLabel"), message ? "回复 @" + memberName(latestSnapshot, message.authorId) + " 的问题 #" + message.seq : "");
      if (message) input.focus();
    }
    document.getElementById("cancelDecisionReply").addEventListener("click", () => setDecisionReply(null));
    const input = document.getElementById("message");
    const button = document.getElementById("button");
    const mentionMenuEl = document.getElementById("mentionMenu");
    const newThread = document.getElementById("newThread");
    const newFolderBtn = document.getElementById("newFolder");
    const organizeModeBtn = document.getElementById("organizeMode");
    const bulkBar = document.getElementById("bulkBar");
    const bulkCount = document.getElementById("bulkCount");
    const bulkMoveBtn = document.getElementById("bulkMove");
    const bulkArchiveBtn = document.getElementById("bulkArchive");
    const bulkDeleteBtn = document.getElementById("bulkDelete");
    const bulkClearBtn = document.getElementById("bulkClear");
    const refreshBtn = document.getElementById("refreshBtn");
    const threadMenu = document.getElementById("threadMenu");
    const renameThreadBtn = document.getElementById("renameThread");
    const moveThreadBtn = document.getElementById("moveThread");
    const archiveThreadBtn = document.getElementById("archiveThread");
    const restoreThreadBtn = document.getElementById("restoreThread");
    const deleteThreadBtn = document.getElementById("deleteThread");
    const movePanel = document.getElementById("movePanel");
    const moveTitle = document.getElementById("moveTitle");
    const moveFolderList = document.getElementById("moveFolderList");
    const moveFolderName = document.getElementById("moveFolderName");
    const moveCreateBtn = document.getElementById("moveCreate");
    const moveCloseBtn = document.getElementById("moveClose");
    const steerPanel = document.getElementById("steerPanel");
    const steerTitle = document.getElementById("steerTitle");
    const steerTarget = document.getElementById("steerTarget");
    const steerInput = document.getElementById("steerInput");
    const steerClose = document.getElementById("steerClose");
    const steerSubmit = document.getElementById("steerSubmit");
    const steerNote = document.getElementById("steerNote");
    const sharePinCopyBtn = document.getElementById("sharePinCopy");
    const shareCopyBtn = document.getElementById("shareCopy");
    const shareRevokeBtn = document.getElementById("shareRevoke");
    const palette = ["#f0a934", "#4f8df7", "#4fc17d", "#8c70ff", "#ff7f96", "#42c7c9", "#d6a3ff", "#f36f45", "#9bc95d", "#b98b63"];
    let latestSnapshot = null;
    let menuThread = null;
    let organizeMode = false;
    let selectedThreadIds = new Set();
    let moveState = { threadIds: [] };
    let steerState = { item: null, mode: "steer" };
    let refreshTimer = null;
    let refreshInFlight = false;
    let mentionState = { open: false, items: [], active: 0, range: null };
    let agentStreams = new Map();
    let liveRenderPending = false;
    const turnViews = new Map();
    let renderedThreadId = null;

    function text(node, value) { node.textContent = value; return node; }
    function el(tag, className) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      return node;
    }
    function color(index) { return palette[index % palette.length]; }
    function compact(id) { return !id ? "" : id.length > 12 ? id.slice(0, 8) + "..." : id; }
    function formatTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString([], { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    }
    function threadLabel(thread) {
      return (thread && thread.title ? thread.title : "未命名对话") || "未命名对话";
    }
    function actionErrorText(data, fallback) {
      const code = data && data.details && data.details.error ? data.details.error : data && data.error;
      if (code === "busy") return "这个对话还有任务在运行，完成后才能操作。";
      if (code === "not_found") return "对话不存在或已被处理。";
      if (code === "permission_denied" || code === "conflict") return "这个对话不属于当前 Team。";
      return (data && (data.text || data.error)) || fallback;
    }
    function invocationErrorText(data, fallback) {
      const code = data && data.details && data.details.error ? data.details.error : data && data.error;
      if (code === "not_found") return "这个 Agent 回合不存在或已经被处理。";
      if (code === "permission_denied") return "这个 Agent 回合不属于当前 Team。";
      if (code === "conflict") return "这个 Agent 回合已经结束，不能再调控。";
      return (data && (data.text || data.error)) || fallback;
    }
    function canControlInvocation(item) {
      if (!item || !item.invocationId) return false;
      return item.invocationStatus === "running" || item.invocationStatus === "queued" ||
        item.deliveryStatus === "leased" || item.status === "running" ||
        item.status === "awakened" || item.status === "queued";
    }
    function apiQuery(extra) {
      const params = new URLSearchParams();
      if (token) params.set("token", token);
      Object.entries(extra || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && String(value) !== "") params.set(key, String(value));
      });
      const query = params.toString();
      return query ? "?" + query : "";
    }
    function runtimeSessionForAgent(snapshot, agentId) {
      return ((snapshot && snapshot.runtimeSessions) || []).find(session => (
        session.agentId === agentId && session.piWeb && session.eventStreamId
      )) || null;
    }
    function appendToolState(state, tool) {
      if (!tool || !tool.toolCallId) return;
      const previous = state.tools.get(tool.toolCallId) || {};
      state.tools.set(tool.toolCallId, {
        ...previous,
        ...tool,
        text: tool.text || previous.text || "",
        summary: tool.summary || previous.summary || "",
      });
    }
    function streamLabel(state) {
      if (!state) return "等待 PI WEB session";
      if (state.label) return state.label;
      if (state.status === "connected") return "PI WEB 流已连接";
      if (state.status === "connecting") return "连接 PI WEB 流…";
      return state.message || "PI WEB 流状态未知";
    }
    function renderAgentLive(snapshot, item) {
      if (!["running", "awakened", "queued"].includes(item.status)) return null;
      const session = runtimeSessionForAgent(snapshot, item.targetAgentId);
      if (!session) return null;
      const state = agentStreams.get(item.targetAgentId);
      const box = el("div", "agent-live-status");
      box.dataset.agentId = item.targetAgentId;
      const tools = state ? Array.from(state.tools.values()) : [];
      text(box, streamLabel(state) + (tools.length ? " · " + tools.length + " 次工具调用" : ""));
      return box;
    }

    function updateStreamText(node, value) {
      const next = String(value || "");
      if (!node.firstChild) node.append(document.createTextNode(""));
      const current = node.firstChild.data;
      if (current === next) return;
      if (next.startsWith(current)) node.firstChild.appendData(next.slice(current.length));
      else node.firstChild.data = next;
    }
    function disclosure(className) {
      const node = el("details", "turn-disclosure " + className);
      const summary = el("summary");
      const body = el("div", "disclosure-body");
      node.append(summary, body);
      return { node, summary, body };
    }
    function createTurnView(key) {
      const row = el("li", "msg-row");
      row.dataset.turnKey = key;
      const avatar = el("div", "msg-avatar");
      const content = el("div", "msg-content");
      const head = el("div", "msg-head");
      const relations = el("div");
      const bubble = el("div", "bubble turn-bubble");
      const source = el("div", "turn-source");
      const alert = el("div", "turn-alert");
      alert.setAttribute("role", "status");
      const process = el("div", "agent-live");
      const thinking = disclosure("thinking-disclosure");
      const thinkingText = el("div", "agent-live-thinking");
      thinking.body.append(thinkingText);
      const tools = disclosure("tools-disclosure");
      const answerProcess = disclosure("answer-process-disclosure");
      const answerProcessText = el("div", "answer-process-text");
      answerProcess.body.append(answerProcessText);
      process.append(thinking.node, tools.node, answerProcess.node);
      const history = el("div", "process-history");
      const historyNote = el("div");
      const restore = text(el("button", "restore-process"), "恢复历史过程");
      restore.type = "button";
      restore.addEventListener("click", () => { if (view.message) void loadTurnProcess(view, view.message, true); });
      history.append(historyNote, restore);
      const answer = el("div", "bubble-text answer-text");
      answer.id = "answer-" + encodeURIComponent(key);
      const actions = el("div", "answer-actions");
      const toggle = text(el("button", "answer-toggle"), "展开全文");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", answer.id);
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        answer.classList.toggle("is-collapsed", !open);
        text(toggle, open ? "收起全文" : "展开全文");
      });
      const copy = text(el("button", "copy-message"), "Copy");
      copy.type = "button";
      copy.dataset.label = "Copy";
      copy.title = "复制完整回答";
      copy.setAttribute("aria-label", "复制完整回答");
      copy.addEventListener("click", event => handleCopyMessage(event, answer.textContent));
      actions.append(toggle, copy);
      const controls = el("div");
      const receipts = el("div");
      bubble.append(source, alert, process, history, answer, actions, controls);
      content.append(head, relations, bubble, receipts);
      row.append(avatar, content);
      const view = { row, avatar, head, relations, bubble, source, alert, process, thinking, thinkingText, tools, answerProcess, answerProcessText, history, historyNote, restore, answer, actions, toggle, copy, controls, receipts, toolViews:new Map(), stream:null };
      return view;
    }
    async function loadTurnProcess(view, message, restore) {
      if (view.processLoading) return;
      view.processLoading = true;
      view.processRequested = true;
      view.restore.disabled = true;
      text(view.historyNote, "正在读取历史过程…");
      view.history.hidden = false;
      const controller = new AbortController();
      view.processController = controller;
      const deadline = window.setTimeout(() => controller.abort(), 20_000);
      const invocationId = view.row.dataset.invocationId;
      try {
        const response = await fetch((restore ? "/api/process/restore" : "/api/process") + apiQuery(restore ? {} : message ? { messageId: message.id } : { invocationId }), restore ? {
          method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({messageId:message.id}), signal:controller.signal,
        } : {signal:controller.signal});
        if (!response.ok) throw new Error("历史过程暂时无法读取，原回答未更改。");
        const data = await response.json();
        if (turnViews.get(view.row.dataset.turnKey) !== view || (message ? !view.message || view.message.id !== message.id : view.row.dataset.invocationId !== invocationId)) return;
        view.savedProcess = data.process || null;
        view.processError = "";
      } catch (error) {
        view.processError = String(error.message || error);
      } finally {
        window.clearTimeout(deadline);
        view.processController = null;
        view.processLoading = false;
        view.restore.disabled = false;
        if (turnViews.get(view.row.dataset.turnKey) === view) requestLiveRender();
      }
    }
    function updateTurnProcess(view, state, completed) {
      if (state) view.stream = state;
      const saved = completed && view.savedProcess;
      const stream = saved && saved.status !== "unavailable" ? { thinkingText:saved.thinkingText, tools:new Map(saved.tools.map(tool => [tool.toolCallId,tool])) } : view.stream;
      const tools = stream ? Array.from(stream.tools.values()) : [];
      const thinkingText = stream && stream.thinkingText || "";
      view.thinking.node.hidden = !thinkingText;
      text(view.thinking.summary, completed || stream && stream.assistantText ? "思考记录" : "思考中");
      const thinkingBottom = view.thinking.body.scrollHeight - view.thinking.body.scrollTop - view.thinking.body.clientHeight < 40;
      updateStreamText(view.thinkingText, thinkingText);
      if (thinkingBottom && view.thinking.node.open) view.thinking.body.scrollTop = view.thinking.body.scrollHeight;
      const running = tools.filter(tool => tool.status === "running").length;
      const failed = tools.filter(tool => tool.status === "error");
      const done = tools.filter(tool => tool.status === "completed").length;
      view.tools.node.hidden = !tools.length;
      text(view.tools.summary, "工具调用 · " + tools.length + " 次 · 已完成 " + done + (running && !completed ? " · 进行中 " + running : "") + (failed.length ? " · 失败 " + failed.length : ""));
      tools.forEach(tool => {
        let detail = view.toolViews.get(tool.toolCallId);
        if (!detail) {
          detail = disclosure("tool-disclosure");
          detail.body.classList.add("agent-live-tool");
          view.toolViews.set(tool.toolCallId, detail);
          view.tools.body.append(detail.node);
        }
        text(detail.summary, (tool.toolName || "tool") + " · " + (tool.status === "error" ? "失败" : tool.status === "completed" ? "已完成" : completed ? "已结束" : "进行中"));
        updateStreamText(detail.body, [tool.summary, tool.text].filter(Boolean).join("\\n"));
      });
      const steps = saved && saved.answerSteps || stream && stream.answerSteps || [];
      const intermediate = completed && view.message && steps.length && steps[steps.length - 1].trim() === (view.message.content || "").trim() ? steps.slice(0, -1) : steps;
      view.answerProcess.node.hidden = !intermediate.length;
      text(view.answerProcess.summary, "回答过程 · " + intermediate.length + " 段");
      updateStreamText(view.answerProcessText, intermediate.join("\\n\\n"));
      for (const [id, detail] of view.toolViews) if (!tools.some(tool => tool.toolCallId === id)) { detail.node.remove(); view.toolViews.delete(id); }
      view.process.hidden = !thinkingText && !tools.length && !intermediate.length;
      const error = stream && stream.status === "error" ? stream.message : "";
      const alerts = [error, ...failed.map(tool => (tool.toolName || "工具") + ": " + compactText(tool.text || tool.summary || "调用失败", 240))].filter(Boolean);
      view.alert.hidden = !alerts.length;
      text(view.alert, alerts.join(" · "));
    }
    function requestLiveRender() {
      if (liveRenderPending) return;
      liveRenderPending = true;
      requestAnimationFrame(() => {
        liveRenderPending = false;
        if (!latestSnapshot) return;
        renderMessages(latestSnapshot);
        renderRuntimeStatus(latestSnapshot);
      });
    }
    async function loadAgentStreamSnapshot(agentId, state) {
      try {
        const res = await fetch("/api/chat/snapshot" + apiQuery({ sessionId: state.sessionId, scope: "team" }));
        if (!res.ok || agentStreams.get(agentId) !== state) return;
        const data = await res.json();
        if (agentStreams.get(agentId) !== state) return;
        state.cursor = data.cursor || 0;
        state.watermark = data.upstreamSeq || 0;
        if (data.activeRun) {
          state.status = data.activeRun.status || state.status;
          state.label = data.activeRun.label || state.label;
          state.assistantText = data.activeRun.assistantText || state.assistantText;
          state.thinkingText = data.activeRun.thinkingText || state.thinkingText;
        }
        (data.toolStates || []).forEach(tool => appendToolState(state, tool));
        requestLiveRender();
      } catch (error) {
        if (agentStreams.get(agentId) !== state) return;
        state.status = "error";
        state.message = String(error);
        requestLiveRender();
      }
    }
    function handleAgentStreamEvent(agentId, state, event) {
      if (!event || agentStreams.get(agentId) !== state) return;
      if (event.cursor && event.cursor <= state.cursor) return;
      if (event.upstreamSeq && event.upstreamSeq <= state.watermark) return;
      if (typeof event.cursor === "number") state.cursor = Math.max(state.cursor || 0, event.cursor);
      if (event.type === "assistant.delta") {
        state.assistantText += event.text || "";
      } else if (event.type === "thinking.delta") {
        state.thinkingText += event.text || "";
      } else if (event.type === "tool.start" || event.type === "tool.update" || event.type === "tool.end") {
        appendToolState(state, event.tool);
      } else if (event.type === "run.status") {
        state.status = event.status || state.status;
        state.label = event.label || state.label;
        state.message = event.connectionState && event.connectionState.message || state.message;
      } else if (event.type === "assistant.done") {
        state.status = "idle";
        state.label = "本轮输出完成";
        scheduleLiveRefresh(120);
      } else if (event.type === "snapshot.invalidated") {
        closeAgentStream(agentId);
        scheduleLiveRefresh(0);
      } else if (event.type === "error") {
        state.status = "error";
        state.message = event.message || "PI WEB 流异常";
      }
      requestLiveRender();
    }
    async function connectAgentStream(agentId, session, reconnectAttempt = 0) {
      const state = {
        agentId,
        sessionId: session.sessionId,
        eventStreamId: session.eventStreamId,
        invocationId: session.invocationId,
        cursor: 0,
        status: "connecting",
        label: "连接 PI WEB 流…",
        message: "",
        assistantText: "",
        thinkingText: "",
        tools: new Map(),
        socket: null,
      };
      agentStreams.set(agentId, state);
      await loadAgentStreamSnapshot(agentId, state);
      if (agentStreams.get(agentId) !== state) return;
      const params = apiQuery({ streamId: session.eventStreamId, sessionId: session.sessionId, cursor: state.cursor, scope: "team" });
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(protocol + "//" + window.location.host + "/api/chat/events" + params);
      state.socket = socket;
      socket.addEventListener("open", () => {
        if (agentStreams.get(agentId) !== state) return;
        state.status = "connected";
        state.label = "PI WEB 流已连接";
        reconnectAttempt = 0;
        requestLiveRender();
      });
      socket.addEventListener("message", event => {
        if (agentStreams.get(agentId) !== state) return;
        try {
          handleAgentStreamEvent(agentId, state, JSON.parse(event.data));
        } catch (error) {
          state.status = "error";
          state.message = String(error);
          requestLiveRender();
        }
      });
      socket.addEventListener("close", () => {
        if (agentStreams.get(agentId) !== state) return;
        state.status = "connecting";
        state.label = "PI WEB 流已断开，正在重连";
        state.reconnectTimer = window.setTimeout(() => {
          if (agentStreams.get(agentId) !== state) return;
          void connectAgentStream(agentId, session, reconnectAttempt + 1);
        }, Math.min(10_000, 700 * Math.pow(2, reconnectAttempt)));
        requestLiveRender();
      });
      socket.addEventListener("error", () => {
        if (agentStreams.get(agentId) !== state) return;
        state.status = "error";
        state.message = "PI WEB 流连接失败";
        requestLiveRender();
      });
    }
    function closeAgentStream(agentId) {
      const state = agentStreams.get(agentId);
      if (!state) return;
      agentStreams.delete(agentId);
      if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
      try { state.socket && state.socket.close(); } catch {}
    }
    function syncAgentStreams(snapshot) {
      const wanted = new Map();
      const activeItems = ((snapshot.runtimeStatus && snapshot.runtimeStatus.active) || [])
        .filter(item => item.status === "running" || item.status === "awakened");
      activeItems.forEach(item => {
        const session = runtimeSessionForAgent(snapshot, item.targetAgentId);
        if (session) wanted.set(item.targetAgentId, { ...session, invocationId: item.invocationId });
      });
      for (const [agentId, state] of agentStreams) {
        const next = wanted.get(agentId);
        if (!next || next.eventStreamId !== state.eventStreamId || next.invocationId !== state.invocationId) closeAgentStream(agentId);
      }
      for (const [agentId, session] of wanted) {
        const current = agentStreams.get(agentId);
        if (!current || current.eventStreamId !== session.eventStreamId || current.invocationId !== session.invocationId) connectAgentStream(agentId, session);
      }
    }
    function renderInvocationControls(snapshot, item) {
      if (!canControlInvocation(item)) return null;
      const controls = el("div", "invocation-controls");
      const stop = text(el("button", "invocation-control danger"), "终止");
      stop.type = "button";
      stop.title = "只终止这个 Agent 的当前回合";
      stop.addEventListener("click", (event) => {
        event.stopPropagation();
        cancelInvocation(item).catch(error => { statusEl.textContent = String(error); });
      });
      const steer = text(el("button", "invocation-control"), "Steer");
      steer.type = "button";
      steer.title = "给这个 Agent 追加方向";
      steer.addEventListener("click", (event) => {
        event.stopPropagation();
        openSteerPanel(snapshot, item, "steer");
      });
      const session = runtimeSessionForAgent(snapshot, item.targetAgentId);
      if (session) {
        const follow = text(el("button", "invocation-control"), "Follow");
        follow.type = "button";
        follow.title = "追加到这个 Agent 的当前 PI WEB 回合";
        follow.addEventListener("click", (event) => {
          event.stopPropagation();
          openSteerPanel(snapshot, item, "follow");
        });
        controls.append(stop, follow, steer);
      } else {
        controls.append(stop, steer);
      }
      return controls;
    }
    function hideSteerPanel() {
      steerPanel.hidden = true;
      steerState = { item: null, mode: "steer" };
      steerInput.value = "";
      steerNote.textContent = "";
      steerSubmit.disabled = false;
    }
    function openSteerPanel(snapshot, item, mode) {
      if (!item || !item.invocationId) return;
      steerState = { item, mode: mode === "follow" ? "follow" : "steer" };
      const isFollow = steerState.mode === "follow";
      steerTitle.textContent = (isFollow ? "Follow @" : "Steer @") + memberName(snapshot, item.targetAgentId);
      steerTarget.textContent = item.source
        ? "触发消息 #" + item.source.seq + " · " + (item.source.preview || "空消息")
        : "当前运行回合 " + compact(item.invocationId);
      steerInput.value = "";
      steerInput.placeholder = isFollow
        ? "写下要追加给这个 Agent 的 follow。会进入它当前的 PI WEB session。"
        : "写下要追加给这个 Agent 的方向。PI WEB 后端会直接 steer；其他后端会终止当前尝试并重新唤醒。";
      steerSubmit.textContent = isFollow ? "发送 Follow" : "发送 Steer";
      steerNote.textContent = isFollow
        ? "提交后会追加到这个 Agent 当前回合。"
        : "PI WEB 后端直接 steer；非 PI WEB 后端会重跑这个 Agent。";
      steerPanel.hidden = false;
      requestAnimationFrame(() => steerInput.focus());
    }
    async function cancelInvocation(item) {
      if (!item || !item.invocationId) return;
      const name = latestSnapshot ? memberName(latestSnapshot, item.targetAgentId) : compact(item.targetAgentId);
      if (!window.confirm("终止 @" + name + " 的当前回合？\\n只会停止这个 Agent，不会影响其他并行 Agent。")) return;
      statusEl.textContent = "正在终止 @" + name + "…";
      const res = await fetch("/api/invocation/cancel" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invocationId: item.invocationId, reason: "用户在 Team Web 手动终止" }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = invocationErrorText(data, "终止失败");
        return;
      }
      statusEl.textContent = "已终止 @" + name;
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      scheduleLiveRefresh(250);
    }
    async function submitSteer() {
      const item = steerState.item;
      const message = steerInput.value.trim();
      if (!item || !item.invocationId) return;
      if (!message) {
        steerNote.textContent = "先写一句要追加的方向。";
        return;
      }
      const name = latestSnapshot ? memberName(latestSnapshot, item.targetAgentId) : compact(item.targetAgentId);
      steerSubmit.disabled = true;
      steerNote.textContent = "发送中…";
      const mode = steerState.mode === "follow" ? "follow" : "steer";
      const res = await fetch("/api/invocation/" + mode + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invocationId: item.invocationId, message }),
      });
      const data = await res.json();
      if (!data.ok) {
        steerSubmit.disabled = false;
        steerNote.textContent = invocationErrorText(data, mode === "follow" ? "Follow 失败" : "Steer 失败");
        return;
      }
      statusEl.textContent = "已发送给 @" + name + " 的 " + (mode === "follow" ? "Follow" : "Steer");
      hideSteerPanel();
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      scheduleLiveRefresh(250);
    }
    function selectedThreads() {
      const live = new Set((latestSnapshot && latestSnapshot.threads || []).map(thread => thread.id));
      selectedThreadIds = new Set(Array.from(selectedThreadIds).filter(id => live.has(id)));
      return (latestSnapshot && latestSnapshot.threads || []).filter(thread => selectedThreadIds.has(thread.id));
    }
    function confirmThreadDelete(threads) {
      const list = threads.slice(0, 5).map(thread => "• " + threadLabel(thread)).join("\\n");
      const more = threads.length > 5 ? "\\n另外还有 " + (threads.length - 5) + " 个对话。" : "";
      return window.confirm("永久删除 " + threads.length + " 个对话？\\n" + list + more + "\\n这会删除消息和运行记录，无法恢复。");
    }
    function confirmThreadArchive(threads) {
      const list = threads.slice(0, 5).map(thread => "• " + threadLabel(thread)).join("\\n");
      const more = threads.length > 5 ? "\\n另外还有 " + (threads.length - 5) + " 个对话。" : "";
      return window.confirm("归档 " + threads.length + " 个对话？\\n" + list + more + "\\n归档后会从普通列表隐藏，可在已归档里恢复。");
    }
    function updateBulkBar() {
      const count = selectedThreads().length;
      bulkBar.hidden = !organizeMode;
      organizeModeBtn.classList.toggle("active", organizeMode);
      organizeModeBtn.textContent = organizeMode ? "完成" : "整理";
      bulkCount.textContent = "已选 " + count;
      [bulkMoveBtn, bulkArchiveBtn, bulkDeleteBtn, bulkClearBtn].forEach(node => { node.disabled = count === 0; });
    }
    function clearSelection() {
      selectedThreadIds.clear();
      if (latestSnapshot) renderThreads(latestSnapshot);
    }
    function liveWorkCount(snapshot) {
      const status = snapshot && snapshot.runtimeStatus || {};
      return ((status.active || []).length) + ((status.queued || []).length);
    }
    function liveRefreshDelay(snapshot) {
      return liveWorkCount(snapshot) > 0 ? 500 : 2500;
    }
    function memberIndex(snapshot, id) {
      return (snapshot.members || []).findIndex(member => member.agentId === id);
    }
    function memberName(snapshot, id) {
      const hit = (snapshot.members || []).find(member => member.agentId === id);
      return hit ? hit.name : compact(id);
    }
    function agentFor(snapshot, id) {
      return (snapshot.agents || []).find(agent => agent.id === id) || {};
    }
    function memberColor(snapshot, id) {
      const index = memberIndex(snapshot, id);
      return index >= 0 ? color(index) : "#a86450";
    }
    function messageById(snapshot, id) {
      return (snapshot.messages || []).find(message => message.id === id) || null;
    }
    function messageAuthorName(snapshot, message) {
      if (!message) return "消息";
      if (message.authorType === "user") return "主公";
      if (message.authorType === "system") return "系统";
      return memberName(snapshot, message.authorId);
    }
    function compactText(value, limit) {
      const raw = String(value || "").replace(/\\s+/g, " ").trim();
      if (!raw) return "";
      return raw.length > limit ? raw.slice(0, Math.max(1, limit - 3)) + "..." : raw;
    }
    function messagePreview(message, limit) {
      return compactText(message && message.content, limit || 64) || "空消息";
    }
    function latestInvocationFor(snapshot, messageId, agentId) {
      const matches = (snapshot.invocations || [])
        .filter(invocation => invocation.sourceMessageId === messageId && invocation.targetAgentId === agentId)
        .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
      return matches.length ? matches[matches.length - 1] : null;
    }
    function deliveryFor(snapshot, messageId, agentId) {
      return (snapshot.deliveries || []).find(delivery => delivery.messageId === messageId && delivery.agentId === agentId) || null;
    }
    function finalForInvocation(snapshot, invocationId) {
      if (!invocationId) return null;
      const matches = (snapshot.messages || [])
        .filter(message => message.parentInvocationId === invocationId && message.authorType === "agent")
        .sort((a, b) => a.seq - b.seq);
      return matches.length ? matches[matches.length - 1] : null;
    }
    function routeTargetsForMessage(snapshot, message) {
      return [...new Set(message.wakeTargets || [])].map(agentId => {
        const delivery = deliveryFor(snapshot, message.id, agentId);
        const invocation = latestInvocationFor(snapshot, message.id, agentId);
        const final = finalForInvocation(snapshot, invocation && invocation.id);
        return { agentId, delivery, invocation, final };
      });
    }
	    function firstFinalRoute(routes) {
	      return routes.find(route => route.final)?.final || null;
	    }
    function makeRelationPill(className, label, title, targetMessage) {
      const pill = text(el(targetMessage ? "button" : "span", "relation-pill " + className), label);
      pill.title = title;
      if (targetMessage) {
        pill.type = "button";
        pill.addEventListener("click", () => scrollToMessageId(targetMessage.id));
      }
      return pill;
    }
    async function copyTextToClipboard(value) {
      const copyValue = String(value || "");
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(copyValue);
        return;
      }
      const area = document.createElement("textarea");
      area.value = copyValue;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (!ok) throw new Error("copy failed");
    }
    async function handleCopyMessage(event, value) {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const label = button.dataset.label || "Copy";
      if (button.dataset.copying === "true") return;
      button.dataset.copying = "true";
      button.classList.remove("copied", "failed");
      try {
        await copyTextToClipboard(value);
        button.textContent = "已复制";
        button.classList.add("copied");
      } catch (error) {
        button.textContent = "失败";
        button.classList.add("failed");
      }
      window.setTimeout(() => {
        button.textContent = label;
        button.classList.remove("copied", "failed");
        delete button.dataset.copying;
      }, 1300);
    }
    function parseDateMs(value) {
      if (!value) return NaN;
      const time = new Date(value).getTime();
      return Number.isFinite(time) ? time : NaN;
    }
    function ageText(value) {
      const time = parseDateMs(value);
      if (!Number.isFinite(time)) return "";
      const diff = Date.now() - time;
      if (diff < -1000) return "未来 " + formatTime(value);
      const seconds = Math.max(0, Math.floor(diff / 1000));
      if (seconds < 60) return seconds + "s 前";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m 前";
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return hours + "h 前";
      return formatTime(value);
    }
	    function receiptStateForRoute(delivery, invocation, final) {
	      const deliveryStatus = delivery && delivery.status;
	      const invocationStatus = invocation && invocation.status;
	      if (invocationStatus === "completed" && invocation.outcome?.disposition === "awaiting_user" && !invocation.outcome.resolvedByMessageId) return { className: "queued", label: "等待用户决定", tone: "warn" };
	      if (final) return { className: "done", label: "已由回复明确处理 #" + final.seq, tone: "good" };
	      if (invocationStatus === "running") return { className: "running", label: "已唤醒 · 当前轮处理中", tone: "warn" };
	      if (deliveryStatus === "leased") return { className: "running", label: "已唤醒", tone: "warn" };
	      if (invocationStatus === "queued") return { className: "queued", label: deliveryStatus === "failed" ? "上次失败，等待重试" : "未读 · 排队中", tone: "warn" };
	      if (deliveryStatus === "queued") return { className: "queued", label: "未读 · 排队中", tone: "warn" };
	      if (invocationStatus === "completed" || deliveryStatus === "acked") return { className: "silent", label: "已完成 · 无需新回复", tone: "good" };
	      if (invocationStatus === "dead_letter" || deliveryStatus === "dead_letter" || invocationStatus === "cancelled") return { className: "failed", label: "已失败终止", tone: "bad" };
	      if (invocationStatus === "failed" || deliveryStatus === "failed") return { className: "failed", label: "失败 · 已停止", tone: "bad" };
	      return { className: "queued", label: "待路由", tone: "warn" };
	    }
	    function invocationById(snapshot, id) {
	      return (snapshot.invocations || []).find(invocation => invocation.id === id) || null;
	    }
    function invocationLineage(snapshot, invocation) {
      const lineage = [];
      const seen = new Set();
      let cursor = invocation;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        lineage.unshift(cursor);
        cursor = cursor.parentInvocationId ? invocationById(snapshot, cursor.parentInvocationId) : null;
      }
      return lineage;
    }
    function lineageMessageIds(snapshot, invocation) {
      const ids = [];
      invocationLineage(snapshot, invocation).forEach(step => {
        if (step.sourceMessageId) ids.push(step.sourceMessageId);
        const final = finalForInvocation(snapshot, step.id);
        if (final) ids.push(final.id);
      });
      return [...new Set(ids)];
    }
    function focusInvocationLineage(snapshot, invocation) {
      if (!invocation) return false;
      const ids = new Set(lineageMessageIds(snapshot, invocation));
      if (!ids.size) return false;
      const nodes = Array.from(messagesEl.querySelectorAll(".msg-row")).filter(row => ids.has(row.dataset.messageId));
      if (!nodes.length) return false;
      nodes.forEach(row => row.dataset.lineageFocus = "true");
      nodes[0].scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => nodes.forEach(row => delete row.dataset.lineageFocus), 3200);
      return true;
    }
    function renderRelationPills(snapshot, message) {
      const row = el("div", "link-pills");
      if (message.replyTo) {
        const reply = messageById(snapshot, message.replyTo);
        const label = reply
          ? "↩ @" + messageAuthorName(snapshot, reply) + " #" + reply.seq + ": " + messagePreview(reply, 56)
          : "↩ 上文消息 " + compact(message.replyTo);
        row.append(makeRelationPill(
          "reply-pill",
          label,
          reply ? "点击定位到被回复的消息" : "被回复的消息不在当前快照中",
          reply,
        ));
      }
      const routes = routeTargetsForMessage(snapshot, message);
      if (message.authorType === "agent") {
        routes.forEach(route => {
          const label = messageAuthorName(snapshot, message) + " → " + memberName(snapshot, route.agentId);
          row.append(makeRelationPill(
            "handoff-pill",
            label,
            route.final
              ? "点击定位到 " + memberName(snapshot, route.agentId) + " 的接力回复 #" + route.final.seq
              : messageAuthorName(snapshot, message) + " 已把球传给 " + memberName(snapshot, route.agentId),
            route.final,
          ));
        });
      }
      if (routes.length) {
        const label = "→ " + routes.map(route => "@" + memberName(snapshot, route.agentId)).join(" / ");
        const firstFinal = firstFinalRoute(routes);
        const resolved = routes
          .filter(route => route.final)
          .map(route => "@" + memberName(snapshot, route.agentId) + " #" + route.final.seq)
          .join("、");
        row.append(makeRelationPill(
          "route-pill",
          label,
          resolved
            ? "这条消息下一步 @ 了 " + routes.map(route => "@" + memberName(snapshot, route.agentId)).join("、") + "；点击定位到 " + resolved
            : "这条消息下一步 @ 了 " + routes.map(route => "@" + memberName(snapshot, route.agentId)).join("、"),
          firstFinal,
        ));
      }
      return row.childElementCount ? row : null;
    }
	    function renderReceiptDock(snapshot, message) {
	      const routes = routeTargetsForMessage(snapshot, message);
	      if (!routes.length) return null;
	      const dock = el("div", "receipt-dock");
	      routes.forEach(route => {
	        const { agentId, delivery, invocation, final } = route;
	        const state = receiptStateForRoute(delivery, invocation, final);
	        const item = el("div", "receipt-item " + state.className);
	        item.style.setProperty("--target-color", memberColor(snapshot, agentId));
	        const visibleMeta = [];
	        if (delivery) visibleMeta.push("delivery:" + delivery.status);
	        if (invocation) visibleMeta.push("invocation:" + invocation.status);
	        const attempts = invocation?.attempts ?? delivery?.attempts;
	        if (attempts) visibleMeta.push("attempts:" + attempts);
	        const errorText = compactText((delivery && delivery.lastError) || (invocation && invocation.lastError) || "", 32);
	        if (errorText) visibleMeta.push("error:" + errorText);
	        item.title = [
	          "message=" + compact(message.id),
	          "target=" + agentId,
	          "delivery=" + (delivery ? delivery.status : "missing"),
	          "invocation=" + (invocation ? invocation.status : "missing"),
	          delivery && delivery.ackedAt ? "ackedAt=" + formatTime(delivery.ackedAt) : "",
	          invocation && invocation.updatedAt ? "updatedAt=" + formatTime(invocation.updatedAt) : "",
	          final ? "final=#" + final.seq : "",
	        ].filter(Boolean).join(" · ");
	        item.append(
	          el("span", "receipt-dot"),
	          text(el("span", "receipt-target"), "@" + memberName(snapshot, agentId)),
	          text(el("span", "receipt-state"), state.label),
	          text(el("span", "receipt-meta"), visibleMeta.join(" · ")),
	        );
	        if (invocation) {
	          const lineageButton = text(el("button", "receipt-lineage"), "lineage");
	          lineageButton.type = "button";
	          lineageButton.title = "查看完整 invocation lineage";
	          lineageButton.addEventListener("click", () => {
	            if (!focusInvocationLineage(snapshot, invocation)) lineageButton.textContent = "lineage 不在当前快照";
	          });
	          item.append(lineageButton);
	        }
	        dock.append(item);
	      });
	      return dock;
	    }
    function mentionToken(name) {
      const simple = /^[A-Za-z0-9_./:+~#=\\-\\u4e00-\\u9fff]+$/.test(name);
      return simple ? "@" + name : "@\\"" + name.replace(/["\\\\]/g, "\\\\$&") + "\\"";
    }
    function insertMention(name) {
      const token = mentionToken(name);
      input.value = token + " " + input.value.replace(/^@("[^"]+"|\\S+)\\s*/, "");
      closeMentionMenu();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    function setMemberColor(node, index) {
      node.style.setProperty("--member-color", color(index));
      return node;
    }
    function normalizeSearch(value) {
      return String(value || "").normalize("NFKC").toLocaleLowerCase();
    }
    function compactParts(values) {
      return values.filter(value => value !== undefined && value !== null && String(value).trim()).map(value => String(value).trim()).join(" · ");
    }
    function profileValue(value) {
      return String(value || "").trim();
    }
    function hasProfileText(profile) {
      return !!profile && [profile.roleDescription, profile.personality, profile.teamStrengths, profile.caution].some(value => profileValue(value));
    }
    function defaultProfileConfigForMember(member) {
      const memberKeys = [member.agentId, member.name, member.role, ...(member.aliases || [])].map(normalizeSearch);
      return defaultMentionProfiles.find(profile => {
        const profileKeys = [profile.slotId, profile.name, profile.role, ...(profile.aliases || [])].map(normalizeSearch);
        return profileKeys.some(key => key && memberKeys.includes(key));
      }) || null;
    }
    function defaultProfileForMember(member) {
      return defaultProfileConfigForMember(member)?.roleProfile || {};
    }
    function normalizeClientId(value) {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized === "kimi" || normalized === "kimi-code") return "kimi-code";
      if (normalized === "claude" || normalized === "claude-code") return "claude-code";
      if (normalized === "codex" || normalized === "codex-cli") return "codex-cli";
      if (normalized === "grok" || normalized === "grok-build") return "grok-build";
      if (normalized === "grok-pi") return "grok-pi";
      if (normalized === "kimi-pi") return "kimi-pi";
      return "pi";
    }
    function clientCapabilities(snapshot) {
      const byClient = new Map();
      (snapshot.runtimeCapabilities || []).forEach(capability => {
        const clientId = normalizeClientId(capability.clientId);
        byClient.set(clientId, {
          clientId,
          label: capability.label || runtimeClientLabels[clientId] || clientId,
          modelOptions: Array.isArray(capability.modelOptions) ? capability.modelOptions : [],
          thinkingLevels: Array.isArray(capability.thinkingLevels) ? capability.thinkingLevels : (fallbackThinkingLevelsByClient[clientId] || [""]),
          verified: capability.verified !== false,
          note: capability.note || "",
        });
      });
      if (!byClient.has("pi")) {
        byClient.set("pi", {
          clientId: "pi",
          label: runtimeClientLabels.pi,
          modelOptions: snapshot.modelOptions || [],
          thinkingLevels: snapshot.thinkingLevels || fallbackThinkingLevelsByClient.pi,
          verified: true,
        });
      }
      ["kimi-code", "claude-code", "codex-cli", "grok-build", "grok-pi"].forEach(clientId => {
        if (!byClient.has(clientId)) {
          byClient.set(clientId, {
            clientId,
            label: runtimeClientLabels[clientId] || clientId,
            modelOptions: [],
            thinkingLevels: fallbackThinkingLevelsByClient[clientId] || [""],
            verified: clientId !== "grok-build" && clientId !== "claude-code" && clientId !== "codex-cli",
          });
        }
      });
      return ["pi", "kimi-code", "claude-code", "codex-cli", "grok-build", "grok-pi"].map(clientId => byClient.get(clientId)).filter(Boolean);
    }
    function capabilityForClient(snapshot, clientId) {
      const normalized = normalizeClientId(clientId);
      return clientCapabilities(snapshot).find(capability => capability.clientId === normalized) || null;
    }
    function modelOptionKey(option) {
      return normalizeClientId(option.clientId) + ":" + option.provider + "/" + option.model;
    }
    function modelOptionForModel(snapshot, clientId, provider, model) {
      const normalized = normalizeClientId(clientId);
      const capability = capabilityForClient(snapshot, clientId);
      if (!capability) return null;
      return (capability.modelOptions || []).find(candidate =>
        normalizeClientId(candidate.clientId || normalized) === normalized &&
        candidate.provider === provider &&
        candidate.model === model
      ) || null;
    }
    function thinkingLevelsForModel(snapshot, clientId, provider, model) {
      const normalized = normalizeClientId(clientId);
      const capability = capabilityForClient(snapshot, normalized);
      const fallback = (capability && capability.thinkingLevels) || fallbackThinkingLevelsByClient[normalized] || [""];
      const option = modelOptionForModel(snapshot, clientId, provider, model);
      const levels = option && Array.isArray(option.thinkingLevels) && option.thinkingLevels.length
        ? option.thinkingLevels
        : fallback;
      return [...new Set(levels.length ? levels : [""])];
    }
    function normalizeThinkingForClient(clientId, thinking, levels) {
      const nativeLevels = levels && levels.length ? levels : fallbackThinkingLevelsByClient[normalizeClientId(clientId)] || [""];
      const raw = thinking || "";
      const mapped = normalizeClientId(clientId) === "kimi-code"
        ? ({ minimal: "low", medium: "high", xhigh: "max" }[raw] || raw)
        : normalizeClientId(clientId) === "codex-cli"
          ? ({ minimal: "low", ultracode: "ultra" }[raw] || raw)
        : raw;
      return nativeLevels.includes(mapped) ? mapped : "";
    }
    function defaultThinkingForModel(snapshot, clientId, provider, model) {
      const option = modelOptionForModel(snapshot, clientId, provider, model);
      const levels = thinkingLevelsForModel(snapshot, clientId, provider, model);
      const thinking = option && typeof option.thinking === "string" ? option.thinking : "";
      return normalizeThinkingForClient(clientId, thinking, levels);
    }
    function modelOptionMatchesProfile(option, profile) {
      if (!profile) return true;
      if (profile.clientId && normalizeClientId(option.clientId) !== normalizeClientId(profile.clientId)) return false;
      const provider = normalizeSearch(option.provider);
      const model = normalizeSearch(option.model);
      const key = provider + "/" + model;
      const preferredModels = (profile.preferredModels || []).map(normalizeSearch);
      if (preferredModels.includes(key)) return true;
      const providerHints = (profile.providerHints || []).map(normalizeSearch);
      const modelHints = (profile.modelHints || []).map(normalizeSearch);
      return providerHints.some(hint => hint && (provider.includes(hint) || key.includes(hint))) ||
        modelHints.some(hint => hint && (model.includes(hint) || key.includes(hint)));
    }
    function modelOptionsForMember(snapshot, member, clientId) {
      const profile = defaultProfileConfigForMember(member);
      const capability = capabilityForClient(snapshot, clientId);
      const options = (capability && capability.modelOptions || [])
        .filter(option => normalizeClientId(option.clientId) === normalizeClientId(clientId));
      if (!profile) return options;
      const familyOptions = options.filter(option => modelOptionMatchesProfile(option, profile));
      return familyOptions.length ? familyOptions : options;
    }
    function profileForMention(member, agent) {
      return hasProfileText(agent.roleProfile) ? agent.roleProfile : defaultProfileForMember(member);
    }
    function mentionProfileDescription(profile) {
      const roleDescription = profileValue(profile.roleDescription);
      const teamStrengths = profileValue(profile.teamStrengths);
      const personality = profileValue(profile.personality);
      const caution = profileValue(profile.caution);
      const primary = [];
      if (roleDescription) primary.push(roleDescription);
      if (teamStrengths) primary.push("强项：" + teamStrengths);
      if (primary.length) return primary.join(" · ");
      if (personality) return personality;
      return caution ? "边界：" + caution : "";
    }
    function buildMentionItems(snapshot) {
      const items = [
        {
          insertName: "all",
          label: "@all",
          avatar: "全",
          color: "#f1bd6a",
          meta: "全体已启用成员",
          desc: "唤起所有当前启用的角色。",
          searchText: normalizeSearch("all 全体 全员 所有 大家"),
        },
        {
          insertName: "thread",
          label: "@thread",
          avatar: "帖",
          color: "#9bb7ff",
          meta: "本对话全体",
          desc: "唤起这个对话里的所有已启用角色。",
          searchText: normalizeSearch("thread 本帖 本对话 对话 全体 全员 大家"),
        },
      ];
      (snapshot.members || []).forEach((member, index) => {
        if (member.enabled === false) return;
        const agent = agentFor(snapshot, member.agentId);
        const profile = profileForMention(member, agent);
        const aliases = [...(member.aliases || []), ...(agent.aliases || [])];
        const modelRef = compactParts([normalizeClientId(agent.clientId || "pi"), member.provider + "/" + member.model + (agent.thinking ? ":" + agent.thinking : "")]);
        const meta = compactParts([member.role, modelRef]);
        const desc = mentionProfileDescription(profile) || "已启用成员";
        const searchText = normalizeSearch([
          member.name,
          member.role,
          member.agentId,
          member.provider,
          member.model,
          agent.clientId,
          agent.thinking,
          aliases.join(" "),
          profile.roleDescription,
          profile.personality,
          profile.teamStrengths,
          profile.caution,
          agent.rolePrompt,
        ].filter(Boolean).join(" "));
        items.push({
          insertName: member.name,
          label: "@" + member.name,
          avatar: (member.name || "?").trim().slice(0, 1) || "?",
          color: color(index),
          meta,
          desc,
          searchText,
        });
      });
      return items;
    }
    function findMentionRange() {
      const startSelection = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
      const endSelection = typeof input.selectionEnd === "number" ? input.selectionEnd : startSelection;
      if (startSelection !== endSelection) return null;
      const caret = startSelection;
      const value = input.value || "";
      let at = -1;
      for (let index = caret - 1; index >= 0 && caret - index <= 80; index -= 1) {
        const character = value[index];
        if (character === "\\n" || character === "\\r") break;
        if (character === "@" && (index === 0 || /\\s/.test(value[index - 1]))) {
          at = index;
          break;
        }
      }
      if (at < 0) return null;
      const fragment = value.slice(at, caret);
      if (/\\s/.test(fragment) && !fragment.startsWith("@\\"")) return null;
      const rawQuery = fragment.slice(1);
      return { start: at, end: caret, query: rawQuery.startsWith("\\"") ? rawQuery.slice(1) : rawQuery };
    }
    function closeMentionMenu() {
      mentionState = { open: false, items: [], active: 0, range: null };
      mentionMenuEl.hidden = true;
      mentionMenuEl.replaceChildren();
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    function setActiveMention(index) {
      if (!mentionState.items.length) return;
      mentionState.active = (index + mentionState.items.length) % mentionState.items.length;
      Array.from(mentionMenuEl.children).forEach((node, nodeIndex) => {
        const active = nodeIndex === mentionState.active;
        node.classList.toggle("active", active);
        node.setAttribute("aria-selected", active ? "true" : "false");
      });
      input.setAttribute("aria-activedescendant", "mention-option-" + mentionState.active);
    }
    function applyMention(item) {
      if (!mentionState.range) return;
      const token = mentionToken(item.insertName);
      const replacement = token + " ";
      const value = input.value || "";
      input.value = value.slice(0, mentionState.range.start) + replacement + value.slice(mentionState.range.end);
      const caret = mentionState.range.start + replacement.length;
      closeMentionMenu();
      input.focus();
      input.setSelectionRange(caret, caret);
    }
    function updateMentionMenu() {
      const range = findMentionRange();
      if (!range || !latestSnapshot) {
        closeMentionMenu();
        return;
      }
      const query = normalizeSearch(range.query);
      const items = buildMentionItems(latestSnapshot)
        .filter(item => !query || normalizeSearch(item.label).includes(query) || item.searchText.includes(query))
        .slice(0, 8);
      if (!items.length) {
        closeMentionMenu();
        return;
      }
      mentionState = {
        open: true,
        items,
        active: Math.min(mentionState.active, items.length - 1),
        range,
      };
      const nodes = items.map((item, index) => {
        const option = el("button", "mention-option" + (index === mentionState.active ? " active" : ""));
        option.id = "mention-option-" + index;
        option.type = "button";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", index === mentionState.active ? "true" : "false");
        option.addEventListener("mouseenter", () => setActiveMention(index));
        option.addEventListener("mousedown", event => event.preventDefault());
        option.addEventListener("click", () => applyMention(item));
        const avatar = text(el("div", "avatar"), item.avatar);
        avatar.style.setProperty("--member-color", item.color);
        const body = el("div");
        body.append(
          text(el("div", "mention-main"), item.label),
          text(el("div", "mention-meta"), item.meta),
          text(el("div", "mention-desc"), item.desc),
        );
        option.append(avatar, body);
        return option;
      });
      mentionMenuEl.replaceChildren(...nodes);
      mentionMenuEl.hidden = false;
      input.setAttribute("aria-controls", "mentionMenu");
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-activedescendant", "mention-option-" + mentionState.active);
    }

    function sectionStorageKey(id) {
      return "pi-team-room-thread-section:" + id;
    }
    function sectionCollapsed(id, fallback) {
      const saved = window.localStorage.getItem(sectionStorageKey(id));
      if (saved === "1") return true;
      if (saved === "0") return false;
      return fallback;
    }
    function setSectionCollapsed(id, collapsed) {
      window.localStorage.setItem(sectionStorageKey(id), collapsed ? "1" : "0");
    }
    function hasDragType(event, type) {
      return !!(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes(type));
    }
    function renderThreadRow(snapshot, thread, options) {
      const archived = !!(options && options.archived);
      const active = snapshot.active && snapshot.active.threadId === thread.id;
      const selectable = organizeMode && !archived;
      const row = el("div", "thread-row" + (active ? " active" : "") + (selectable ? " organize" : "") + (archived ? " archived" : ""));
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.draggable = !archived;
      const toggleSelected = () => {
        if (selectedThreadIds.has(thread.id)) selectedThreadIds.delete(thread.id);
        else selectedThreadIds.add(thread.id);
        renderThreads(latestSnapshot);
      };
      const activate = () => {
        if (selectable) {
          toggleSelected();
          return;
        }
        if (archived) {
          statusEl.textContent = "已归档对话需要先恢复。";
          return;
        }
        switchThread(thread.id);
      };
      row.addEventListener("click", activate);
      row.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
      row.addEventListener("contextmenu", (event) => showThreadMenu(event, thread));
      if (!archived) {
        row.addEventListener("dragstart", event => {
          if (!event.dataTransfer) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/team-thread-id", thread.id);
        });
      }
      if (selectable) {
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "thread-check";
        check.checked = selectedThreadIds.has(thread.id);
        check.addEventListener("click", event => event.stopPropagation());
        check.addEventListener("change", toggleSelected);
        row.append(check);
      }
      const left = el("div");
      left.append(
        text(el("div", "thread-name"), thread.title || "未命名对话"),
        text(el("div", "thread-meta"), thread.status + " · " + formatTime(thread.updatedAt || thread.createdAt) + " · " + compact(thread.id)),
      );
      const pins = el("div", "thread-pins");
      (snapshot.members || []).slice(0, 4).forEach((member, index) => {
        const dot = setMemberColor(el("span", "pin"), index);
        dot.title = member.name;
        pins.append(dot);
      });
      row.append(left, pins);
      return row;
    }
    function renderThreadSection(snapshot, input) {
      const { id, label, threads, editable, folder, archived } = input;
      const forcedOpen = !!(searchEl.value || "").trim();
      const collapsed = forcedOpen ? false : sectionCollapsed(id, id !== "recent");
      const item = el("li", "thread-section");
      const head = el("div", "folder-head");
      const dropFolderId = folder ? folder.id : id === "unfiled" ? undefined : null;
      const attachDropTarget = (node) => {
        if (archived || id === "recent") return;
        node.addEventListener("dragover", event => {
          if (hasDragType(event, "text/team-thread-id") || (editable && folder && hasDragType(event, "text/team-folder-id"))) {
            event.preventDefault();
            node.classList.add("drop-target");
          }
        });
        node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
        node.addEventListener("drop", event => {
          node.classList.remove("drop-target");
          if (!event.dataTransfer) return;
          event.preventDefault();
          const draggedFolderId = event.dataTransfer.getData("text/team-folder-id");
          if (editable && folder && draggedFolderId) {
            reorderFolderBefore(draggedFolderId, folder.id).catch(error => { statusEl.textContent = String(error); });
            return;
          }
          const threadId = event.dataTransfer.getData("text/team-thread-id");
          if (threadId && dropFolderId !== null) {
            moveThreadIds([threadId], dropFolderId).catch(error => { statusEl.textContent = String(error); });
          }
        });
      };
      if (editable && folder) {
        head.draggable = true;
        head.addEventListener("dragstart", event => {
          if (!event.dataTransfer) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/team-folder-id", folder.id);
        });
      }
      attachDropTarget(head);
      const toggle = text(el("button", "folder-toggle"), collapsed ? "▶" : "▼");
      toggle.type = "button";
      toggle.addEventListener("click", event => {
        event.stopPropagation();
        setSectionCollapsed(id, !collapsed);
        renderThreads(latestSnapshot);
      });
      const name = document.createElement("input");
      name.className = "folder-name";
      name.value = label;
      name.readOnly = !editable;
      if (editable && folder) {
        name.addEventListener("keydown", event => {
          if (event.key === "Enter") {
            event.preventDefault();
            name.blur();
          }
        });
        name.addEventListener("blur", () => renameFolder(folder.id, name.value).catch(error => { statusEl.textContent = String(error); }));
      }
      const count = text(el("div", "folder-count"), String(threads.length));
      head.append(toggle, name, count);
      if (editable && folder) {
        const up = text(el("button", "tiny-btn"), "↑");
        up.type = "button";
        up.title = "上移文件夹";
        up.addEventListener("click", event => {
          event.stopPropagation();
          moveFolderByDelta(folder.id, -1).catch(error => { statusEl.textContent = String(error); });
        });
        const down = text(el("button", "tiny-btn"), "↓");
        down.type = "button";
        down.title = "下移文件夹";
        down.addEventListener("click", event => {
          event.stopPropagation();
          moveFolderByDelta(folder.id, 1).catch(error => { statusEl.textContent = String(error); });
        });
        head.append(up, down);
      }
      if (!archived && id !== "recent") {
        const add = text(el("button", "tiny-btn"), "+");
        add.type = "button";
        add.title = "新建对话";
        add.addEventListener("click", event => {
          event.stopPropagation();
          createThread(folder && folder.id).catch(error => { statusEl.textContent = String(error); newThread.disabled = false; });
        });
        head.append(add);
      }
      if (editable && folder) {
        const del = text(el("button", "tiny-btn"), "删");
        del.type = "button";
        del.title = "删除文件夹";
        del.addEventListener("click", event => {
          event.stopPropagation();
          deleteFolder(folder).catch(error => { statusEl.textContent = String(error); });
        });
        head.append(del);
      }
      const list = el("ul", "folder-list");
      attachDropTarget(list);
      list.hidden = collapsed;
      list.replaceChildren(...(threads.length ? threads.map(thread => renderThreadRow(snapshot, thread, { archived })) : [text(el("li", "empty-list"), "空")]));
      item.append(head, list);
      return item;
    }
    function renderThreads(snapshot) {
      const query = (searchEl.value || "").trim().toLowerCase();
      const threads = (snapshot.threads || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      const filtered = threads.filter(thread => {
        const folder = (snapshot.folders || []).find(candidate => candidate.id === thread.folderId);
        const haystack = [thread.title, thread.id, thread.status, folder && folder.name].filter(Boolean).join(" ").toLowerCase();
        return !query || haystack.includes(query);
      });
      const archivedThreads = (snapshot.archivedThreads || []).slice().sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      const filteredArchived = archivedThreads.filter(thread => {
        const folder = (snapshot.folders || []).find(candidate => candidate.id === thread.folderId);
        const haystack = [thread.title, thread.id, thread.status, folder && folder.name].filter(Boolean).join(" ").toLowerCase();
        return !query || haystack.includes(query);
      });
      const folders = snapshot.folders || [];
      const folderIds = new Set(folders.map(folder => folder.id));
      const recent = filtered.slice(0, 5);
      const nodes = [];
      if (recent.length || !query) {
        nodes.push(renderThreadSection(snapshot, { id: "recent", label: "最近", threads: recent, editable: false }));
      }
      folders.forEach(folder => {
        const folderThreads = filtered.filter(thread => thread.folderId === folder.id);
        if (!folderThreads.length && query) return;
        nodes.push(renderThreadSection(snapshot, { id: "folder:" + folder.id, label: folder.name, threads: folderThreads, editable: true, folder }));
      });
      const unfiled = filtered.filter(thread => !thread.folderId || !folderIds.has(thread.folderId));
      if (unfiled.length || (!folders.length && !query)) {
        nodes.push(renderThreadSection(snapshot, { id: "unfiled", label: "未分类", threads: unfiled, editable: false }));
      }
      if (filteredArchived.length || (!query && archivedThreads.length)) {
        nodes.push(renderThreadSection(snapshot, { id: "archived", label: "已归档", threads: filteredArchived, editable: false, archived: true }));
      }
      threadsEl.replaceChildren(...(nodes.length ? nodes : [text(el("li", "empty-list"), query ? "没有匹配的对话。" : "还没有对话，点“新对话”开始。")]));
      updateBulkBar();
    }

    function hideThreadMenu() {
      menuThread = null;
      threadMenu.hidden = true;
    }

    function showThreadMenu(event, thread) {
      event.preventDefault();
      event.stopPropagation();
      menuThread = thread;
      const archived = thread.status === "archived";
      renameThreadBtn.hidden = archived;
      moveThreadBtn.hidden = archived;
      archiveThreadBtn.hidden = archived;
      restoreThreadBtn.hidden = !archived;
      const width = 150;
      const height = archived ? 92 : 172;
      const left = Math.min(event.clientX, window.innerWidth - width - 8);
      const top = Math.min(event.clientY, window.innerHeight - height - 8);
      threadMenu.style.left = Math.max(8, left) + "px";
      threadMenu.style.top = Math.max(8, top) + "px";
      threadMenu.hidden = false;
      (archived ? restoreThreadBtn : renameThreadBtn).focus();
    }

    async function renameThread(thread) {
      const current = thread.title || "未命名对话";
      const title = window.prompt("重命名", current);
      if (title === null) return;
      const next = title.trim();
      if (!next || next === current) return;
      statusEl.textContent = "重命名对话…";
      const res = await fetch("/api/thread/rename" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread.id, title: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "重命名失败");
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已重命名";
    }

    async function createFolder(name) {
      const folderName = String(name || "").trim();
      if (!folderName) return null;
      statusEl.textContent = "创建文件夹…";
      const res = await fetch("/api/thread/folder" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: folderName }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "创建文件夹失败");
        return null;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已创建文件夹";
      return data.details && data.details.folder;
    }

    async function renameFolder(folderId, name) {
      const next = String(name || "").trim();
      const current = (latestSnapshot.folders || []).find(folder => folder.id === folderId);
      if (!current || !next || next === current.name) return;
      statusEl.textContent = "重命名文件夹…";
      const res = await fetch("/api/thread/folder/rename" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId, name: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "重命名文件夹失败");
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已重命名文件夹";
    }

    async function deleteFolder(folder) {
      if (!window.confirm("删除文件夹“" + folder.name + "”？里面的对话会移到未分类。")) return;
      statusEl.textContent = "删除文件夹…";
      const res = await fetch("/api/thread/folder/delete" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId: folder.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "删除文件夹失败");
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已删除文件夹";
    }

    async function moveThread(thread) {
      openMovePanel([thread.id]);
    }

    async function moveThreadIds(threadIds, folderId) {
      if (!threadIds.length) return;
      statusEl.textContent = "移动对话…";
      const res = await fetch("/api/thread/bulk/move" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds, folderId }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "移动失败");
        return;
      }
      threadIds.forEach(id => selectedThreadIds.delete(id));
      hideMovePanel();
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已移动";
    }

    function renderMovePanel() {
      const threadIds = moveState.threadIds || [];
      moveTitle.textContent = "移动 " + threadIds.length + " 个对话到";
      const options = [
        { id: undefined, name: "未分类" },
        ...(latestSnapshot.folders || []).map(folder => ({ id: folder.id, name: folder.name })),
      ];
      const nodes = options.map(option => {
        const button = text(el("button", "move-option"), option.name);
        button.type = "button";
        button.addEventListener("click", () => moveThreadIds(threadIds, option.id).catch(error => { statusEl.textContent = String(error); }));
        return button;
      });
      moveFolderList.replaceChildren(...nodes);
    }

    function openMovePanel(threadIds) {
      moveState = { threadIds: Array.from(new Set(threadIds)).filter(Boolean) };
      if (!moveState.threadIds.length) return;
      moveFolderName.value = "";
      renderMovePanel();
      movePanel.hidden = false;
      moveFolderName.focus();
    }

    function hideMovePanel() {
      moveState = { threadIds: [] };
      movePanel.hidden = true;
    }

    async function createFolderAndMove() {
      const name = moveFolderName.value.trim();
      if (!name || !moveState.threadIds.length) return;
      const folder = await createFolder(name);
      if (folder) await moveThreadIds(moveState.threadIds, folder.id);
    }

    async function reorderFolderIds(folderIds) {
      statusEl.textContent = "排序文件夹…";
      const res = await fetch("/api/thread/folder/reorder" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderIds }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "排序失败");
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已排序";
    }

    async function moveFolderByDelta(folderId, delta) {
      const folders = latestSnapshot.folders || [];
      const index = folders.findIndex(folder => folder.id === folderId);
      const next = index + delta;
      if (index < 0 || next < 0 || next >= folders.length) return;
      const ids = folders.map(folder => folder.id);
      const swap = ids[index];
      ids[index] = ids[next];
      ids[next] = swap;
      await reorderFolderIds(ids);
    }

    async function reorderFolderBefore(draggedFolderId, targetFolderId) {
      if (!draggedFolderId || draggedFolderId === targetFolderId) return;
      const ids = (latestSnapshot.folders || []).map(folder => folder.id);
      const from = ids.indexOf(draggedFolderId);
      const to = ids.indexOf(targetFolderId);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, draggedFolderId);
      await reorderFolderIds(ids);
    }

    async function mutateThread(thread, operation, pendingText, doneText) {
      statusEl.textContent = pendingText;
      const res = await fetch("/api/thread/" + operation + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "操作失败");
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = doneText;
    }

    async function mutateThreadIds(threads, operation, pendingText, doneText) {
      if (!threads.length) return;
      statusEl.textContent = pendingText;
      const res = await fetch("/api/thread/bulk/" + operation + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadIds: threads.map(thread => thread.id) }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "操作失败");
        return;
      }
      threads.forEach(thread => selectedThreadIds.delete(thread.id));
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = doneText;
    }

    async function archiveThread(thread) {
      if (!confirmThreadArchive([thread])) return;
      await mutateThread(thread, "archive", "归档对话…", "已归档");
    }

    async function archiveSelectedThreads() {
      const threads = selectedThreads();
      if (!threads.length || !confirmThreadArchive(threads)) return;
      await mutateThreadIds(threads, "archive", "归档对话…", "已归档");
    }

    async function deleteThread(thread) {
      if (!confirmThreadDelete([thread])) return;
      await mutateThread(thread, "delete", "删除对话…", "已删除");
    }

    async function deleteSelectedThreads() {
      const threads = selectedThreads();
      if (!threads.length || !confirmThreadDelete(threads)) return;
      await mutateThreadIds(threads, "delete", "删除对话…", "已删除");
    }

    async function restoreThread(thread) {
      statusEl.textContent = "恢复对话…";
      const res = await fetch("/api/thread/restore" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: thread.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = actionErrorText(data, "恢复失败");
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
      statusEl.textContent = "已恢复";
    }

    function renderMembers(snapshot, options) {
      const previousCards = new Map(Array.from(membersEl.children).map(card => [card.dataset.agentId, card]));
      const cards = (snapshot.members || []).map((member, index) => {
        const previous = previousCards.get(member.agentId);
        if (previous && (previous.draftDirty || previous.isEditing)) {
          previous.refreshCapabilities(snapshot);
          return previous;
        }
        const agent = agentFor(snapshot, member.agentId);
        const profileData = agent.roleProfile || { roleDescription: agent.rolePrompt || "", personality: "", teamStrengths: "", caution: "" };
        const card = el("li", "member-card");
        card.dataset.agentId = member.agentId;
        card.addEventListener("input", () => { card.draftDirty = true; });
        card.addEventListener("change", () => { card.draftDirty = true; });
        setMemberColor(card, index);
        const head = el("div", "member-head");
        const avatar = text(el("div", "avatar"), (member.name || "?").trim().slice(0, 1) || "?");
        const title = el("div", "member-title");
        const mention = text(el("button", "mention"), "@" + member.name);
        mention.type = "button";
        mention.title = "插入 " + mentionToken(member.name);
        mention.addEventListener("click", () => insertMention(member.name));
        const binding = text(el("div", "binding"), (member.enabled ? "● 已启用 " : "○ 关闭 ") + (member.role ? member.role + " · " : "") + normalizeClientId(agent.clientId || "pi") + " · " + member.provider + "/" + member.model + (agent.thinking ? ":" + agent.thinking : ""));
        title.append(mention, binding);
        const actions = el("div", "member-actions");
        const badge = text(el("div", "member-badge"), member.role || "Agent");
        const toggle = text(el("button", "member-toggle"), "编辑");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        actions.append(badge, toggle);
        head.append(avatar, title, actions);

        const profile = el("div", "profile-form");
        profile.hidden = true;
        toggle.addEventListener("click", () => {
          const open = profile.hidden;
          profile.hidden = !open;
          card.isEditing = open;
          card.classList.toggle("open", open);
          toggle.textContent = open ? "收起" : "编辑";
          toggle.setAttribute("aria-expanded", open ? "true" : "false");
        });
        const nameLabel = text(el("label"), "名字 / @ 提及名");
        const nameInput = document.createElement("input");
        nameInput.value = member.name || "";
        nameLabel.append(nameInput);
        const roleLabel = text(el("label"), "角色标签");
        const roleInput = document.createElement("input");
        roleInput.value = member.role || "";
        roleInput.placeholder = "例如：归纳、探路、深潜、落地";
        roleLabel.append(roleInput);

        const bindingGrid = el("div", "profile-grid");
        const clientLabel = text(el("label"), "接入方式");
        const clientSelect = document.createElement("select");
        const initialClientId = normalizeClientId(agent.clientId || "pi");
        clientCapabilities(snapshot).forEach(capability => {
          const option = document.createElement("option");
          option.value = capability.clientId;
          option.textContent = capability.label || capability.clientId;
          option.selected = initialClientId === capability.clientId;
          if (capability.note) option.title = capability.note;
          clientSelect.append(option);
        });
        clientLabel.append(clientSelect);

        const modelLabel = text(el("label"), "模型");
        const modelSelect = document.createElement("select");
        modelLabel.append(modelSelect);
        const customModelInput = document.createElement("input");
        customModelInput.placeholder = "自定义模型 ID";
        customModelInput.setAttribute("aria-label", "自定义模型 ID");
        modelLabel.append(customModelInput);
        bindingGrid.append(clientLabel, modelLabel);

        const thinkingLabel = text(el("label"), "思考程度");
        const thinkingSelect = document.createElement("select");
        thinkingLabel.append(thinkingSelect);
        let note = null;
        const modelValue = (provider, model) => JSON.stringify({ provider, model });
        const selectedModel = () => {
          const custom = customModelInput.value.trim();
          try {
            const selected = JSON.parse(modelSelect.value);
            return custom ? { provider: selected.provider, model: custom } : selected;
          } catch {
            return { provider: member.provider, model: member.model };
          }
        };
        const updateBindingNote = () => {
          if (!note) return;
          const selected = selectedModel();
          note.textContent = "模型绑定：" + normalizeClientId(clientSelect.value) + " · " + selected.provider + "/" + selected.model + (thinkingSelect.value ? ":" + thinkingSelect.value : "");
        };
        const rebuildModelSelect = (preferredProvider, preferredModel) => {
          const clientId = normalizeClientId(clientSelect.value);
          const choices = [];
          const seenModels = new Set();
          const addModelChoice = (option) => {
            if (!option || !option.provider || !option.model) return;
            const normalizedOption = { ...option, clientId: normalizeClientId(option.clientId || clientId) };
            if (normalizedOption.clientId !== clientId) return;
            const key = modelOptionKey(normalizedOption);
            if (seenModels.has(key)) return;
            seenModels.add(key);
            choices.push({
              clientId,
              provider: normalizedOption.provider,
              model: normalizedOption.model,
              name: normalizedOption.name || normalizedOption.model,
              key: normalizedOption.provider + "/" + normalizedOption.model,
              thinking: typeof normalizedOption.thinking === "string" ? normalizedOption.thinking : "",
              verified: normalizedOption.verified !== false,
              note: normalizedOption.note || "",
            });
          };
          const memberClient = normalizeClientId(agent.clientId || "pi");
          const memberOptions = modelOptionsForMember(snapshot, member, clientId);
          const memberCapabilityOption = memberOptions.find(option => option.provider === member.provider && option.model === member.model);
          if (memberClient === clientId && memberCapabilityOption) {
            addModelChoice(memberCapabilityOption);
          } else if (memberClient === clientId) {
            addModelChoice({ clientId, provider: member.provider, model: member.model, name: member.model + " (未在当前目录中)", verified: false });
          }
          if (preferredProvider && preferredModel) addModelChoice({ clientId, provider: preferredProvider, model: preferredModel, name: preferredModel });
          memberOptions.forEach(addModelChoice);
          if (!choices.length) {
            const capability = capabilityForClient(snapshot, clientId);
            (capability && capability.modelOptions || []).forEach(addModelChoice);
          }
          choices.sort((a, b) => a.key.localeCompare(b.key));
          const desiredProvider = preferredProvider || (memberClient === clientId ? member.provider : choices[0]?.provider);
          const desiredModel = preferredModel || (memberClient === clientId ? member.model : choices[0]?.model);
          const optionNodes = choices.map(choice => {
            const option = document.createElement("option");
            option.value = modelValue(choice.provider, choice.model);
            option.textContent = choice.name || choice.key;
            option.selected = choice.provider === desiredProvider && choice.model === desiredModel;
            option.title = choice.note ? choice.key + " · " + choice.note : choice.key;
            return option;
          });
          modelSelect.replaceChildren(...optionNodes);
          if (!modelSelect.value && optionNodes.length) optionNodes[0].selected = true;
        };
        const rebuildThinkingSelect = (preferredThinking) => {
          const clientId = normalizeClientId(clientSelect.value);
          const selected = selectedModel();
          const levels = thinkingLevelsForModel(snapshot, clientId, selected.provider, selected.model);
          const thinking = preferredThinking || "";
          if (!levels.includes("")) levels.unshift("");
          if (thinking && !levels.includes(thinking)) levels.push(thinking);
          const modelOption = modelOptionForModel(snapshot, clientId, selected.provider, selected.model);
          const optionNodes = levels.map(level => {
            const option = document.createElement("option");
            option.value = level;
            option.textContent = level || (modelOption && modelOption.thinking ? "默认 (" + modelOption.thinking + ")" : "默认");
            option.selected = thinking === level;
            return option;
          });
          thinkingSelect.replaceChildren(...optionNodes);
          if (!thinkingSelect.value && optionNodes.length && thinking) {
            const hit = optionNodes.find(option => option.value === thinking);
            if (hit) hit.selected = true;
          }
        };
        const rebuildBindingControls = (preferredThinking) => {
          rebuildModelSelect();
          rebuildThinkingSelect(preferredThinking);
          updateBindingNote();
        };
        rebuildModelSelect(member.provider, member.model);
        rebuildThinkingSelect(agent.thinking);
        clientSelect.addEventListener("change", () => { customModelInput.value = ""; rebuildBindingControls(); });
        modelSelect.addEventListener("change", () => {
          customModelInput.value = "";
          rebuildThinkingSelect();
          updateBindingNote();
        });
        thinkingSelect.addEventListener("change", updateBindingNote);
        customModelInput.addEventListener("input", () => { rebuildThinkingSelect(); updateBindingNote(); });
        card.refreshCapabilities = (nextSnapshot) => {
          snapshot = nextSnapshot;
          const selected = selectedModel();
          const thinking = thinkingSelect.value;
          rebuildModelSelect(selected.provider, selected.model);
          rebuildThinkingSelect(thinking);
        };

        const makeArea = (labelText, value, placeholder) => {
          const label = text(el("label"), labelText);
          const area = document.createElement("textarea");
          area.className = "prompt-area";
          area.value = value || "";
          area.placeholder = placeholder;
          label.append(area);
          return { label, area };
        };
        const roleDescription = makeArea("角色职责 roleDescription", profileData.roleDescription, "这个角色是谁、主要负责什么。");
        const personality = makeArea("性格口吻 personality", profileData.personality, "它说话和工作的气质。");
        const teamStrengths = makeArea("团队强项 teamStrengths", profileData.teamStrengths, "适合交给它的任务标签。");
        const caution = makeArea("使用边界 caution", profileData.caution, "什么时候不要硬派给它，或应该转给谁。");

        const saveRow = el("div", "save-row");
        note = text(el("span", "note"), "");
        updateBindingNote();
        const save = text(el("button", "save"), "保存");
        save.type = "button";
        save.addEventListener("click", async () => {
          save.disabled = true;
          note.className = "note";
          note.textContent = "保存中...";
          try {
            const selected = selectedModel();
            const bindingChanged = clientSelect.value !== initialClientId || selected.provider !== member.provider || selected.model !== member.model || thinkingSelect.value !== (agent.thinking || "");
            const res = await fetch("/api/agent" + qs, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agentId: member.agentId,
                name: nameInput.value,
                ...(bindingChanged ? { clientId: clientSelect.value, provider: selected.provider, model: selected.model, thinking: thinkingSelect.value } : {}),
                role: roleInput.value,
                roleDescription: roleDescription.area.value,
                personality: personality.area.value,
                teamStrengths: teamStrengths.area.value,
                caution: caution.area.value,
                rolePrompt: "",
              }),
            });
            const data = await res.json();
            if (!data.ok) {
              note.className = "note err";
              note.textContent = data.text || "保存失败";
              return;
            }
            note.className = "note ok";
            note.textContent = "已保存";
            card.draftDirty = false;
            card.isEditing = false;
            await refresh({ forceMembers: true });
          } catch (error) {
            note.className = "note err";
            note.textContent = String(error);
          } finally {
            save.disabled = false;
          }
        });
        saveRow.append(note, save);
        profile.append(nameLabel, roleLabel, bindingGrid, thinkingLabel, roleDescription.label, personality.label, teamStrengths.label, caution.label, saveRow);
        card.append(head, profile);
        return card;
      });
      membersEl.replaceChildren(...(cards.length ? cards : [text(el("li", "muted"), "还没有成员。重新运行 /team web 会自动加载默认模型。")]));
    }

    function renderMessages(snapshot) {
      const threadId = snapshot.active && snapshot.active.threadId || snapshot.thread && snapshot.thread.id || "";
      if (renderedThreadId !== threadId) {
        setDecisionReply(null);
        for (const view of turnViews.values()) if (view.processController) view.processController.abort();
        turnViews.clear();
        messagesEl.replaceChildren();
        renderedThreadId = threadId;
      }
      const messages = (snapshot.messages || []).slice().sort((a, b) => a.seq - b.seq);
      const completed = new Set(messages.filter(message => message.authorType === "agent").map(message => message.parentInvocationId).filter(Boolean));
      const liveItems = [
        ...((snapshot.runtimeStatus && snapshot.runtimeStatus.active) || []),
        ...((snapshot.runtimeStatus && snapshot.runtimeStatus.queued) || []),
      ].filter(item => !completed.has(item.invocationId));
      for (const invocation of snapshot.invocations || []) {
        const source = messages.find(message => message.id === invocation.sourceMessageId && message.visibility !== "private");
        if (invocation.status !== "completed" || invocation.outcome?.disposition !== "no_action" || !source || completed.has(invocation.id)) continue;
        liveItems.push({ invocationId: invocation.id, targetAgentId: invocation.targetAgentId, silent: true, status: "terminal_silent", statusLabel: "已完成 · 无需新回复", reason: invocation.outcome.reason, source: { ...source, preview: messagePreview(source, 70) } });
      }
      if (!messages.length && !liveItems.length) {
        const empty = el("li", "empty-chat");
        const box = document.createElement("div");
        box.append(
          text(document.createElement("strong"), "欢迎回来"),
          text(document.createElement("div"), "左边默认加载角色档案；输入 @all 召唤全员，或 @成员名 单独聊。"),
        );
        empty.append(box);
        messagesEl.className = "";
        messagesEl.replaceChildren(empty);
        return;
      }
      const mobile = window.matchMedia("(max-width: 820px)").matches;
      const scroller = mobile ? document.scrollingElement || document.documentElement : chatScrollEl;
      const scrollTop = scroller.scrollTop;
      const viewportTop = mobile ? 0 : chatScrollEl.getBoundingClientRect().top;
      const anchor = Array.from(messagesEl.children).find(row => row.getBoundingClientRect().bottom > viewportTop);
      const anchorTop = anchor && anchor.getBoundingClientRect().top;
      const nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40;
      const reading = !!messagesEl.querySelector('details[open], .answer-toggle[aria-expanded="true"]') || !!String(window.getSelection());
      const desired = new Map();
      messagesEl.className = "messages";
      function updateRow(message, item) {
        const silent = !!(item && item.silent);
        const settled = !!message || silent;
        const invocationId = message ? message.parentInvocationId : item.invocationId;
        const key = threadId + ":" + (invocationId ? "turn:" + invocationId : "message:" + message.id);
        let view = turnViews.get(key);
        if (!view) { view = createTurnView(key); turnViews.set(key, view); }
        desired.set(key, view);
        const row = view.row;
        view.message = message;
        const isMe = message && message.authorType === "user";
        const isAgent = !message || message.authorType === "agent";
        const agentId = message ? message.authorId : item.targetAgentId;
        row.className = "msg-row" + (isMe ? " me" : "") + (settled ? "" : " live") + (silent ? " silent-turn" : "");
        row.title = silent ? item.reason || "" : "";
        if (invocationId) row.dataset.invocationId = invocationId;
        if (message) {
          row.id = "message-" + message.seq;
          row.dataset.messageSeq = String(message.seq);
          row.dataset.messageId = message.id;
        }
        const index = memberIndex(snapshot, agentId);
        if (!isMe && index >= 0) setMemberColor(row, index);
        text(view.avatar, isMe ? "主" : message && message.authorType === "system" ? "系" : memberName(snapshot, agentId).slice(0, 1));
        const author = message ? messageAuthorName(snapshot, message) : memberName(snapshot, agentId);
        const headerKey = JSON.stringify([author, message && message.seq, message && message.createdAt, item && item.statusLabel]);
        if (view.headerKey !== headerKey) view.head.replaceChildren(
          text(el("span", "msg-author"), author),
          text(el("span"), message ? "#" + message.seq : item.statusLabel || item.status || "处理中"),
          text(el("span"), message ? formatTime(message.createdAt) : ""),
        );
        view.headerKey = headerKey;
        view.bubble.classList.toggle("live-bubble", !settled);
        view.source.hidden = !!message;
        if (item) text(view.source, item.source ? "#" + item.source.seq + ": " + (item.source.preview || "空消息") : "等待可处理的消息");
        const stream = agentStreams.get(agentId);
        const matchesStream = stream && (!stream.invocationId || stream.invocationId === invocationId);
        const captured = !message && (snapshot.activeProcesses || []).find(process => process.invocationId === invocationId && process.agentId === agentId);
        const capturedStream = captured && { thinkingText:captured.data.thinkingText, assistantText:captured.data.answerSteps.join(""), answerSteps:captured.data.answerSteps, tools:new Map(captured.data.tools.map(tool => [tool.toolCallId,tool])) };
        if (isAgent) updateTurnProcess(view, matchesStream ? stream : capturedStream, settled);
        else { view.process.hidden = true; view.alert.hidden = true; }
        const saved = view.savedProcess;
        const historyNeeded = settled && isAgent && (!saved || saved.status !== "complete");
        view.history.hidden = !historyNeeded;
        if (historyNeeded) {
          text(view.historyNote, view.processLoading ? "正在读取历史过程…" : view.processError || (saved && saved.status === "partial" ? "已保存部分过程" : saved && saved.status === "unavailable" ? "未找到可确认归属的旧过程，原回答已保留。" : "旧过程尚未恢复"));
          view.restore.hidden = !!view.processLoading || silent;
          if (!view.processRequested && (snapshot.processAvailable || []).includes(invocationId)) void loadTurnProcess(view, message, false);
        }
        const answer = silent ? "" : message ? message.content || "" : view.stream && view.stream.assistantText || "";
        updateStreamText(view.answer, answer);
        view.answer.classList.toggle("is-collapsed", isAgent && view.toggle.getAttribute("aria-expanded") !== "true");
        view.actions.hidden = !answer;
        view.toggle.hidden = !isAgent || !answer;
        // Snapshot-only decorations are separate from the stable streaming text and disclosures.
        const decorationKey = JSON.stringify([message, item, snapshot.invocations, snapshot.deliveries, snapshot.collections]);
        if (view.decorationKey !== decorationKey) {
          const relations = message && renderRelationPills(snapshot, message);
          view.relations.replaceChildren(...(relations ? [relations] : []));
          const collection = message && (snapshot.collections || []).find(collection => collection.sourceMessageId === message.id);
          if (collection) {
            const labels = { pending:"等待开始", running:"收集中", partial:"部分完成", done:"已完成", failed:"有失败", awaiting_user:"等待用户决定" };
            view.relations.append(text(el("div", "collection-state"), "独立意见 " + collection.completed + "/" + collection.targets.length + " · " + (labels[collection.status] || collection.status) + (collection.failed ? " · " + collection.failed + " 失败" : "")));
          }
          const receipt = message && renderReceiptDock(snapshot, message);
          view.receipts.replaceChildren(...(receipt ? [receipt] : []));
          const controls = item && !silent && renderInvocationControls(snapshot, item);
          view.controls.replaceChildren(...(controls ? [controls] : []));
          const invocation = invocationId && invocationById(snapshot, invocationId);
          if (message && invocation?.outcome?.disposition === "awaiting_user") {
            view.controls.append(text(el("span", "decision-state"), invocation.outcome.resolvedByMessageId ? "已收到用户决定" : "等待用户决定"));
            if (!invocation.outcome.resolvedByMessageId) {
              const reply = text(el("button", "reply-decision"), "回复此问题");
              reply.type = "button";
              reply.addEventListener("click", () => setDecisionReply(message));
              view.controls.append(reply);
            }
          }
          view.decorationKey = decorationKey;
        }
      }
      const entries = messages.map(message => ({ message, item:null, rank:message.seq }));
      liveItems.forEach(item => entries.push({ message:null, item, rank:item.silent ? item.source.seq + 0.5 : Number.MAX_SAFE_INTEGER }));
      entries.sort((left, right) => left.rank - right.rank).forEach(entry => updateRow(entry.message, entry.item));
      // Keep an observed turn in place when its canonical final arrives, even if peers finish out of order.
      Array.from(messagesEl.children).forEach(row => {
        if (!desired.has(row.dataset.turnKey)) row.remove();
      });
      for (const [key, view] of desired) if (view.row.parentNode !== messagesEl) messagesEl.append(view.row);
      for (const [key, view] of turnViews) if (!desired.has(key)) {
        if (view.processController) view.processController.abort();
        turnViews.delete(key);
      }
      if (nearBottom && !reading && !mobile) scroller.scrollTop = scroller.scrollHeight;
      else if (anchor && anchor.isConnected) scroller.scrollTop = scrollTop + anchor.getBoundingClientRect().top - anchorTop;
      else scroller.scrollTop = scrollTop;
    }

    function scrollToMessage(seq) {
      const target = document.getElementById("message-" + seq);
      if (!target) return;
      focusMessageNode(target);
    }

    function scrollToMessageId(messageId) {
      const target = Array.from(messagesEl.querySelectorAll(".msg-row")).find(row => row.dataset.messageId === String(messageId));
      if (!target) return;
      focusMessageNode(target);
    }

	    function focusMessageNode(target) {
	      target.scrollIntoView({ behavior: "smooth", block: "center" });
	      target.classList.add("rail-focus");
	      window.setTimeout(() => target.classList.remove("rail-focus"), 1200);
	    }

	    function runtimeToneClass(item) {
	      if (!item) return "";
	      if (item.tone === "active") return "active";
	      if (item.tone === "done") return "done";
	      if (item.tone === "failed") return "failed";
	      if (item.tone === "silent") return "silent";
	      if (item.tone === "waiting") return "waiting";
	      return "queued";
	    }

	    function runtimeItemNode(snapshot, item, options) {
	      const node = el("div", "runtime-item " + runtimeToneClass(item));
	      node.style.setProperty("--target-color", memberColor(snapshot, item.targetAgentId));
	      const line = el("div", "runtime-line");
	      line.append(
	        el("span", "runtime-dot"),
	        text(el("span", "runtime-agent"), "@" + memberName(snapshot, item.targetAgentId)),
	        text(el("span", "runtime-state"), item.statusLabel || item.status || "处理中"),
	      );
	      const metaParts = [];
	      if (item.wait && item.wait.label) metaParts.push(item.wait.label);
	      if (item.startedAt) metaParts.push("开始 " + ageText(item.startedAt));
	      else if (item.updatedAt) metaParts.push("更新 " + ageText(item.updatedAt));
	      if (item.invocationId) metaParts.push("invocation " + compact(item.invocationId));
	      if (item.attempts) metaParts.push("attempts " + item.attempts);
	      if (item.lastError) metaParts.push(compactText(item.lastError, 36));
	      const meta = text(el("div", "runtime-meta"), metaParts.join(" · ") || (options && options.emptyMeta) || "");
	      node.append(line);
	      if (meta.textContent) node.append(meta);
	      if (item.source) {
	        const source = text(el("button", "runtime-source"), "#" + item.source.seq + ": " + (item.source.preview || "空消息"));
	        source.type = "button";
	        source.title = "点击定位到触发消息";
	        source.addEventListener("click", () => scrollToMessageId(item.source.id));
	        node.append(source);
	      }
	      const controls = renderInvocationControls(snapshot, item);
	      if (controls) node.append(controls);
        if (item.status === "awaiting_user" && item.final) {
          const reply = text(el("button", "reply-decision"), "回复此问题");
          reply.type = "button";
          reply.addEventListener("click", () => setDecisionReply(item.final));
          node.append(reply);
        }
	      const live = renderAgentLive(snapshot, item);
	      if (live) node.append(live);
	      return node;
	    }

	    function renderRuntimeSection(container, snapshot, items, emptyText, options) {
	      if (!items.length) {
	        container.replaceChildren(text(el("div", "runtime-empty"), emptyText));
	        return;
	      }
	      container.replaceChildren(...items.map(item => runtimeItemNode(snapshot, item, options || {})));
	    }

	    function renderRuntimeStatus(snapshot) {
	      const status = snapshot.runtimeStatus || { active: [], queued: [], recent: [], counts: { active: 0, queued: 0, handled: 0, terminalSilent: 0, failed: 0 } };
	      const activeItems = status.active || [];
	      const queuedItems = status.queued || [];
	      const recentItems = status.recent || [];
        const waitingItems = status.waiting || [];
	      runtimeActiveCountEl.textContent = activeItems.length ? String(activeItems.length) : "";
	      runtimeQueuedCountEl.textContent = queuedItems.length ? String(queuedItems.length) : "";
	      runtimeRecentCountEl.textContent = recentItems.length ? String(recentItems.length) : "";
	      runtimeCountsEl.textContent = "A" + activeItems.length + " / Q" + queuedItems.length;
	      runtimeSubEl.textContent = activeItems.length || queuedItems.length
	        ? activeItems.length + " 正在处理 · " + queuedItems.length + " 待处理"
	        : waitingItems.length ? waitingItems.length + " 项等待用户决定" : "当前没有运行中的协作回合";
	      renderRuntimeSection(runtimeActiveEl, snapshot, activeItems, "现在没有成员在跑。", { emptyMeta: "当前轮" });
	      renderRuntimeSection(runtimeQueuedEl, snapshot, queuedItems, "没有待处理消息。", { emptyMeta: "等待调度" });
	      renderRuntimeSection(runtimeRecentEl, snapshot, recentItems, "还没有完成或失败记录。", { emptyMeta: "最近回合" });
        renderRuntimeSection(document.getElementById("runtimeWaiting"), snapshot, waitingItems, "没有待决问题。", {});
	    }

	    function renderMessageRail(snapshot) {
	      const messages = (snapshot.messages || []).slice().sort((a, b) => a.seq - b.seq).slice(-120);
	      if (!messages.length) {
	        messageRailEl.replaceChildren(text(el("div", "rail-empty"), "暂无消息"));
        return;
      }
      const nodes = messages.map((message, index) => {
        const isMe = message.authorType === "user";
        const marker = el("button", "rail-marker" + (isMe ? " me" : "") + (message.wakeTargets && message.wakeTargets.length ? " has-wake" : ""));
        marker.type = "button";
        const percent = messages.length === 1 ? 6 : 3 + (index / (messages.length - 1)) * 94;
        const author = isMe ? "主公" : memberName(snapshot, message.authorId);
        const preview = (message.content || "").replace(/\\s+/g, " ").slice(0, 48);
        marker.style.top = percent.toFixed(2) + "%";
        marker.style.setProperty("--marker-color", isMe ? "#a86450" : memberColor(snapshot, message.authorId));
        marker.title = "#" + message.seq + " · " + author + " · " + formatTime(message.createdAt) + (preview ? " · " + preview : "");
        marker.setAttribute("aria-label", "定位到 " + author + " 的第 " + message.seq + " 条消息");
        marker.addEventListener("click", () => scrollToMessage(message.seq));
        return marker;
      });
      messageRailEl.replaceChildren(...nodes);
    }

    function render(snapshot, options) {
      latestSnapshot = snapshot;
      const active = snapshot.active;
      const thread = snapshot.thread;
      const queue = (snapshot.queuedInvocations || []).length + " queued, " + (snapshot.runningInvocations || []).length + " running";
      statusEl.textContent = active ? "active · " + queue : "not in Team mode";
      chatTitleEl.textContent = thread && thread.title ? thread.title : "Agent AI team";
      summaryEl.textContent = active
        ? "主公和 " + (snapshot.members || []).length + " 位成员 · " + ((snapshot.team && snapshot.team.name) || active.teamId) + " · " + ((thread && thread.status) || "missing")
        : "没有活动团队。回到 PI 里运行 /team web 会创建默认模型小组。";

      renderThreads(snapshot);
	      renderMembers(snapshot, options || {});
	      renderMessages(snapshot);
      renderRuntimeStatus(snapshot);
      renderMessageRail(snapshot);
      syncAgentStreams(snapshot);
      if (mentionState.open) updateMentionMenu();
    }

    async function refresh(options) {
      const res = await fetch("/api/snapshot" + qs);
      if (!res.ok) throw new Error("snapshot failed: " + res.status);
      render(await res.json(), options || {});
    }

    function scheduleLiveRefresh(delay) {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(async () => {
        if (refreshInFlight) {
          scheduleLiveRefresh(500);
          return;
        }
        refreshInFlight = true;
        try {
          await refresh();
        } catch {
          // Keep the room alive even if one poll races with shutdown.
        } finally {
          refreshInFlight = false;
          scheduleLiveRefresh(liveRefreshDelay(latestSnapshot));
        }
      }, delay);
    }

    async function switchThread(threadId) {
      if (!latestSnapshot || !latestSnapshot.active || latestSnapshot.active.threadId === threadId) return;
      statusEl.textContent = "切换对话…";
      const res = await fetch("/api/thread/enter" + qs, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: latestSnapshot.active.teamId, threadId }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = data.text || data.error || "切换失败";
        return;
      }
      render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: true });
      requestAnimationFrame(() => { chatScrollEl.scrollTop = chatScrollEl.scrollHeight; });
    }

    async function createThread(folderId) {
      statusEl.textContent = "创建新对话…";
      newThread.disabled = true;
      try {
        const res = await fetch("/api/thread" + qs, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "新对话", folderId }),
        });
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.text || data.error || "创建失败";
          return;
        }
        render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: true });
        input.value = "";
        input.focus();
      } finally {
        newThread.disabled = false;
      }
    }

    input.addEventListener("input", updateMentionMenu);
    input.addEventListener("click", updateMentionMenu);
    input.addEventListener("keyup", (event) => {
      if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
      updateMentionMenu();
    });
    input.addEventListener("keydown", (event) => {
      if (!mentionState.open) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveMention(mentionState.active + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveMention(mentionState.active - 1);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(mentionState.items[mentionState.active]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMentionMenu();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      closeMentionMenu();
      button.disabled = true;
      statusEl.textContent = "发送并唤醒成员…";
      try {
        const res = await fetch("/api/send" + qs, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, ...(decisionReply && decisionReply.threadId === renderedThreadId ? { replyTo: decisionReply.id } : {}) }),
        });
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = actionErrorText(data, "发送失败");
          return;
        }
        statusEl.textContent = "已发送，成员开始处理…";
        input.value = "";
        setDecisionReply(null);
        render(data.snapshot || await (await fetch("/api/snapshot" + qs)).json(), { forceMembers: false });
        scheduleLiveRefresh(250);
      } finally {
        button.disabled = false;
      }
    });

    newThread.addEventListener("click", () => createThread().catch(error => { statusEl.textContent = String(error); newThread.disabled = false; }));
    if (sharePinCopyBtn) {
      sharePinCopyBtn.addEventListener("click", async () => {
        const pin = sharePinCopyBtn.dataset.sharePin || "";
        try {
          await navigator.clipboard.writeText(pin);
          statusEl.textContent = "PIN 已复制";
        } catch {
          window.prompt("复制 PIN", pin);
        }
      });
    }
    if (shareCopyBtn) {
      shareCopyBtn.addEventListener("click", async () => {
        const loginUrl = shareCopyBtn.dataset.shareLoginUrl || "";
        try {
          await navigator.clipboard.writeText(loginUrl);
          statusEl.textContent = "手机登录链接已复制";
        } catch {
          window.prompt("复制手机登录链接", loginUrl);
        }
      });
    }
    if (shareRevokeBtn) {
      shareRevokeBtn.addEventListener("click", async () => {
        if (!window.confirm("停止手机分享并让已登录手机立即失效？")) return;
        shareRevokeBtn.disabled = true;
        statusEl.textContent = "停止手机分享…";
        try {
          const res = await fetch("/api/share/revoke" + qs, { method: "POST" });
          const data = await res.json();
          if (!data.ok) {
            statusEl.textContent = data.error || "停止分享失败";
            shareRevokeBtn.disabled = false;
            return;
          }
          document.getElementById("sharePanel")?.remove();
          statusEl.textContent = data.revoked ? "手机分享已停止" : "手机分享未开启";
        } catch (error) {
          statusEl.textContent = String(error);
          shareRevokeBtn.disabled = false;
        }
      });
    }
    organizeModeBtn.addEventListener("click", () => {
      organizeMode = !organizeMode;
      if (!organizeMode) selectedThreadIds.clear();
      if (latestSnapshot) renderThreads(latestSnapshot);
    });
    bulkMoveBtn.addEventListener("click", () => {
      const threads = selectedThreads();
      if (threads.length) openMovePanel(threads.map(thread => thread.id));
    });
    bulkArchiveBtn.addEventListener("click", () => archiveSelectedThreads().catch(error => { statusEl.textContent = String(error); }));
    bulkDeleteBtn.addEventListener("click", () => deleteSelectedThreads().catch(error => { statusEl.textContent = String(error); }));
    bulkClearBtn.addEventListener("click", clearSelection);
    moveCloseBtn.addEventListener("click", hideMovePanel);
    moveCreateBtn.addEventListener("click", () => createFolderAndMove().catch(error => { statusEl.textContent = String(error); }));
    moveFolderName.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        createFolderAndMove().catch(error => { statusEl.textContent = String(error); });
      } else if (event.key === "Escape") {
        hideMovePanel();
      }
    });
    steerClose.addEventListener("click", hideSteerPanel);
    steerSubmit.addEventListener("click", () => submitSteer().catch(error => {
      steerSubmit.disabled = false;
      steerNote.textContent = String(error);
    }));
    steerInput.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitSteer().catch(error => {
          steerSubmit.disabled = false;
          steerNote.textContent = String(error);
        });
      } else if (event.key === "Escape") {
        event.preventDefault();
        hideSteerPanel();
      }
    });
    newFolderBtn.addEventListener("click", () => {
      const name = window.prompt("新建文件夹", "Work");
      if (name !== null) createFolder(name).catch(error => { statusEl.textContent = String(error); });
    });
    renameThreadBtn.addEventListener("click", () => {
      const thread = menuThread;
      hideThreadMenu();
      if (thread) renameThread(thread).catch(error => { statusEl.textContent = String(error); });
    });
    moveThreadBtn.addEventListener("click", () => {
      const thread = menuThread;
      hideThreadMenu();
      if (thread) moveThread(thread).catch(error => { statusEl.textContent = String(error); });
    });
    archiveThreadBtn.addEventListener("click", () => {
      const thread = menuThread;
      hideThreadMenu();
      if (thread) archiveThread(thread).catch(error => { statusEl.textContent = String(error); });
    });
    restoreThreadBtn.addEventListener("click", () => {
      const thread = menuThread;
      hideThreadMenu();
      if (thread) restoreThread(thread).catch(error => { statusEl.textContent = String(error); });
    });
    deleteThreadBtn.addEventListener("click", () => {
      const thread = menuThread;
      hideThreadMenu();
      if (thread) deleteThread(thread).catch(error => { statusEl.textContent = String(error); });
    });
    document.addEventListener("click", (event) => {
      if (!threadMenu.hidden && !threadMenu.contains(event.target)) hideThreadMenu();
      const openedMovePanel = moveThreadBtn.contains(event.target) || bulkMoveBtn.contains(event.target);
      if (!movePanel.hidden && !movePanel.contains(event.target) && !openedMovePanel) hideMovePanel();
      const targetElement = event.target instanceof Element ? event.target : null;
      if (!steerPanel.hidden && !steerPanel.contains(event.target) && !targetElement?.closest(".invocation-control")) hideSteerPanel();
      if (mentionState.open && event.target !== input && !mentionMenuEl.contains(event.target)) closeMentionMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideThreadMenu();
      if (event.key === "Escape") hideMovePanel();
      if (event.key === "Escape") hideSteerPanel();
    });
    searchEl.addEventListener("input", () => { if (latestSnapshot) renderThreads(latestSnapshot); });
    refreshBtn.addEventListener("click", () => refresh({ forceMembers: true }).catch(error => { statusEl.textContent = String(error); }));
    refresh({ forceMembers: true }).then(() => {
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
      scheduleLiveRefresh(liveRefreshDelay(latestSnapshot));
    }).catch(error => { statusEl.textContent = String(error); scheduleLiveRefresh(2500); });
  </script>
</body>
</html>`;
  }

  private formatStatus(): string {
    if (!this.currentActive()) return "Not in Team mode. Use team.runtime.setup or team.runtime.enter.";
    const active = this.requireActive();
    const store = this.requireStore();
    const team = store.getTeam(active.teamId);
    const thread = store.getThread(active.threadId);
    const members = store.listMembers(active.teamId, true);
    const messages = store.listMessages(active.threadId);
    const queued = store.listInvocations({ threadId: active.threadId, status: "queued" });
    return [
      `Team: ${team?.name ?? active.teamId} [${active.teamId}]`,
      `Thread: ${thread?.title ?? active.threadId} [${active.threadId}] (${thread?.status ?? "missing"})`,
      `Persistent members: ${members.length}`,
      `Messages: ${messages.length}`,
      `Queued invocations: ${queued.length}`,
    ].join("\n");
  }

  private formatTeamList(teams = this.requireStore().listTeams(false).filter((team) => team.ownerId === this.requirePrincipal())): string {
    if (!teams.length) return "No persistent Teams.";
    const active = this.currentActive();
    return teams.map((team) => `${team.name} [${team.id}]${team.id === active?.teamId ? " (current)" : ""}`).join("\n");
  }

  private requireStore(): TeamStore {
    if (!this.store) throw new TeamRuntimeError("not_found", "Team runtime is not started");
    return this.store;
  }

  private requireCoordinator(): TeamCoordinator {
    if (!this.coordinator) throw new TeamRuntimeError("not_found", "Team runtime is not started");
    return this.coordinator;
  }

  private requireRuntime(): AgentRuntime {
    if (!this.runtime) throw new TeamRuntimeError("not_found", "Team runtime is not started");
    return this.runtime;
  }

  private currentActive(): HostContext | undefined {
    const slot = this.activeContextSlot.getStore();
    return slot ? slot.context : this.active;
  }

  private setCurrentActiveContext(teamId: string, threadId: string): HostContext {
    const slot = this.activeContextSlot.getStore();
    if (!slot) {
      const context = this.requireStore().setHostContextForPrincipal(
        this.hostSessionId!,
        this.requirePrincipal(),
        teamId,
        threadId,
      );
      this.active = context;
      return context;
    }
    const store = this.requireStore();
    const team = store.getTeam(teamId);
    if (!team) throw new TeamRuntimeError("not_found", `Team not found: ${teamId}`);
    const thread = store.getThread(threadId);
    if (!thread) throw new TeamRuntimeError("not_found", `Thread not found: ${threadId}`);
    if (thread.teamId !== team.id) {
      throw new TeamRuntimeError("conflict", `Thread ${threadId} does not belong to team ${teamId}`, { teamId, threadId });
    }
    slot.context = {
      hostSessionId: this.hostSessionId!,
      principalId: this.requirePrincipal(),
      teamId,
      threadId,
      updatedAt: nowIso(),
    };
    return slot.context;
  }

  private clearCurrentActiveContext(): boolean {
    const slot = this.activeContextSlot.getStore();
    if (slot) {
      const hadActive = Boolean(slot.context);
      slot.context = undefined;
      return hadActive;
    }
    const cleared = this.requireStore().clearHostContextForPrincipal(this.requirePrincipal());
    this.active = undefined;
    return cleared;
  }

  private requireActive(): HostContext {
    const active = this.currentActive();
    if (!active) throw new TeamRuntimeError("not_found", "Not in Team mode. Use team.runtime.setup or team.runtime.enter.");
    const team = this.requireStore().getTeam(active.teamId);
    if (!team) throw new TeamRuntimeError("not_found", `Team not found: ${active.teamId}`);
    if (!this.principal || team.ownerId !== this.principal) {
      throw new TeamRuntimeError("permission_denied", `Principal does not own Team ${active.teamId}`);
    }
    return active;
  }

  private resolvePrincipal(ctx: ExtensionContext): string {
    const principal = (this.options.principalId?.(ctx) ?? "local-user").trim();
    if (!principal) throw new TeamRuntimeError("permission_denied", "principalId must be a non-empty stable identity");
    return principal;
  }

  private requirePrincipal(): string {
    if (!this.principal) throw new TeamRuntimeError("permission_denied", "Stable principal is unavailable");
    return this.principal;
  }
}
