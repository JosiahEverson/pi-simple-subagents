import type { UsageSummary } from "../shared/messages.ts";
import type { RuntimeSubagentSpec } from "../shared/spec.ts";
import type { ThinkingLevel } from "../shared/types.ts";

export type { UsageSummary } from "../shared/messages.ts";

export interface WorkflowConfig {
  cwd?: string;
  budget?: Partial<WorkflowBudget>;
  journal?: JournalConfig;
  args?: Record<string, unknown>;
}

export interface WorkflowBudget {
  maxConcurrentAgents: number;
  maxTotalAgents: number;
  maxRuntime: number;
  maxRetriesPerItem: number;
  maxTotalTokens?: number;
  maxTotalCost?: number;
}

export interface AgentOptions {
  role?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  label?: string;
  schema?: object;
}

export interface AgentResult<T = string> {
  output: T;
  usage: UsageSummary;
  agentId: string;
}

export interface JournalConfig {
  dir?: string;
  enabled?: boolean;
}

export interface JournalInput {
  task: string;
  spec: RuntimeSubagentSpec;
  /** Canonical JSON for the requested output schema; absent for unstructured output. */
  schema?: string;
}

export interface JournalEntry {
  key: string;
  input: JournalInput;
  result: AgentResult<unknown>;
  completedAt: string;
}
