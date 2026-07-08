import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type LoadExtensionsResult,
  type ModelRegistry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  completeSimple,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
} from "@earendil-works/pi-ai/compat";
import {
  discoverAgents,
  type AgentDefinition,
  type SelectionSpec,
  type ThinkingLevel,
} from "./agents.ts";
import type { RegistryRecord, SubagentRegistry } from "./registry.ts";
import { Semaphore } from "./semaphore.ts";
import {
  loadSettings,
  positiveNumber,
  type SimpleSubagentsSettings,
} from "./settings.ts";

const TOOL_NAMES = {
  spawn: "spawn_subagent",
  message: "message_subagent",
  list: "list_subagents",
} as const;

const SELF_TOOL_NAMES = new Set<string>(Object.values(TOOL_NAMES));
const SUBAGENT_EXTENSION_EXCLUDE_PATH_PARTS = [
  // This session-management extension schedules idle polling with a
  // session-bound ctx; subagent sessions are transient in-process sessions, so
  // disposing them can otherwise trip pi's stale-context guard.
  "/pi-session-naming/",
] as const;
const DEFAULT_SOFT_TIMEOUT_MINUTES = 30;
const DEFAULT_HARD_TIMEOUT_MINUTES = 45;
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;
const TIMEOUT_ABORT_MESSAGE = "[hard timeout - subagent aborted] Use message_subagent to resume.";
const TIMEOUT_SUMMARY_PREFIX = "[hard timeout - session summarized]";
const SOFT_TIMEOUT_PROMPT =
  "Your time budget is nearly exhausted. Wrap up now. Finish only what is already in flight, then produce your final report. Explicitly tell the main agent what you were unable to finish and what remains to be done.";

interface ResolvedRunConfig {
  model: Model<any> | undefined;
  modelLabel: string | undefined;
  thinking: ThinkingLevel;
  warnings: string[];
}

export interface SubagentToolDetails {
  subagent_id?: string;
  subagent_type?: string;
  sessionFile?: string;
  elapsedMs?: number;
  model?: string;
  thinking?: ThinkingLevel;
  usage?: UsageSummary;
  warnings?: string[];
}

interface UsageSummary {
  assistantTurns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface SpawnParams {
  subagent_type?: string;
  prompt: string;
}

interface MessageParams {
  subagent_id: string;
  prompt: string;
}

let semaphore: Semaphore | undefined;

export async function executeListSubagents(
  pi: Pick<ExtensionAPI, "getAllTools" | "getCommands" | "getThinkingLevel">,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolDetails>> {
  const settings = loadSettings();
  const discovered = discoverAgents(getAgentDir());
  const toolNames = pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => !SELF_TOOL_NAMES.has(name))
    .sort();
  const skillNames = getSkillNames(pi).sort();

  const lines: string[] = [];
  for (const agent of discovered.agents) {
    const resolved = resolveDisplayConfig(agent, settings, ctx, pi.getThinkingLevel());
    const tools = resolveSelectionForDisplay(agent.tools, toolNames);
    const skills = resolveSelectionForDisplay(agent.skills, skillNames);
    lines.push(
      [
        `name: ${agent.name}`,
        `description: ${agent.description}`,
        `source: ${agent.source}`,
        `model: ${resolved.modelLabel ?? "main session"}`,
        `thinking: ${resolved.thinking}`,
        `tools: ${formatList(tools.values)}`,
        `skills: ${formatList(skills.values)}`,
        `context: ${agent.context}`,
        agent.filePath ? `path: ${agent.filePath}` : undefined,
        [...tools.warnings, ...skills.warnings, ...resolved.warnings].length > 0
          ? `warnings: ${formatList([...tools.warnings, ...skills.warnings, ...resolved.warnings])}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (discovered.diagnostics.length > 0) {
    lines.push(`diagnostics:\n${discovered.diagnostics.map((d) => `- ${d}`).join("\n")}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n\n") || "No subagents found." }],
    details: {
      warnings: discovered.diagnostics,
    },
  };
}

export async function executeSpawnSubagent(
  pi: Pick<ExtensionAPI, "appendEntry" | "getThinkingLevel">,
  registry: SubagentRegistry,
  params: SpawnParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  selfExtensionPath: string,
): Promise<AgentToolResult<SubagentToolDetails>> {
  const settings = loadSettings();
  const type = params.subagent_type ?? settings.defaultSubagentTypeId;
  if (!type) {
    return jsonResult(
      {
        error: {
          code: "MISSING_SUBAGENT_TYPE",
          message: "subagent_type was omitted and simpleSubagents.defaultSubagentTypeId is unset.",
        },
      },
      {},
    );
  }

  const discovered = discoverAgents(getAgentDir());
  const agent = discovered.agents.find((candidate) => candidate.name === type);
  if (!agent) {
    return jsonResult(
      {
        error: {
          code: "UNKNOWN_SUBAGENT_TYPE",
          message: `Unknown subagent_type: ${type}`,
        },
      },
      { warnings: discovered.diagnostics },
    );
  }

  setConcurrency(settings);
  const release = await getSemaphore().acquire(mergeSignals(signal, ctx.signal));
  try {
    const id = registry.createId(agent.name);
    const sessionManager = createSessionManager(ctx, agent, id);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("Subagent session manager did not create a persistent session file.");
    }

    const record: RegistryRecord = {
      id,
      type: agent.name,
      sessionFile,
      createdAt: new Date().toISOString(),
    };
    registry.record(pi, record);

    const result = await runPrompt({
      id,
      agent,
      prompt: params.prompt,
      sessionManager,
      sessionStartReason: "startup",
      settings,
      signal,
      onUpdate,
      ctx,
      selfExtensionPath,
      mainThinking: pi.getThinkingLevel(),
      diagnostics: discovered.diagnostics,
    });

    return result;
  } finally {
    release();
  }
}

export async function executeMessageSubagent(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  registry: SubagentRegistry,
  params: MessageParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined,
  ctx: ExtensionContext,
  selfExtensionPath: string,
): Promise<AgentToolResult<SubagentToolDetails>> {
  const record = registry.get(params.subagent_id);
  if (!record) {
    return jsonResult(
      {
        subagent_id: params.subagent_id,
        error: {
          code: "UNKNOWN_SUBAGENT_ID",
          message: `Unknown subagent_id: ${params.subagent_id}`,
        },
      },
      { subagent_id: params.subagent_id },
    );
  }

  const settings = loadSettings();
  const discovered = discoverAgents(getAgentDir());
  const agent = discovered.agents.find((candidate) => candidate.name === record.type);
  if (!agent) {
    return jsonResult(
      {
        subagent_id: params.subagent_id,
        error: {
          code: "SUBAGENT_FAILED",
          message: `Subagent type ${record.type} is no longer available.`,
        },
      },
      {
        subagent_id: params.subagent_id,
        subagent_type: record.type,
        warnings: discovered.diagnostics,
      },
    );
  }

  if (!existsSync(record.sessionFile)) {
    return jsonResult(
      {
        subagent_id: params.subagent_id,
        error: {
          code: "UNKNOWN_SUBAGENT_ID",
          message: `Registered subagent session file no longer exists: ${record.sessionFile}`,
        },
      },
      {
        subagent_id: params.subagent_id,
        subagent_type: record.type,
        sessionFile: record.sessionFile,
      },
    );
  }

  setConcurrency(settings);
  const release = await getSemaphore().acquire(mergeSignals(signal, ctx.signal));
  try {
    const sessionManager = SessionManager.open(record.sessionFile);
    const result = await runPrompt({
      id: record.id,
      agent,
      prompt: params.prompt,
      sessionManager,
      sessionStartReason: "resume",
      settings,
      signal,
      onUpdate,
      ctx,
      selfExtensionPath,
      mainThinking: pi.getThinkingLevel(),
      diagnostics: discovered.diagnostics,
    });

    return result;
  } finally {
    release();
  }
}

function createSessionManager(
  ctx: ExtensionContext,
  agent: AgentDefinition,
  subagentId: string,
): SessionManager {
  const syntheticCwd = join(ctx.cwd, ".pi-simple-subagents");
  const sessionDir = ctx.sessionManager.getSessionDir();
  const mainSessionFile = ctx.sessionManager.getSessionFile();

  if (agent.context === "fork" && mainSessionFile) {
    const manager = SessionManager.forkFrom(mainSessionFile, syntheticCwd, sessionDir);
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf?.parentId) {
      manager.branch(leaf.parentId);
    } else if (leaf) {
      manager.resetLeaf();
    }
    return manager;
  }

  return SessionManager.create(syntheticCwd, sessionDir, {
    parentSession: mainSessionFile,
    id: subagentId,
  });
}

async function runPrompt(options: {
  id: string;
  agent: AgentDefinition;
  prompt: string;
  sessionManager: SessionManager;
  sessionStartReason: "startup" | "resume";
  settings: SimpleSubagentsSettings;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentToolDetails> | undefined;
  ctx: ExtensionContext;
  selfExtensionPath: string;
  mainThinking: ThinkingLevel;
  diagnostics: string[];
}): Promise<AgentToolResult<SubagentToolDetails>> {
  const start = Date.now();
  const warnings = [...options.diagnostics];
  const config = resolveRunConfig(
    options.agent,
    options.settings,
    options.ctx,
    options.mainThinking,
  );
  warnings.push(...config.warnings);

  let hardTimedOut = false;
  let abortedByUser = false;
  let latestTool: string | undefined;
  let activeSession:
    | {
        abort(): Promise<void>;
        dispose(): void;
        messages: unknown[];
        sessionFile: string | undefined;
        extensionRunner: {
          emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
        };
      }
    | undefined;

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
  const progress = () => {
    if (progressStopped) return;
    try {
      emitProgress();
    } catch {
      // The parent session was replaced or reloaded mid-run, so its ctx-bound
      // onUpdate callback is stale. Stop reporting progress; the run itself
      // continues and its result is returned to whoever awaits it.
      progressStopped = true;
      if (progressTimer) clearInterval(progressTimer);
    }
  };
  const emitProgress = () => {
    options.onUpdate?.({
      content: [
        {
          type: "text",
          text: `${options.id} - ${formatElapsed(Date.now() - start)}${
            latestTool ? ` - ${latestTool}` : ""
          }`,
        },
      ],
      details: {
        subagent_id: options.id,
        subagent_type: options.agent.name,
        sessionFile: options.sessionManager.getSessionFile(),
        elapsedMs: Date.now() - start,
        model: config.modelLabel,
        thinking: config.thinking,
        usage: currentRunUsage(),
        warnings,
      },
    });
  };

  progressTimer = setInterval(progress, 5000);
  progress();

  let softTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const { session } = await createConfiguredSession({
      agent: options.agent,
      sessionManager: options.sessionManager,
      sessionStartReason: options.sessionStartReason,
      config,
      ctx: options.ctx,
      selfExtensionPath: options.selfExtensionPath,
      warnings,
    });
    activeSession = session;
    baselineUsage = summarizeUsage(session.messages);

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
        latestTool = event.toolName;
        progress();
      } else if (event.type === "tool_execution_end") {
        latestTool = undefined;
        progress();
      }
    });

    const softMs = minutesToMs(
      positiveNumber(options.settings.softTimeoutMinutes, DEFAULT_SOFT_TIMEOUT_MINUTES),
    );
    const hardMs = minutesToMs(
      positiveNumber(options.settings.hardTimeoutMinutes, DEFAULT_HARD_TIMEOUT_MINUTES),
    );

    softTimer = setTimeout(() => {
      void session.steer(SOFT_TIMEOUT_PROMPT).catch(() => undefined);
    }, softMs);

    hardTimer = setTimeout(() => {
      hardTimedOut = true;
      void session.abort().catch(() => undefined);
    }, hardMs);

    try {
      await session.prompt(options.prompt, {
        expandPromptTemplates: false,
        source: "extension",
      });
    } finally {
      unsubscribe();
    }

    if (hardTimedOut) {
      const response = await timeoutResponse(session.messages, options, config);
      return successResult(
        options.id,
        response,
        {
          messages: session.messages,
          sessionFile: session.sessionFile,
          subagentType: options.agent.name,
        },
        start,
        config,
        warnings,
        baselineUsage,
      );
    }

    const response = getFinalAssistantText(session.messages);
    return successResult(
      options.id,
      response,
      {
        messages: session.messages,
        sessionFile: session.sessionFile,
        subagentType: options.agent.name,
      },
      start,
      config,
      warnings,
      baselineUsage,
    );
  } catch (error) {
    if (hardTimedOut) {
      const response = await timeoutResponse(activeSession?.messages ?? [], options, config);
      return jsonResult(
        { subagent_id: options.id, response },
        {
          subagent_id: options.id,
          subagent_type: options.agent.name,
          sessionFile: options.sessionManager.getSessionFile(),
          elapsedMs: Date.now() - start,
          model: config.modelLabel,
          thinking: config.thinking,
          usage: currentRunUsage(),
          warnings,
        },
      );
    }

    if (abortedByUser || options.signal?.aborted || options.ctx.signal?.aborted) {
      return jsonResult(
        {
          subagent_id: options.id,
          error: {
            code: "ABORTED",
            message: "Subagent run was aborted.",
          },
        },
        {
          subagent_id: options.id,
          subagent_type: options.agent.name,
          sessionFile: options.sessionManager.getSessionFile(),
          elapsedMs: Date.now() - start,
          model: config.modelLabel,
          thinking: config.thinking,
          warnings,
        },
      );
    }

    return jsonResult(
      {
        subagent_id: options.id,
        error: {
          code: "SUBAGENT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      {
        subagent_id: options.id,
        subagent_type: options.agent.name,
        sessionFile: options.sessionManager.getSessionFile(),
        elapsedMs: Date.now() - start,
        model: config.modelLabel,
        thinking: config.thinking,
        warnings,
      },
    );
  } finally {
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (progressTimer) clearInterval(progressTimer);
    for (const cleanup of cleanups) cleanup();
    if (activeSession) {
      // AgentSession.dispose() invalidates every bound extension ctx WITHOUT
      // emitting session_shutdown. Extensions that start timers on
      // session_start (e.g. usage-footer extensions) would keep firing
      // against a stale ctx and crash pi from a timer callback. Emit the
      // shutdown event ourselves so they can clean up first.
      try {
        await activeSession.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } catch {
        // Best effort: dispose regardless.
      }
      activeSession.dispose();
    }
  }
}

async function createConfiguredSession(options: {
  agent: AgentDefinition;
  sessionManager: SessionManager;
  sessionStartReason: "startup" | "resume";
  config: ResolvedRunConfig;
  ctx: ExtensionContext;
  selfExtensionPath: string;
  warnings: string[];
}) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.ctx.cwd, agentDir, {
    projectTrusted: false,
  });
  const selfPath = normalizeExtensionPath(options.selfExtensionPath);

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.ctx.cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: () => options.agent.body,
    extensionsOverride: (base) => filterSubagentExtensions(base, selfPath),
    skillsOverride: (base) => filterSkills(base, options.agent.skills, options.warnings),
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd: options.ctx.cwd,
    agentDir,
    model: options.config.model,
    thinkingLevel: options.config.thinking,
    resourceLoader,
    settingsManager,
    sessionManager: options.sessionManager,
    sessionStartEvent: {
      type: "session_start",
      reason: options.sessionStartReason,
    },
  });

  await created.session.bindExtensions({
    mode: "print",
    onError: (error) => {
      options.warnings.push(
        `Extension error (${error.extensionPath}, ${error.event}): ${error.error}`,
      );
    },
  });

  const toolSelection = resolveTools(created.session.getAllTools(), options.agent.tools);
  options.warnings.push(...toolSelection.warnings);
  created.session.setActiveToolsByName(toolSelection.tools);

  return created;
}

function filterSubagentExtensions(
  base: LoadExtensionsResult,
  selfPath: string,
): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter((extension) => {
      const extensionPath = normalizeExtensionPath(extension.resolvedPath);
      return (
        extensionPath !== selfPath &&
        !SUBAGENT_EXTENSION_EXCLUDE_PATH_PARTS.some((part) => extensionPath.includes(part))
      );
    }),
  };
}

function normalizeExtensionPath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function filterSkills(
  base: ReturnType<DefaultResourceLoader["getSkills"]>,
  spec: SelectionSpec,
  warnings: string[],
): ReturnType<DefaultResourceLoader["getSkills"]> {
  if (spec === "all") return base;

  const allowed = new Set(spec);
  const available = new Set(base.skills.map((skill) => skill.name));
  for (const name of allowed) {
    if (!available.has(name)) {
      warnings.push(`Unknown skill "${name}" requested by agent frontmatter.`);
    }
  }

  return {
    ...base,
    skills: base.skills.filter((skill) => allowed.has(skill.name)),
  };
}

function resolveTools(tools: ToolInfo[], spec: SelectionSpec): { tools: string[]; warnings: string[] } {
  const available = tools
    .map((tool) => tool.name)
    .filter((name) => !SELF_TOOL_NAMES.has(name));

  if (spec === "all") {
    return { tools: available, warnings: [] };
  }

  const availableSet = new Set(available);
  const warnings: string[] = [];
  const selected = spec.filter((name) => {
    if (!availableSet.has(name)) {
      warnings.push(`Unknown tool "${name}" requested by agent frontmatter.`);
      return false;
    }
    return true;
  });

  return { tools: selected, warnings };
}

function resolveRunConfig(
  agent: AgentDefinition,
  settings: SimpleSubagentsSettings,
  ctx: ExtensionContext,
  mainThinking: ThinkingLevel,
): ResolvedRunConfig {
  const warnings: string[] = [];
  const override = settings.builtinSubagentOverrides?.[agent.name];
  const modelSpec = override?.model ?? agent.model ?? settings.defaultModel;
  const model = resolveModel(modelSpec, ctx.model, ctx.modelRegistry, warnings);
  const thinking = override?.thinking ?? agent.thinking ?? settings.defaultThinking ?? mainThinking;

  return {
    model,
    modelLabel: model ? `${model.provider}/${model.id}` : undefined,
    thinking,
    warnings,
  };
}

function resolveDisplayConfig(
  agent: AgentDefinition,
  settings: SimpleSubagentsSettings,
  ctx: ExtensionContext,
  mainThinking: ThinkingLevel,
): ResolvedRunConfig {
  return resolveRunConfig(agent, settings, ctx, mainThinking);
}

function resolveModel(
  spec: string | undefined,
  fallback: Model<any> | undefined,
  modelRegistry: ModelRegistry,
  warnings: string[],
): Model<any> | undefined {
  if (!spec) return fallback;

  const parsed = parseModelSpec(spec, fallback?.provider);
  if (!parsed) {
    warnings.push(`Invalid model spec "${spec}". Expected provider/model.`);
    return fallback;
  }

  const model = modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model) {
    warnings.push(`Model "${parsed.provider}/${parsed.modelId}" was not found. Using main session model.`);
    return fallback;
  }
  return model;
}

function parseModelSpec(
  spec: string,
  fallbackProvider: string | undefined,
): { provider: string; modelId: string } | undefined {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slash),
      modelId: trimmed.slice(slash + 1),
    };
  }
  if (slash === -1 && fallbackProvider) {
    return { provider: fallbackProvider, modelId: trimmed };
  }
  return undefined;
}

async function timeoutResponse(
  messages: unknown[],
  options: {
    settings: SimpleSubagentsSettings;
    agent: AgentDefinition;
    ctx: ExtensionContext;
  },
  config: ResolvedRunConfig,
): Promise<string> {
  if (!options.settings.summarizeOnTimeout) {
    return TIMEOUT_ABORT_MESSAGE;
  }

  try {
    const summaryModel = resolveModel(
      options.settings.timeoutSummaryModel ?? options.settings.defaultModel,
      config.model,
      options.ctx.modelRegistry,
      [],
    );
    if (!summaryModel) return TIMEOUT_ABORT_MESSAGE;

    const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
    if (!auth.ok) return TIMEOUT_ABORT_MESSAGE;

    const message = await completeSimple(
      summaryModel,
      {
        systemPrompt:
          "Summarize an aborted subagent session for the main agent. Include what was attempted, what was accomplished, what remains unfinished, and any concrete results. Be concise.",
        messages: [
          {
            role: "user",
            content: serializeTranscript(messages),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
      },
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
  session: {
    messages: unknown[];
    sessionFile: string | undefined;
    subagentType?: string;
  },
  start: number,
  config: ResolvedRunConfig,
  warnings: string[],
  baselineUsage?: UsageSummary,
): AgentToolResult<SubagentToolDetails> {
  return jsonResult(
    {
      subagent_id: id,
      response,
    },
    {
      subagent_id: id,
      subagent_type: session.subagentType,
      sessionFile: session.sessionFile,
      elapsedMs: Date.now() - start,
      model: config.modelLabel,
      thinking: config.thinking,
      usage: baselineUsage
        ? subtractUsage(summarizeUsage(session.messages), baselineUsage)
        : summarizeUsage(session.messages),
      warnings,
    },
  );
}

function jsonResult(
  payload: unknown,
  details: SubagentToolDetails,
): AgentToolResult<SubagentToolDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details,
  };
}

function setConcurrency(settings: SimpleSubagentsSettings): void {
  const max = Math.max(
    1,
    Math.floor(
      positiveNumber(settings.maxConcurrentSubagents, DEFAULT_MAX_CONCURRENT_SUBAGENTS),
    ),
  );
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
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function getFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantMessage(message)) {
      return extractAssistantText(message) || message.errorMessage || "";
    }
  }
  return "";
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function summarizeUsage(messages: unknown[]): UsageSummary {
  const summary: UsageSummary = {
    assistantTurns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };

  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    summary.assistantTurns += 1;
    summary.input += message.usage.input;
    summary.output += message.usage.output;
    summary.cacheRead += message.usage.cacheRead;
    summary.cacheWrite += message.usage.cacheWrite;
    summary.totalTokens += message.usage.totalTokens;
    summary.cost.input += message.usage.cost.input;
    summary.cost.output += message.usage.cost.output;
    summary.cost.cacheRead += message.usage.cost.cacheRead;
    summary.cost.cacheWrite += message.usage.cost.cacheWrite;
    summary.cost.total += message.usage.cost.total;
  }

  return summary;
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

  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      const raw = message as Partial<Message> & { role?: string };
      if (raw.role === "assistant" && isAssistantMessage(raw)) {
        return `Assistant: ${extractAssistantText(raw)}`;
      }
      if (raw.role === "user") {
        return `User: ${contentToText(raw.content)}`;
      }
      if (raw.role === "toolResult") {
        return `Tool result: ${contentToText(raw.content)}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as TextContent).type === "text") {
        return (part as TextContent).text;
      }
      if (part && typeof part === "object" && (part as ImageContent).type === "image") {
        return "[image]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { role?: unknown }).role === "assistant" &&
    Array.isArray((value as { content?: unknown }).content) &&
    !!(value as { usage?: unknown }).usage
  );
}

function resolveSelectionForDisplay(
  spec: SelectionSpec,
  available: string[],
): { values: string[]; warnings: string[] } {
  if (spec === "all") return { values: available, warnings: [] };

  const availableSet = new Set(available);
  const warnings: string[] = [];
  const values = spec.filter((name) => {
    if (!availableSet.has(name)) {
      warnings.push(`Unknown ${name}`);
      return false;
    }
    return true;
  });
  return { values, warnings };
}

function getSkillNames(pi: Pick<ExtensionAPI, "getCommands">): string[] {
  return pi
    .getCommands()
    .map((command) => command.name)
    .filter((name) => name.startsWith("skill:"))
    .map((name) => name.slice("skill:".length));
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
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
  return signals.find((signal) => signal?.aborted) ?? signals.find(Boolean);
}
