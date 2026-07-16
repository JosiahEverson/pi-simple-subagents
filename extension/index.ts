import { fileURLToPath } from "node:url";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  getMarkdownTheme,
  keyHint,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { deriveLabel } from "../shared/spec.ts";
import type { ThinkingLevel } from "../shared/types.ts";
import { SubagentRegistry } from "./registry.ts";
import {
  executeGetScopedModels,
  executeMessageSubagent,
  executeSpawnSubagent,
  type SubagentToolDetails,
} from "./run.ts";
import { loadSettings } from "./settings.ts";
import { installStaleCtxGuard } from "./stale-ctx-guard.ts";

const SELF_EXTENSION_PATH = fileURLToPath(import.meta.url);
const COLLAPSED_RESPONSE_LINES = 16;

interface SpawnDisplayConfig {
  model: string;
  thinking: ThinkingLevel;
  modelOverridden: boolean;
  thinkingOverridden: boolean;
}

interface ParsedSubagentOutput {
  id?: string;
  response: string;
  error?: { code: string; message: string };
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatUsageLine(details: SubagentToolDetails | undefined, theme: Theme): string {
  const usage = details?.usage;
  if (!usage || usage.totalTokens === 0) return "";
  return theme.fg(
    "dim",
    `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)} $${usage.cost.total.toFixed(3)}`,
  );
}

function renderSubagentCall(
  verb: "spawn" | "message",
  labelOrId: string | undefined,
  task: string | undefined,
  theme: Theme,
  spawnConfig?: SpawnDisplayConfig,
): Container {
  const subject = labelOrId?.trim() || "subagent";
  const container = new Container();
  container.addChild(new Text(
    `${theme.fg("toolTitle", theme.bold(verb))} ${theme.fg("accent", subject)} ${theme.fg("toolTitle", "subagent")}`,
    0,
    0,
  ));
  if (spawnConfig) container.addChild(new Text(formatSpawnConfig(spawnConfig, theme), 0, 0));
  if (task) {
    const blockquote = task.split("\n").map((line) => `> ${line}`).join("\n");
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("customMessageLabel", theme.bold("prompt to subagent")), 0, 0));
    container.addChild(new Markdown(blockquote, 0, 0, getMarkdownTheme(), {
      color: (value: string) => theme.fg("dim", value),
    }));
  }
  return container;
}

function renderSubagentResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Container | Text | Markdown {
  const text = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const details = result.details as SubagentToolDetails | undefined;

  if (options.isPartial) {
    const usagePart = formatUsageLine(details, theme);
    const progress = theme.fg("muted", text || "Working...");
    return new Text(usagePart ? `${progress}\n${usagePart}` : progress, 0, 0);
  }

  const parsed = parseSubagentOutput(text);
  if (parsed.error) {
    return new Text(theme.fg("error", `${parsed.error.code}: ${parsed.error.message}`), 0, 0);
  }

  const response = parsed.response;
  const display = options.expanded ? response : collapseMarkdown(response, COLLAPSED_RESPONSE_LINES);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("customMessageLabel", theme.bold("subagent response")), 0, 0));
  container.addChild(new Markdown(display || theme.fg("muted", "No response."), 1, 0, getMarkdownTheme(), {
    color: (value: string) => theme.fg("toolOutput", value),
  }));

  const hint = !options.expanded
    ? response !== display
      ? `\n... (${keyHint("app.tools.expand", "to expand")})`
      : `\n(${keyHint("app.tools.expand", "to expand")})`
    : `\n(${keyHint("app.tools.expand", "to collapse")})`;
  const usagePart = formatUsageLine(details, theme);
  container.addChild(new Text(theme.fg("muted", usagePart ? `${hint}  ${usagePart}` : hint), 0, 0));
  return container;
}

function parseSubagentOutput(text: string): ParsedSubagentOutput {
  const lines = text.split("\n");
  const idMatch = /^subagent_id:\s*(.+)$/.exec(lines[0] ?? "");
  const response = idMatch ? lines.slice(1).join("\n") : text;
  const errorMatch = /^ERROR \[([^\]]+)\]:\s*(.*)$/s.exec(response);
  return {
    id: idMatch?.[1],
    response,
    error: errorMatch ? { code: errorMatch[1], message: errorMatch[2] } : undefined,
  };
}

function collapseMarkdown(markdown: string, maxLines: number): string {
  const lines = markdown.trimEnd().split("\n");
  return lines.length <= maxLines ? markdown : lines.slice(0, maxLines).join("\n");
}

function formatSpawnConfig(config: SpawnDisplayConfig, theme: Theme): string {
  const modelColor = config.modelOverridden ? "error" : "muted";
  const thinkingColor = config.thinkingOverridden ? "error" : "muted";
  return `${theme.fg(modelColor, config.model)}${theme.fg("muted", ":")}${theme.fg(thinkingColor, config.thinking)}`;
}

function resolveSpawnDisplay(
  requestedModel: string | undefined,
  requestedThinking: ThinkingLevel | undefined,
  mainModel: string | undefined,
  mainThinking: ThinkingLevel,
): SpawnDisplayConfig {
  const settings = loadSettings();
  return {
    model: requestedModel ?? settings.defaultModel ?? mainModel ?? "unknown",
    thinking: requestedThinking ?? settings.defaultThinking ?? mainThinking,
    modelOverridden: requestedModel !== undefined,
    thinkingOverridden: requestedThinking !== undefined,
  };
}

function formatModel(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export default function subagentWorkflows(pi: ExtensionAPI) {
  installStaleCtxGuard();
  const registry = new SubagentRegistry();
  let mainModel: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    registry.rebuild(ctx.sessionManager.getEntries());
    mainModel = formatModel(ctx.model);
  });
  pi.on("model_select", (event) => {
    mainModel = formatModel(event.model);
  });

  pi.registerTool({
    name: "get_scoped_models",
    label: "Get Scoped Models",
    description: "List allowed model overrides from Pi's enabledModels.",
    promptSnippet: "List allowed model overrides.",
    parameters: Type.Object({}),
    execute: (_toolCallId, _params, _signal, _onUpdate, ctx) => executeGetScopedModels(ctx),
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: "Spawn a fresh-context subagent defined inline: a task plus optional role, model, thinking, tools, and skills.",
    promptSnippet: "Spawn a subagent.",
    promptGuidelines: [
      "Route model and thinking deliberately per task: match capability to the work, and scale thinking with the judgment required.",
      "Model overrides must be exact IDs returned by get_scoped_models; call it before your first override.",
      "Give each subagent a complete task: objective, scope, boundaries, and the exact output you expect back.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete task: objective, scope, boundaries, and expected output." }),
      role: Type.Optional(Type.String({ description: "System-prompt instructions defining who the subagent is and how it should work. Omit for a generic worker." })),
      model: Type.Optional(Type.String({ description: "Exact model ID from get_scoped_models. Route by task fit; omit to inherit the default." })),
      thinking: Type.Optional(Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ], { description: "Thinking level. Scale with judgment required: low for mechanical work, high for design or review." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Tool-name allowlist. Omit for all tools; [] for none." })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill-name allowlist. Omit for all skills; [] for none." })),
      label: Type.Optional(Type.String({ description: "Short label used in progress display and the subagent_id." })),
    }),
    executionMode: "parallel",
    execute: (_toolCallId, params, signal, onUpdate, ctx) => executeSpawnSubagent(
      pi,
      registry,
      params,
      signal,
      onUpdate,
      ctx,
      SELF_EXTENSION_PATH,
    ),
    renderCall: (args, theme) => renderSubagentCall(
      "spawn",
      deriveLabel(args),
      args.task,
      theme,
      resolveSpawnDisplay(args.model, args.thinking, mainModel, pi.getThinkingLevel()),
    ),
    renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
  });

  pi.registerTool({
    name: "message_subagent",
    label: "Message Subagent",
    description: "Continue a spawned subagent by id.",
    promptSnippet: "Continue a spawned subagent by id.",
    parameters: Type.Object({
      subagent_id: Type.String({ description: "ID returned by spawn_subagent." }),
      prompt: Type.String({ description: "Follow-up task or question. The subagent keeps its prior conversation and configuration." }),
    }),
    executionMode: "parallel",
    execute: (_toolCallId, params, signal, onUpdate, ctx) => executeMessageSubagent(
      registry,
      params,
      signal,
      onUpdate,
      ctx,
      SELF_EXTENSION_PATH,
    ),
    renderCall: (args, theme) => renderSubagentCall("message", args.subagent_id, args.prompt, theme),
    renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
  });
}
