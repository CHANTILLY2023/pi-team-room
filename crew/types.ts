/**
 * Crew - Type Definitions
 * 
 * Simplified PRD-based workflow types.
 */

import type { MaxOutputConfig } from "./utils/truncate.ts";
import type { AgentProgress } from "./utils/progress.ts";
import type { CrewAgentConfig } from "./utils/discover.ts";

// =============================================================================
// Plan Types
// =============================================================================

export interface Plan {
  prd: string;                   // Path to PRD file (relative to cwd)
  prompt?: string;               // Inline prompt text (when no PRD file)
  created_at: string;            // ISO timestamp
  updated_at: string;            // ISO timestamp
  task_count: number;            // Total tasks
  completed_count: number;       // Completed tasks
}

// =============================================================================
// Task Types
// =============================================================================

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface TaskEvidence {
  commits?: string[];            // Commit SHAs
  tests?: string[];              // Test commands/files run
  prs?: string[];                // PR URLs
}

export type TaskApprovalDecisionStatus = "pending" | "approved" | "rejected";
export type TaskApprovalStatus = "not_required" | TaskApprovalDecisionStatus;

interface TaskApprovalMetadata {
  plan?: string;
  feedback?: string;
  decided_by?: string;
  decided_at?: string;
}

export type TaskApproval =
  | ({ required: false; status: "not_required" } & TaskApprovalMetadata)
  | ({ required: true; status: TaskApprovalDecisionStatus } & TaskApprovalMetadata);

export interface Task {
  id: string;                    // task-N format
  title: string;
  status: TaskStatus;
  milestone?: boolean;
  model?: string;
  role?: string;                 // Team role assignment
  risk_labels?: string[];        // Team risk labels for approval policy
  approval?: TaskApproval;       // Team lead approval state
  depends_on: string[];          // Task IDs this depends on
  skills?: string[];             // Skill names from planner
  created_at: string;            // ISO timestamp
  updated_at: string;            // ISO timestamp
  started_at?: string;           // When task.start was called
  completed_at?: string;         // When task.done was called
  base_commit?: string;          // Git commit SHA at task.start
  assigned_to?: string;          // Agent name currently working on it
  summary?: string;              // Completion summary from task.done
  evidence?: TaskEvidence;       // Evidence from task.done
  blocked_reason?: string;       // Reason from task.block
  attempt_count: number;         // How many times attempted (for auto-block)
  review_count?: number;         // How many times reviewed
  last_review?: ReviewFeedback;  // Feedback from last review (for retry)
}

export interface ReviewFeedback {
  verdict: ReviewVerdict;
  summary: string;
  issues: string[];
  suggestions: string[];
  reviewed_at: string;           // ISO timestamp
}

// =============================================================================
// Crew Params (Tool Parameters)
// =============================================================================

export interface CrewParams {
  // Action
  action?: string;

  // Plan
  prd?: string;                  // PRD file path for plan action

  // Task IDs
  id?: string;                   // Task ID (task-N)
  taskId?: string;               // Swarm task ID (for claim/unclaim/complete)

  // Creation
  title?: string;
  dependsOn?: string[];
  role?: string;
  riskLabels?: string[];
  approval?: TaskApproval;

  // Completion
  summary?: string;
  evidence?: TaskEvidence;

  // Content
  content?: string;                // Task description/spec content
  count?: number;
  subtasks?: { title: string; content?: string }[];

  // Review / Team memory
  target?: string;               // Task ID to review
  type?: "plan" | "impl" | "decision" | "interface" | "risk" | "handoff";

  // Plan options
  autoWork?: boolean;

  // Work options
  autonomous?: boolean;
  concurrency?: number;
  model?: string;

  // Task reset
  cascade?: boolean;

  // Revision
  prompt?: string;

  // Feed
  limit?: number;

  // Coordination
  spec?: string;
  to?: string | string[];
  message?: string;
  replyTo?: string;
  paths?: string[];
  reason?: string;
  name?: string;
  teamId?: string;
  threadId?: string;
  threadIds?: string[];
  folderId?: string;
  folderIds?: string[];
  agentId?: string;
  memoryId?: string;
  sourceMessageId?: string;
  clientId?: string;
  provider?: string;
  thinking?: string;
  skills?: string[];
  skillRefs?: string[];
  aliases?: string[];
  runtimePolicy?: "always_on" | "idle_timeout" | "on_demand";
  makeDefault?: boolean;
  idempotencyKey?: string;
  scope?: "team" | "thread" | "agent_private";
  visibility?: "team" | "direct" | "private";
  visibleTo?: string[];
  metadata?: Record<string, unknown>;
  port?: number;
  open?: boolean;
  memberLimit?: number;
  probe?: boolean;
  turns?: number;
  notes?: string;
  autoRegisterPath?: "add" | "remove" | "list";
}

// =============================================================================
// Review Types
// =============================================================================

export type ReviewVerdict = "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK";

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  issues?: string[];
  suggestions?: string[];
}

// =============================================================================
// Agent Spawning Types
// =============================================================================

export interface AgentTask {
  agent: string;
  task: string;
  taskId?: string;
  modelOverride?: string;
  maxOutput?: MaxOutputConfig;
}

export interface AgentResult {
  agent: string;
  exitCode: number;
  output: string;
  truncated: boolean;
  progress: AgentProgress;
  config?: CrewAgentConfig;
  taskId?: string;
  wasGracefullyShutdown?: boolean;
  error?: string;
  artifactPaths?: {
    input: string;
    output: string;
    jsonl: string;
    metadata: string;
  };
}

// =============================================================================
// Callback Types
// =============================================================================

export type AppendEntryFn = (type: string, data: unknown) => void;
