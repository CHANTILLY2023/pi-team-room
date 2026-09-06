import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TeamRuntimeManager, type TeamRuntimeActionParams } from "./extension.ts";

function normalizeAction(action: string | undefined): string {
  const trimmed = action?.trim();
  if (!trimmed) return "team.runtime.status";
  if (trimmed === "team.runtime" || trimmed.startsWith("team.runtime.")) return trimmed;
  if (trimmed === "add") return "team.runtime.agent.add";
  if (trimmed === "pending") return "team.runtime.run.pending";
  if (trimmed === "seal") return "team.runtime.thread.seal";
  return `team.runtime.${trimmed}`;
}

export default function persistentTeamExtension(pi: ExtensionAPI) {
  const teamRuntime = new TeamRuntimeManager(pi);
  teamRuntime.register();

  pi.registerTool({
    name: "pi_team",
    label: "Persistent PI Team",
    description: `Persistent PI Agent Team runtime.

Simple default room:
  pi_team({ action: "web" })                 // Opens the Web room; empty Teams initialize from detected connectors

Short actions:
  pi_team({ action: "send", message: "@all discuss this" })
  pi_team({ action: "status" })
  pi_team({ action: "members" })
  pi_team({ action: "history" })
  pi_team({ action: "pending" })
  pi_team({ action: "seal" })

Advanced manual setup:
  pi_team({ action: "setup", name: "core-team" })
  pi_team({ action: "add", name: "Alice", model: "openai/gpt-5" })

Full team.runtime.* actions are also accepted.`,
    promptSnippet:
      "Use pi_team for persistent PI Agent Teams. Prefer action:web to open the default Web room; empty Teams initialize from detected local connectors and PI models.",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "Short action such as setup/add/send/status, or full team.runtime.* action" })),
      name: Type.Optional(Type.String({ description: "Team or Agent name" })),
      agentId: Type.Optional(Type.String({ description: "Stable persistent Agent ID" })),
      teamId: Type.Optional(Type.String({ description: "Persistent Team ID" })),
      threadId: Type.Optional(Type.String({ description: "Canonical Thread ID" })),
      invocationId: Type.Optional(Type.String({ description: "Persistent Team Invocation ID for cancel/steer controls" })),
      reason: Type.Optional(Type.String({ description: "Optional reason for cancelling a Team Invocation" })),
      clientId: Type.Optional(Type.String({ description: "Runtime client path for a persistent Team Agent: pi, kimi-code, claude-code, codex-cli, grok-build, or grok-pi; legacy kimi/claude/codex/grok are accepted" })),
      provider: Type.Optional(Type.String({ description: "PI model provider for a persistent Team Agent" })),
      model: Type.Optional(Type.String({ description: "PI model, or provider/model" })),
      thinking: Type.Optional(Type.String({ description: "PI thinking level for a persistent Team Agent" })),
      role: Type.Optional(Type.String({ description: "Role label for a persistent Team Agent" })),
      roleDescription: Type.Optional(Type.String({ description: "Structured role responsibility text" })),
      personality: Type.Optional(Type.String({ description: "Structured role voice/personality text" })),
      teamStrengths: Type.Optional(Type.String({ description: "Structured strengths used for teammate routing" })),
      caution: Type.Optional(Type.String({ description: "Structured routing boundary/caution text" })),
      rolePrompt: Type.Optional(Type.String({ description: "Editable role prompt/persona instructions for a persistent Team Agent" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names or PI-compatible paths for a persistent Team Agent" })),
      skillRefs: Type.Optional(Type.Array(Type.String(), { description: "Explicit PI skill names or paths for a persistent Team Agent" })),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "Mention aliases for a persistent Team Agent" })),
      runtimePolicy: Type.Optional(Type.String({ description: "always_on, idle_timeout, or on_demand" })),
      makeDefault: Type.Optional(Type.Boolean({ description: "Make this Agent the default target for unmentioned Team input" })),
      message: Type.Optional(Type.String({ description: "Team-visible message or memory content" })),
      memoryId: Type.Optional(Type.String({ description: "Durable Team runtime memory ID" })),
      sourceMessageId: Type.Optional(Type.String({ description: "Canonical source message for memory provenance" })),
      scope: Type.Optional(Type.String({ description: "team, thread, or agent_private" })),
      visibility: Type.Optional(Type.String({ description: "team, direct, or private" })),
      visibleTo: Type.Optional(Type.Array(Type.String(), { description: "Stable Agent IDs authorized for direct/private memory" })),
      metadata: Type.Optional(Type.Any({ description: "Structured metadata for a durable memory record" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of history or memory records" })),
      idempotencyKey: Type.Optional(Type.String({ description: "Client idempotency key for durable Team messages" })),
      port: Type.Optional(Type.Number({ description: "Localhost port for the Team Web UI" })),
      open: Type.Optional(Type.Boolean({ description: "Open the Team Web UI in the browser" })),
      memberLimit: Type.Optional(Type.Number({ description: "Maximum detected default members to initialize for an empty Team" })),
      share: Type.Optional(Type.Boolean({ description: "Explicitly enable Team Web mobile share through a configured self-hosted frp/rathole tunnel" })),
      shareTtlHours: Type.Optional(Type.Number({ description: "Mobile Team Web session TTL in hours for share mode (default 12)" })),
      shareProvider: Type.Optional(Type.String({ description: "Team Web share provider: frp or rathole" })),
      shareUrl: Type.Optional(Type.String({ description: "Public Team Web root URL exposed by the self-hosted frp/rathole tunnel" })),
      shareCommand: Type.Optional(Type.String({ description: "Optional manual tunnel command hint; Team Web records but does not execute it" })),
      shareConfigPath: Type.Optional(Type.String({ description: "Optional frp/rathole config path hint; Team Web records but does not read secrets from it" })),
      shareAutoStart: Type.Optional(Type.Boolean({ description: "Auto-start the configured frp/rathole client when shareConfigPath or local share config is present" })),
      probe: Type.Optional(Type.Boolean({ description: "For team.runtime.doctor, run a real hello probe instead of local-only checks" })),
      turns: Type.Optional(Type.Number({ description: "For doctor probe, number of turns to run; defaults to 2" })),
    }),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as TeamRuntimeActionParams & { action?: string };
      return teamRuntime.handleAction(normalizeAction(params.action), params, ctx, signal);
    },
  });
}
