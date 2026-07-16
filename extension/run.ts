import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  completeSimple,
  type ImageContent,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai/compat";
import {
  extractAssistantText,
  getFinalAssistantText,
  isAssistantMessage,
  summarizeUsage,
  type UsageSummary,
} from "../shared/messages.ts";
import { findModelById, formatModelId, isScopedModelId, resolveScopedModels } from "../shared/models.ts";
import {
  buildHarnessPrompt,
  resolveSpec,
  type RuntimeSubagentSpec,
  type SpawnInput,
} from "../shared/spec.ts";
import { filterSkillSelection, filterToolSelection } from "../shared/tools.ts";
import type { ThinkingLevel } from "../shared/types.ts";
import type { RegistryRecord, SubagentRegistry } from "./registry.ts";
import { Semaphore } from "./semaphore.ts";
import { loadSettings, positiveNumber, type SimpleSubagentsSettings } from "./settings.ts";

const SUBAGENT_EXTENSION_EXCLUDE_PATH_PARTS = ["/pi-session-naming/"] as const;
const DEFAULT_SOFT_TIMEOUT_MINUTES = 30;
const DEFAULT_HARD_TIMEOUT_MINUTES = 45;
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;
const TIMEOUT_ABORT_MESSAGE = "[hard timeout - subagent aborted] Use message_subagent to resume.";
const TIMEOUT_SUMMARY_PREFIX = "[hard timeout - session summarized]";
const SOFT_TIMEOUT_PROMPT =
  "Your time budget is nearly exhausted. Wrap up now. Finish only what is already in flight, then produce your final report. Explicitly tell the main agent what you were unable to finish and what remains to be done.";

export interface SubagentToolDetails {
  subagent_id?: string;
  sessionFile?: string;
  elapsedMs?: number;
  model?: string;
  thinking?: ThinkingLevel;
  usage?: UsageSummary;
  warnings?: string[];
}

interface MessageParams {
  subagent_id: string;
  prompt: string;
}

let semaphore: Semaphore | undefined;

export async function executeGetScopedModels(
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
  try {
    const scoped = await getScopedModelOptions(ctx);
    return {
      content: [{
        type: "text",
        text: scoped.options.map((option) => option.id).join("\n") || "No scoped models available.",
      }],
      details: { warnings: scoped.warnings },
    };
  } catch (error) {
    return executionErrorResult(error, [ctx.signal], {});
  }
}

export async function executeSpawnSubagent(
  pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">,
  registry: SubagentRegistry,
  params: SpawnInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  selfExtensionPath: string,
): Promise<AgentToolResult<SubagentToolDetails>> {
  let id: string | undefined;
  try {
    return await executeSpawnSubagentUnchecked(
      pi, registry, params, signal, onUpdate, ctx, selfExtensionPath,
      (createdId) => { id = createdId; },
    );
  } catch (error) {
    return executionErrorResult(
      error,
      [signal, ctx.signal],
      id ? { subagent_id: id } : {},
      id,
    );
  }
}

async function executeSpawnSubagentUnchecked(
  pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">,
  registry: SubagentRegistry,
  params: SpawnInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  selfExtensionPath: string,
  onId: (id: string) => void,
): Promise<AgentToolResult<SubagentToolDetails>> {
  const settings = loadSettings();
  let scopeWarnings: string[] = [];
  if (params.model !== undefined) {
    const scoped = await getScopedModelOptions(ctx);
    scopeWarnings = scoped.warnings;
    if (!isScopedModelId(params.model, scoped.options.map((option) => option.id))) {
      return errorResult(
        "MODEL_NOT_SCOPED",
        `Model override was not returned by get_scoped_models: ${params.model}`,
        { warnings: scopeWarnings },
      );
    }
  }

  const parentModelId = ctx.model ? formatModelId(ctx.model) : undefined;
  if (!parentModelId && !settings.defaultModel && !params.model) {
    return errorResult("SUBAGENT_FAILED", "The parent session has no model.", { warnings: scopeWarnings });
  }
  const spec = resolveSpec(params, {
    parentModelId: parentModelId ?? params.model ?? settings.defaultModel!,
    parentThinking: pi.getThinkingLevel(),
    defaultModel: settings.defaultModel,
    defaultThinking: settings.defaultThinking,
  });

  setConcurrency(settings);
  const release = await getSemaphore().acquire(mergeSignals(signal, ctx.signal));
  try {
    const id = registry.createId(spec.label);
    onId(id);
    const sessionManager = createSessionManager(ctx, id);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Subagent session manager did not create a persistent session file.");

    const record: RegistryRecord = {
      id,
      spec,
      sessionFile,
      createdAt: new Date().toISOString(),
    };
    registry.record(pi, record);

    return await runPrompt({
      id,
      spec,
      task: params.task,
      sessionManager,
      sessionStartReason: "startup",
      settings,
      signal,
      onUpdate,
      ctx,
      selfExtensionPath,
      diagnostics: scopeWarnings,
    });
  } finally {
    release();
  }
}

export async function executeMessageSubagent(
  registry: SubagentRegistry,
  params: MessageParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  selfExtensionPath: string,
): Promise<AgentToolResult<SubagentToolDetails>> {
  try {
    return await executeMessageSubagentUnchecked(
      registry, params, signal, onUpdate, ctx, selfExtensionPath,
    );
  } catch (error) {
    return executionErrorResult(
      error,
      [signal, ctx.signal],
      { subagent_id: params.subagent_id },
      params.subagent_id,
    );
  }
}

async function executeMessageSubagentUnchecked(
  registry: SubagentRegistry,
  params: MessageParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  selfExtensionPath: string,
): Promise<AgentToolResult<SubagentToolDetails>> {
  const record = registry.get(params.subagent_id);
  if (!record) {
    return errorResult(
      "UNKNOWN_SUBAGENT_ID",
      `Unknown subagent_id: ${params.subagent_id}`,
      { subagent_id: params.subagent_id },
      params.subagent_id,
    );
  }
  if (!existsSync(record.sessionFile)) {
    return errorResult(
      "UNKNOWN_SUBAGENT_ID",
      `Registered subagent session file no longer exists: ${record.sessionFile}`,
      { subagent_id: record.id, sessionFile: record.sessionFile },
      record.id,
    );
  }

  const settings = loadSettings();
  setConcurrency(settings);
  const release = await getSemaphore().acquire(mergeSignals(signal, ctx.signal));
  try {
    return await runPrompt({
      id: record.id,
      spec: record.spec,
      task: params.prompt,
      sessionManager: SessionManager.open(record.sessionFile),
      sessionStartReason: "resume",
      settings,
      signal,
      onUpdate,
      ctx,
      selfExtensionPath,
      diagnostics: [],
    });
  } finally {
    release();
  }
}

function createSessionManager(ctx: ExtensionContext, subagentId: string): SessionManager {
  return SessionManager.create(
    join(ctx.cwd, ".pi-simple-subagents"),
    ctx.sessionManager.getSessionDir(),
    { parentSession: ctx.sessionManager.getSessionFile(), id: subagentId },
  );
}

async function runPrompt(options: {
  id: string;
  spec: RuntimeSubagentSpec;
  task: string;
  sessionManager: SessionManager;
  sessionStartReason: "startup" | "resume";
  settings: SimpleSubagentsSettings;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined;
  ctx: ExtensionContext;
  selfExtensionPath: string;
  diagnostics: string[];
}): Promise<AgentToolResult<SubagentToolDetails>> {
  const start = Date.now();
  const warnings = [...options.diagnostics];
  const model = findModelById(options.spec.modelId, options.ctx.modelRegistry);
  let hardTimedOut = false;
  let abortedByUser = false;
  let latestTool: string | undefined;
  let activeSession: {
    abort(): Promise<void>;
    dispose(): void;
    messages: unknown[];
    sessionFile: string | undefined;
    extensionRunner: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> };
  } | undefined;

  const abort = () => {
    abortedByUser = true;
    void activeSession?.abort();
  };
  const cleanups = bindAbortSignals(abort, options.signal, options.ctx.signal);
  let baselineUsage: UsageSummary | undefined;
  const currentRunUsage = () => {
    if (!activeSession) return undefined;
    const current = summarizeUsage(activeSession.messages);
    return baselineUsage ? subtractUsage(current, baselineUsage) : current;
  };

  let progressStopped = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const emitProgress = () => {
    options.onUpdate?.({
      content: [{
        type: "text",
        text: `${options.id} - ${formatElapsed(Date.now() - start)}${latestTool ? ` - ${latestTool}` : ""}`,
      }],
      details: {
        subagent_id: options.id,
        sessionFile: options.sessionManager.getSessionFile(),
        elapsedMs: Date.now() - start,
        model: options.spec.modelId,
        thinking: options.spec.thinking,
        usage: currentRunUsage(),
        warnings,
      },
    });
  };
  const progress = () => {
    if (progressStopped) return;
    try {
      emitProgress();
    } catch {
      progressStopped = true;
      if (progressTimer) clearInterval(progressTimer);
    }
  };
  progressTimer = setInterval(progress, 5000);
  progress();

  let softTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!model) throw new Error(`Model "${options.spec.modelId}" was not found.`);
    const { session } = await createConfiguredSession({
      spec: options.spec,
      model,
      sessionManager: options.sessionManager,
      sessionStartReason: options.sessionStartReason,
      ctx: options.ctx,
      selfExtensionPath: options.selfExtensionPath,
      warnings,
    });
    activeSession = session;
    baselineUsage = summarizeUsage(session.messages);
    if (abortedByUser || options.signal?.aborted || options.ctx.signal?.aborted) {
      await session.abort().catch(() => undefined);
      throw new Error("Subagent run was aborted before prompting.");
    }

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
        latestTool = event.toolName;
        progress();
      } else if (event.type === "tool_execution_end") {
        latestTool = undefined;
        progress();
      }
    });

    const softMs = minutesToMs(positiveNumber(options.settings.softTimeoutMinutes, DEFAULT_SOFT_TIMEOUT_MINUTES));
    const hardMs = minutesToMs(positiveNumber(options.settings.hardTimeoutMinutes, DEFAULT_HARD_TIMEOUT_MINUTES));
    softTimer = setTimeout(() => void session.steer(SOFT_TIMEOUT_PROMPT).catch(() => undefined), softMs);
    hardTimer = setTimeout(() => {
      hardTimedOut = true;
      void session.abort().catch(() => undefined);
    }, hardMs);

    try {
      await session.prompt(
        buildHarnessPrompt(options.task, options.sessionStartReason === "resume"),
        { expandPromptTemplates: false, source: "extension" },
      );
    } finally {
      unsubscribe();
    }

    const response = hardTimedOut
      ? await timeoutResponse(session.messages, options, model)
      : getFinalAssistantText(session.messages, { preserveErrorMessage: true });
    return successResult(options.id, response, session.messages, session.sessionFile, start, options.spec, warnings, baselineUsage);
  } catch (error) {
    if (hardTimedOut) {
      const response = await timeoutResponse(activeSession?.messages ?? [], options, model);
      return successResult(
        options.id,
        response,
        activeSession?.messages ?? [],
        options.sessionManager.getSessionFile(),
        start,
        options.spec,
        warnings,
        baselineUsage,
      );
    }
    const details: SubagentToolDetails = {
      subagent_id: options.id,
      sessionFile: options.sessionManager.getSessionFile(),
      elapsedMs: Date.now() - start,
      model: options.spec.modelId,
      thinking: options.spec.thinking,
      usage: currentRunUsage(),
      warnings,
    };
    if (abortedByUser || options.signal?.aborted || options.ctx.signal?.aborted) {
      return errorResult("ABORTED", "Subagent run was aborted.", details, options.id);
    }
    return errorResult(
      "SUBAGENT_FAILED",
      error instanceof Error ? error.message : String(error),
      details,
      options.id,
    );
  } finally {
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (progressTimer) clearInterval(progressTimer);
    for (const cleanup of cleanups) cleanup();
    if (activeSession) {
      try {
        await activeSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } catch {
        // Best effort: dispose regardless.
      }
      activeSession.dispose();
    }
  }
}

async function createConfiguredSession(options: {
  spec: RuntimeSubagentSpec;
  model: Model<any>;
  sessionManager: SessionManager;
  sessionStartReason: "startup" | "resume";
  ctx: ExtensionContext;
  selfExtensionPath: string;
  warnings: string[];
}) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.ctx.cwd, agentDir, { projectTrusted: false });
  const selfPath = normalizeExtensionPath(options.selfExtensionPath);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.ctx.cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: () => options.spec.systemPrompt,
    extensionsOverride: (base) => filterSubagentExtensions(base, selfPath),
    skillsOverride: (base) => {
      const filtered = filterSkillSelection(base.skills.map((skill) => skill.name), options.spec.skills);
      options.warnings.push(...filtered.warnings);
      const allowed = new Set(filtered.selected);
      return { ...base, skills: base.skills.filter((skill) => allowed.has(skill.name)) };
    },
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd: options.ctx.cwd,
    agentDir,
    model: options.model,
    thinkingLevel: options.spec.thinking,
    resourceLoader,
    settingsManager,
    sessionManager: options.sessionManager,
    sessionStartEvent: { type: "session_start", reason: options.sessionStartReason },
  });
  await created.session.bindExtensions({
    mode: "print",
    onError: (error) => options.warnings.push(
      `Extension error (${error.extensionPath}, ${error.event}): ${error.error}`,
    ),
  });

  const toolSelection = filterToolSelection(
    created.session.getAllTools().map((tool) => tool.name),
    options.spec.tools,
  );
  options.warnings.push(...toolSelection.warnings);
  created.session.setActiveToolsByName(toolSelection.selected);
  return created;
}

function filterSubagentExtensions(base: LoadExtensionsResult, selfPath: string): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter((extension) => {
      const extensionPath = normalizeExtensionPath(extension.resolvedPath);
      return extensionPath !== selfPath &&
        !SUBAGENT_EXTENSION_EXCLUDE_PATH_PARTS.some((part) => extensionPath.includes(part));
    }),
  };
}

function normalizeExtensionPath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

async function getScopedModelOptions(ctx: ExtensionContext): Promise<{
  options: Array<{ id: string; model: Model<any> }>;
  warnings: string[];
}> {
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const modelRuntime = await ModelRuntime.create();
  const scoped = await resolveScopedModels(modelRuntime, settingsManager);
  return { options: toModelOptions(scoped.models), warnings: scoped.warnings };
}

function toModelOptions(models: Model<any>[]): Array<{ id: string; model: Model<any> }> {
  return models.map((model) => ({ id: formatModelId(model), model }));
}

async function timeoutResponse(
  messages: unknown[],
  options: { settings: SimpleSubagentsSettings; ctx: ExtensionContext },
  runModel: Model<any> | undefined,
): Promise<string> {
  if (!options.settings.summarizeOnTimeout) return TIMEOUT_ABORT_MESSAGE;
  try {
    const summaryModel = options.settings.timeoutSummaryModel
      ? findModelById(options.settings.timeoutSummaryModel, options.ctx.modelRegistry) ?? runModel
      : options.settings.defaultModel
        ? findModelById(options.settings.defaultModel, options.ctx.modelRegistry) ?? runModel
        : runModel;
    if (!summaryModel) return TIMEOUT_ABORT_MESSAGE;
    const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
    if (!auth.ok) return TIMEOUT_ABORT_MESSAGE;
    const message = await completeSimple(
      summaryModel,
      {
        systemPrompt: "Summarize an aborted subagent session for the main agent. Include what was attempted, what was accomplished, what remains unfinished, and any concrete results. Be concise.",
        messages: [{ role: "user", content: serializeTranscript(messages), timestamp: Date.now() }],
      },
      { apiKey: auth.apiKey, headers: auth.headers },
    );
    const text = extractAssistantText(message);
    return `${TIMEOUT_SUMMARY_PREFIX} ${text || "No summary text was produced."}`;
  } catch {
    return TIMEOUT_ABORT_MESSAGE;
  }
}

function successResult(
  id: string,
  response: string,
  messages: unknown[],
  sessionFile: string | undefined,
  start: number,
  spec: RuntimeSubagentSpec,
  warnings: string[],
  baselineUsage?: UsageSummary,
): AgentToolResult<SubagentToolDetails> {
  return textResult(`subagent_id: ${id}\n${response}`, {
    subagent_id: id,
    sessionFile,
    elapsedMs: Date.now() - start,
    model: spec.modelId,
    thinking: spec.thinking,
    usage: baselineUsage
      ? subtractUsage(summarizeUsage(messages), baselineUsage)
      : summarizeUsage(messages),
    warnings,
  });
}

function executionErrorResult(
  error: unknown,
  signals: Array<AbortSignal | undefined>,
  details: SubagentToolDetails,
  id?: string,
): AgentToolResult<SubagentToolDetails> {
  const aborted = signals.some((signal) => signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError");
  return errorResult(
    aborted ? "ABORTED" : "SUBAGENT_FAILED",
    aborted ? "Subagent run was aborted." : error instanceof Error ? error.message : String(error),
    details,
    id,
  );
}

function errorResult(
  code: string,
  message: string,
  details: SubagentToolDetails,
  id?: string,
): AgentToolResult<SubagentToolDetails> {
  return textResult(`${id ? `subagent_id: ${id}\n` : ""}ERROR [${code}]: ${message}`, details);
}

function textResult(text: string, details: SubagentToolDetails): AgentToolResult<SubagentToolDetails> {
  return { content: [{ type: "text", text }], details };
}

function setConcurrency(settings: SimpleSubagentsSettings): void {
  const max = Math.max(1, Math.floor(positiveNumber(
    settings.maxConcurrentSubagents,
    DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  )));
  getSemaphore(max).setMax(max);
}

function getSemaphore(initialMax = DEFAULT_MAX_CONCURRENT_SUBAGENTS): Semaphore {
  semaphore ??= new Semaphore(initialMax);
  return semaphore;
}

function minutesToMs(minutes: number): number {
  return Math.max(1, minutes) * 60 * 1000;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m${(totalSeconds % 60).toString().padStart(2, "0")}s`;
}

function subtractUsage(current: UsageSummary, baseline: UsageSummary): UsageSummary {
  const subtract = (a: number, b: number) => Math.max(0, a - b);
  return {
    assistantTurns: subtract(current.assistantTurns, baseline.assistantTurns),
    input: subtract(current.input, baseline.input),
    output: subtract(current.output, baseline.output),
    cacheRead: subtract(current.cacheRead, baseline.cacheRead),
    cacheWrite: subtract(current.cacheWrite, baseline.cacheWrite),
    totalTokens: subtract(current.totalTokens, baseline.totalTokens),
    cost: {
      input: subtract(current.cost.input, baseline.cost.input),
      output: subtract(current.cost.output, baseline.cost.output),
      cacheRead: subtract(current.cost.cacheRead, baseline.cost.cacheRead),
      cacheWrite: subtract(current.cost.cacheWrite, baseline.cost.cacheWrite),
      total: subtract(current.cost.total, baseline.cost.total),
    },
  };
}

function serializeTranscript(messages: unknown[]): string {
  if (messages.length === 0) return "No transcript messages were available.";
  return messages.map((message) => {
    if (!message || typeof message !== "object") return "";
    const raw = message as { role?: string; content?: unknown; summary?: unknown };
    if (raw.role === "assistant" && isAssistantMessage(message)) return `Assistant: ${extractAssistantText(message)}`;
    if (raw.role === "user") return `User: ${contentToText(raw.content)}`;
    if (raw.role === "toolResult") return `Tool result: ${contentToText(raw.content)}`;
    if ((raw.role === "compactionSummary" || raw.role === "branchSummary") && typeof raw.summary === "string") {
      return `Summary of earlier conversation:\n${raw.summary}`;
    }
    return "";
  }).filter(Boolean).join("\n\n");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part && typeof part === "object" && (part as TextContent).type === "text") return (part as TextContent).text;
    if (part && typeof part === "object" && (part as ImageContent).type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function bindAbortSignals(
  abort: () => void,
  ...signals: Array<AbortSignal | undefined>
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort();
      continue;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", abort));
  }
  return cleanups;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}
