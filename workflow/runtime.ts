import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { findRuntimeModelById, formatModelId } from "../shared/models.ts";
import type { ThinkingLevel } from "../shared/types.ts";
import { createBoundAgent } from "./agent.ts";
import { BudgetTracker } from "./budget.ts";
import { Journal } from "./journal.ts";
import { parallel } from "./parallel.ts";
import { pipeline } from "./pipeline.ts";
import { log, phase } from "./progress.ts";
import { Semaphore } from "./semaphore.ts";
import type { AgentOptions, AgentResult, WorkflowBudget, WorkflowConfig } from "./types.ts";

export interface WorkflowContext {
  cwd: string;
  budget: WorkflowBudget;
  budgetTracker: BudgetTracker;
  journal: Journal;
  semaphore: Semaphore;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  defaultModelId: string;
  defaultThinking: ThinkingLevel;
}

export interface WorkflowRuntime {
  agent<T = string>(task: string, options?: AgentOptions): Promise<AgentResult<T>>;
  parallel: typeof parallel;
  pipeline: typeof pipeline;
  phase: typeof phase;
  log: typeof log;
  args: Record<string, unknown>;
  budget: BudgetTracker;
  journal: Journal;
}

const DEFAULT_BUDGET: WorkflowBudget = {
  maxConcurrentAgents: 4,
  maxTotalAgents: 100,
  maxRuntime: Number.POSITIVE_INFINITY,
  maxRetriesPerItem: 2,
};

export async function createWorkflowRuntime(config: WorkflowConfig = {}): Promise<WorkflowRuntime> {
  const context = await createWorkflowContext(config);
  return {
    agent: createBoundAgent(context),
    parallel,
    pipeline,
    phase,
    log,
    args: config.args ?? {},
    budget: context.budgetTracker,
    journal: context.journal,
  };
}

export async function createWorkflowContext(config: WorkflowConfig = {}): Promise<WorkflowContext> {
  const cwd = config.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const custom = getSubagentWorkflowSettings(settingsManager);
  const model = await resolveDefaultModel(modelRuntime, settingsManager, custom.defaultModel);
  const budget: WorkflowBudget = {
    ...DEFAULT_BUDGET,
    maxConcurrentAgents: custom.maxConcurrentSubagents ?? DEFAULT_BUDGET.maxConcurrentAgents,
    ...config.budget,
  };
  const journal = new Journal({
    dir: config.journal?.dir ?? join(cwd, ".pi-subagent-workflows", "journals"),
    enabled: config.journal?.enabled,
  });
  await journal.load();
  const context: WorkflowContext = {
    cwd,
    budget,
    budgetTracker: new BudgetTracker(budget),
    journal,
    semaphore: new Semaphore(budget.maxConcurrentAgents),
    modelRuntime,
    settingsManager,
    defaultModelId: formatModelId(model),
    defaultThinking: custom.defaultThinking ?? settingsManager.getDefaultThinkingLevel() ?? "medium",
  };
  return context;
}

async function resolveDefaultModel(
  runtime: ModelRuntime,
  settings: SettingsManager,
  workflowDefault: string | undefined,
): Promise<Model<any>> {
  if (workflowDefault) {
    const model = findRuntimeModelById(workflowDefault, runtime);
    if (model) return model;
    throw new Error(`Configured subagentWorkflows.defaultModel was not found: ${workflowDefault}`);
  }
  const defaultModel = settings.getDefaultModel();
  const defaultProvider = settings.getDefaultProvider();
  if (defaultModel && defaultProvider) {
    const model = runtime.getModel(defaultProvider, defaultModel);
    if (model) return model;
  }
  const available = await runtime.getAvailable();
  if (available.length === 0) throw new Error("No configured model is available for workflow agents.");
  return available[0]!;
}

function getSubagentWorkflowSettings(settings: SettingsManager): {
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
  maxConcurrentSubagents?: number;
} {
  const global = settings.getGlobalSettings() as unknown as Record<string, unknown>;
  const project = settings.getProjectSettings() as unknown as Record<string, unknown>;
  const merged = {
    ...asRecord(global.subagentWorkflows),
    ...asRecord(project.subagentWorkflows),
  };
  return {
    defaultModel: typeof merged.defaultModel === "string" ? merged.defaultModel : undefined,
    defaultThinking: isThinkingLevel(merged.defaultThinking) ? merged.defaultThinking : undefined,
    maxConcurrentSubagents: typeof merged.maxConcurrentSubagents === "number" && merged.maxConcurrentSubagents > 0
      ? Math.floor(merged.maxConcurrentSubagents)
      : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}
