import type { SelectionSpec, ThinkingLevel } from "./types.ts";

export interface RuntimeSubagentSpec {
  label: string;
  systemPrompt: string;
  tools: SelectionSpec;
  skills: SelectionSpec;
  modelId: string;
  thinking: ThinkingLevel;
}

export interface SpawnInput {
  task: string;
  role?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  label?: string;
}

export interface ResolutionContext {
  parentModelId: string;
  parentThinking: ThinkingLevel;
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
}

export function resolveSpec(
  input: SpawnInput,
  context: ResolutionContext,
): RuntimeSubagentSpec {
  return {
    label: deriveLabel(input),
    systemPrompt: buildSystemPrompt(input.role),
    tools: input.tools === undefined ? "all" : [...input.tools],
    skills: input.skills === undefined ? "all" : [...input.skills],
    modelId: input.model ?? context.defaultModel ?? context.parentModelId,
    thinking: input.thinking ?? context.defaultThinking ?? context.parentThinking,
  };
}

export function buildSystemPrompt(role: string | undefined): string {
  if (role && role.trim().length > 0) {
    return `You are a subagent.\n\n${role.trim()}`;
  }
  return "You are a subagent. Follow the task instructions exactly and reply with your results.";
}

export function buildHarnessPrompt(task: string, isFollowUp: boolean): string {
  const kind = isFollowUp ? "Follow-up task" : "Task";
  return [
    `${kind} from the parent agent. Complete it and reply with your results.`,
    "",
    "<parent_task>",
    task,
    "</parent_task>",
  ].join("\n");
}

export function deriveLabel(input: SpawnInput): string {
  if (input.label) return sanitizeLabel(input.label);
  return sanitizeLabel(input.task.slice(0, 20)) || "subagent";
}

export function sanitizeLabel(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent";
}
