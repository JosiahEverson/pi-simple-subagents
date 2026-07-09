import { fileURLToPath } from "node:url";
import { Markdown, Text, Container, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir, getMarkdownTheme, keyHint, type AgentToolResult, type ExtensionAPI, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentContextMode } from "./agents.ts";
import { SubagentRegistry } from "./registry.ts";
import {
  executeGetScopedModels,
  executeListSubagents,
  executeMessageSubagent,
  executeSpawnSubagent,
  type SubagentToolDetails,
} from "./run.ts";
import { loadSettings } from "./settings.ts";
import { installStaleCtxGuard } from "./stale-ctx-guard.ts";

const SELF_EXTENSION_PATH = fileURLToPath(import.meta.url);
const COLLAPSED_RESPONSE_LINES = 16;
const SUBAGENT_TYPE_DESCRIPTION = "Exact id from list_subagents.";

interface SubagentResponsePayload {
  subagent_id?: string;
  response?: string;
  error?: {
    code?: string;
    message?: string;
  };
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
  typeOrId: string | undefined,
  prompt: string | undefined,
  contextMode: AgentContextMode | undefined,
  theme: Theme,
): Container {
  const subject = typeOrId?.trim() || "default";
  const contextLabel = contextMode ? ` ${theme.fg("dim", `context: ${contextMode === "fork" ? "forked" : "fresh"}`)}` : "";
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold(verb))} ${theme.fg("accent", subject)} ${theme.fg("toolTitle", "subagent")}${contextLabel}`,
      0,
      0,
    ),
  );
  if (prompt) {
    const blockquote = prompt.split("\n").map((line) => `> ${line}`).join("\n");
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("customMessageLabel", theme.bold("prompt to subagent")), 0, 0));
    container.addChild(
      new Markdown(blockquote, 0, 0, getMarkdownTheme(), {
        color: (value: string) => theme.fg("dim", value),
      }),
    );
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

  const payload = parseSubagentPayload(text);
  if (payload?.error) {
    return new Text(
      theme.fg("error", `${payload.error.code ?? "ERROR"}: ${payload.error.message ?? "Subagent failed."}`),
      0,
      0,
    );
  }

  const response = payload?.response ?? text;
  const display = options.expanded ? response : collapseMarkdown(response, COLLAPSED_RESPONSE_LINES);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent response")), 0, 0));
  container.addChild(
    new Markdown(display || theme.fg("muted", "No response."), 0, 0, getMarkdownTheme(), {
      color: (value: string) => theme.fg("toolOutput", value),
    }),
  );

  const hint = !options.expanded
    ? response !== display
      ? `\n... (${keyHint("app.tools.expand", "to expand")})`
      : `\n(${keyHint("app.tools.expand", "to expand")})`
    : `\n(${keyHint("app.tools.expand", "to collapse")})`;
  const usagePart = formatUsageLine(details, theme);
  const footer = usagePart ? `${hint}  ${usagePart}` : hint;
  container.addChild(new Text(theme.fg("muted", footer), 0, 0));

  return container;
}

function parseSubagentPayload(text: string): SubagentResponsePayload | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as SubagentResponsePayload;
  } catch {
    return undefined;
  }
}

function collapseMarkdown(markdown: string, maxLines: number): string {
  const lines = markdown.trimEnd().split("\n");
  if (lines.length <= maxLines) return markdown;
  return lines.slice(0, maxLines).join("\n");
}

function getAgentContext(type: string | undefined): AgentContextMode | undefined {
  if (!type) return undefined;
  return discoverAgents(getAgentDir()).agents.find((agent) => agent.name === type)?.context;
}

export default function simpleSubagents(pi: ExtensionAPI) {
  // Protect the whole process from ANY extension (local or 3rd party) that
  // touches a stale ctx from a timer/detached promise after session
  // replacement, reload, or subagent-session disposal.
  installStaleCtxGuard();

  const registry = new SubagentRegistry();

  pi.on("session_start", (_event, ctx) => {
    registry.rebuild(ctx.sessionManager.getEntries());
  });

  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description: "List subagent types.",
    promptSnippet: "List subagent types before choosing one.",
    parameters: Type.Object({}),
    execute: (_toolCallId, _params, _signal, _onUpdate, ctx) =>
      executeListSubagents(pi, ctx),
  });

  pi.registerTool({
    name: "get_scoped_models",
    label: "Get Scoped Models",
    description: "List allowed model overrides from Pi's enabledModels.",
    promptSnippet: "List allowed model overrides.",
    parameters: Type.Object({}),
    execute: (_toolCallId, _params, _signal, _onUpdate, ctx) =>
      executeGetScopedModels(ctx),
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: "Spawn a subagent; override model only if the user asks and after get_scoped_models.",
    promptSnippet: "Spawn a subagent.",
    promptGuidelines: [
      "Before spawn_subagent, call list_subagents unless the user or this conversation already supplied the exact type id.",
      "Set spawn_subagent.model only at the user's request; always call get_scoped_models first and use an exact result.",
    ],
    parameters: Type.Object({
      subagent_type: Type.Optional(Type.String({ description: SUBAGENT_TYPE_DESCRIPTION })),
      prompt: Type.String(),
      model: Type.Optional(Type.String({ description: "Exact get_scoped_models result; user-requested only." })),
    }),
    executionMode: "parallel",
    execute: (_toolCallId, params, signal, onUpdate, ctx) =>
      executeSpawnSubagent(
        pi,
        registry,
        params,
        signal,
        onUpdate,
        ctx,
        SELF_EXTENSION_PATH,
      ),
    renderCall: (args, theme) => {
      const type = args.subagent_type ?? loadSettings().defaultSubagentTypeId;
      return renderSubagentCall("spawn", type, args.prompt, getAgentContext(type), theme);
    },
    renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
  });

  pi.registerTool({
    name: "message_subagent",
    label: "Message Subagent",
    description: "Continue a spawned subagent by id.",
    promptSnippet: "Continue a spawned subagent by id.",
    parameters: Type.Object({
      subagent_id: Type.String(),
      prompt: Type.String(),
    }),
    executionMode: "parallel",
    execute: (_toolCallId, params, signal, onUpdate, ctx) =>
      executeMessageSubagent(
        pi,
        registry,
        params,
        signal,
        onUpdate,
        ctx,
        SELF_EXTENSION_PATH,
      ),
    renderCall: (args, theme) => renderSubagentCall("message", args.subagent_id, args.prompt, getAgentContext(registry.get(args.subagent_id)?.type), theme),
    renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
  });
}
