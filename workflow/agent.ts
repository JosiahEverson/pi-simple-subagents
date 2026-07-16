import { randomBytes } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { emptyUsage, getFinalAssistantText, summarizeUsage } from "../shared/messages.ts";
import { findRuntimeModelById, resolveScopedModels } from "../shared/models.ts";
import { buildHarnessPrompt, resolveSpec } from "../shared/spec.ts";
import { filterSkillSelection, filterToolSelection } from "../shared/tools.ts";
import {
  AgentFailedError,
  type BudgetTracker,
  BudgetExceededError,
  WorkflowAbortedError,
} from "./budget.ts";
import { deriveJournalKey, journalInputsEqual, type Journal } from "./journal.ts";
import { agentCompleted } from "./progress.ts";
import {
  appendSchemaInstruction,
  buildCorrectionPrompt,
  canonicalizeSchema,
  SchemaValidationError,
  shouldRetry,
  validateOutput,
} from "./schema.ts";
import type { WorkflowContext } from "./runtime.ts";
import type { AgentOptions, AgentResult, JournalInput } from "./types.ts";

let defaultContext: Promise<WorkflowContext> | undefined;

export function agent<T = string>(
  task: string,
  options: AgentOptions = {},
): Promise<AgentResult<T>> {
  const canonicalSchema = options.schema ? canonicalizeSchema(options.schema) : undefined;
  return getDefaultContext().then((context) => runAgent<T>(context, task, options, canonicalSchema));
}

export function createBoundAgent(context: WorkflowContext) {
  return <T = string>(task: string, options: AgentOptions = {}) => {
    const canonicalSchema = options.schema ? canonicalizeSchema(options.schema) : undefined;
    return runAgent<T>(context, task, options, canonicalSchema);
  };
}

async function getDefaultContext(): Promise<WorkflowContext> {
  if (!defaultContext) {
    defaultContext = import("./runtime.ts").then(({ createWorkflowContext }) => createWorkflowContext());
  }
  return defaultContext;
}

async function runAgent<T>(
  context: WorkflowContext,
  task: string,
  options: AgentOptions,
  canonicalSchema: string | undefined,
): Promise<AgentResult<T>> {
  const release = await context.semaphore.acquire();
  const startedAt = Date.now();
  let agentId: string | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let usage = emptyUsage();
  let usageRecorded = false;
  let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeAborted = false;
  try {
    const spec = resolveSpec({ task, ...options }, {
      parentModelId: context.defaultModelId,
      parentThinking: context.defaultThinking,
      defaultModel: context.defaultModelId,
      defaultThinking: context.defaultThinking,
    });
    agentId = `${spec.label}-${randomBytes(3).toString("hex")}`;

    if (options.model !== undefined) {
      const scoped = await resolveScopedModels(context.modelRuntime, context.settingsManager);
      if (!scoped.ids.includes(options.model)) {
        throw new AgentFailedError(
          `Model "${options.model}" is outside Pi's enabledModels scope. Choose a model returned by enabledModels.`,
          agentId,
          truncateTask(task),
          usage,
        );
      }
    }

    const input: JournalInput = {
      task: task.trim(),
      spec,
      schema: canonicalSchema,
    };
    const key = deriveJournalKey(input);
    const cached = resolveJournalHitOrReserveSpawn(context.journal, context.budgetTracker, key, input);
    if (cached) return cached as AgentResult<T>;

    scheduleRuntimeAbort();
    const model = findRuntimeModelById(spec.modelId, context.modelRuntime);
    if (!model) throw new Error(`Model "${spec.modelId}" was not found.`);
    const warnings: string[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      settingsManager: context.settingsManager,
      systemPromptOverride: () => spec.systemPrompt,
      noExtensions: true,
      skillsOverride: (base) => {
        const filtered = filterSkillSelection(base.skills.map((skill) => skill.name), spec.skills);
        warnings.push(...filtered.warnings);
        const selected = new Set(filtered.selected);
        return { ...base, skills: base.skills.filter((skill) => selected.has(skill.name)) };
      },
    });
    await resourceLoader.reload();
    if (runtimeAborted) throw context.budgetTracker.runtimeAbortError();
    const created = await createAgentSession({
      cwd: context.cwd,
      model,
      thinkingLevel: spec.thinking,
      modelRuntime: context.modelRuntime,
      settingsManager: context.settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(context.cwd),
    });
    session = created.session;
    if (runtimeAborted) {
      await session.abort();
      throw context.budgetTracker.runtimeAbortError();
    }
    const toolSelection = filterToolSelection(session.getAllTools().map((tool) => tool.name), spec.tools);
    warnings.push(...toolSelection.warnings);
    session.setActiveToolsByName(toolSelection.selected);

    const initialPrompt = options.schema
      ? appendSchemaInstruction(buildHarnessPrompt(task, false), options.schema)
      : buildHarnessPrompt(task, false);
    await session.prompt(initialPrompt, { expandPromptTemplates: false });
    if (runtimeAborted) throw context.budgetTracker.runtimeAbortError();
    let raw = getFinalAssistantText(session.messages);
    let output: unknown = raw;
    if (options.schema) {
      let attempt = 0;
      let validation = validateOutput(raw, options.schema);
      while (shouldRetry(validation, attempt, context.budget.maxRetriesPerItem)) {
        await session.prompt(buildCorrectionPrompt(validation.errors ?? [], options.schema), {
          expandPromptTemplates: false,
        });
        if (runtimeAborted) throw context.budgetTracker.runtimeAbortError();
        attempt += 1;
        raw = getFinalAssistantText(session.messages);
        validation = validateOutput(raw, options.schema);
      }
      if (!validation.valid) {
        usage = summarizeUsage(session.messages);
        recordUsage();
        throw new SchemaValidationError(
          validation.errors ?? ["Unknown schema validation error."],
          agentId,
          truncateTask(task),
          usage,
        );
      }
      output = validation.parsed;
    }
    usage = summarizeUsage(session.messages);
    recordUsage();
    const result: AgentResult<T> = { output: output as T, usage, agentId };
    await context.journal.record(key, input, result as AgentResult<unknown>);
    if (runtimeAborted) throw context.budgetTracker.runtimeAbortError();
    agentCompleted(agentId, Date.now() - startedAt, usage);
    return result;
  } catch (error) {
    if (runtimeAborted) {
      if (session) usage = summarizeUsage(session.messages);
      recordUsage();
      throw new WorkflowAbortedError(
        context.budgetTracker.runtimeAbortError().message,
        agentId,
        truncateTask(task),
        usage,
      );
    }
    if (error instanceof SchemaValidationError || error instanceof AgentFailedError) throw error;
    if (error instanceof BudgetExceededError) {
      throw new BudgetExceededError(error.limit, error.current, error.max, {
        agentId,
        task: truncateTask(task),
        usage,
      });
    }
    if (error instanceof WorkflowAbortedError) {
      throw new WorkflowAbortedError(error.message, agentId, truncateTask(task), usage);
    }
    if (session) usage = summarizeUsage(session.messages);
    recordUsage();
    throw new AgentFailedError(
      error instanceof Error ? error.message : String(error),
      agentId,
      truncateTask(task),
      usage,
      { cause: error },
    );
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    session?.dispose();
    release();
  }

  function scheduleRuntimeAbort(): void {
    const remaining = context.budgetTracker.remainingRuntimeMs();
    if (!Number.isFinite(remaining)) return;
    runtimeTimer = setTimeout(() => {
      const nextRemaining = context.budgetTracker.remainingRuntimeMs();
      if (nextRemaining > 0) {
        scheduleRuntimeAbort();
        return;
      }
      runtimeAborted = true;
      void session?.abort().catch(() => undefined);
    }, Math.min(remaining, 2_147_483_647));
  }

  function recordUsage(): void {
    if (usageRecorded) return;
    context.budgetTracker.recordUsage(usage);
    usageRecorded = true;
  }
}

export function resolveJournalHitOrReserveSpawn(
  journal: Pick<Journal, "get">,
  budgetTracker: Pick<BudgetTracker, "checkBeforeSpawn">,
  key: string,
  input: JournalInput,
): AgentResult<unknown> | undefined {
  const cached = journal.get(key);
  if (cached && journalInputsEqual(cached.input, input)) return cached.result;
  budgetTracker.checkBeforeSpawn();
  return undefined;
}

function truncateTask(task: string): string {
  return task.length > 200 ? `${task.slice(0, 197)}...` : task;
}
