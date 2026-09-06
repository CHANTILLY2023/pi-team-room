export const TEAM_MEMORY_TYPES = ["decision", "interface", "risk", "handoff"] as const;

export type TeamMemoryType = typeof TEAM_MEMORY_TYPES[number];

export interface TeamState {
  name: string;
  profile?: string;
  created_at: string;
  updated_at: string;
}

export interface TeamRoleDefinition {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  skills?: string[];
  prompt?: string;
  promptSource?: string;
}

export interface TeamProfile {
  name: string;
  description?: string;
  roles?: Record<string, Partial<TeamRoleDefinition>>;
  approval?: {
    mode?: "off" | "risk-labels";
    labels?: string[];
  };
  memory?: {
    inject?: TeamMemoryType[];
    maxCharsPerType?: number;
  };
}

export interface TeamMemoryEntry {
  ts: string;
  agent: string;
  type: TeamMemoryType;
  message: string;
  taskId?: string;
}

export interface TeamPromptContext {
  team?: TeamState;
  profile?: TeamProfile;
  role?: TeamRoleDefinition;
  charter?: string;
  memory: Partial<Record<TeamMemoryType, TeamMemoryEntry[]>>;
}
