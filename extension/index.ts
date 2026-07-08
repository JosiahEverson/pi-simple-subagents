import { fileURLToPath } from "node:url";
import { Markdown, Text, Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getMarkdownTheme, keyHint, type AgentToolResult, type ExtensionAPI, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { SubagentRegistry } from "./registry.ts";
import {
  executeListSubagents,
  executeMessageSubagent,
  executeSpawnSubagent,
} from "./run.ts";
import { installStaleCtxGuard } from "./stale-ctx-guard.ts";

const SELF_EXTENSION_PATH = fileURLToPath(import.meta.url);
const COLLAPSED_RESPONSE_LINES = 16;

interface SubagentResponsePayload {
  subagent_id?: string;
  response?: string;
  error?: {
    code?: string;
    message?: string;
  };
}

function renderSubagentCall(
  verb: "spawn" | "message",
  typeOrId: string | undefined,
  prompt: string | undefined,
  theme: Theme,
): Container {
  const subject = typeOrId?.trim() || "default";
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold(verb))} ${theme.fg("accent", subject)} ${theme.fg("toolTitle", "subagent")}`,
      0,
      0,
    ),
  );
  if (prompt) {
    container.addChild(new Text(`\n${theme.fg("dim", prompt)}`, 0, 0));
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

  if (options.isPartial) {
    return new Text(theme.fg("muted", text || "Working..."), 0, 0);
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
  container.addChild(new Text(theme.fg("muted", hint), 0, 0));

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
    description:
      "List available subagent types and their resolved model, tools, skills, and context behavior. Call this before delegating if you need to know which subagent type to use.",
    promptSnippet:
      "List available subagent types with list_subagents before choosing a specialized delegate.",
    parameters: Type.Object({}),
    execute: (_toolCallId, _params, _signal, _onUpdate, ctx) =>
      executeListSubagents(pi, ctx),
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description:
      "Create a persistent Pi subagent session of the requested type, send it an initial prompt, and wait synchronously for its final response.",
    promptSnippet:
      "Delegate bounded work to a persistent subagent session with spawn_subagent.",
    parameters: Type.Object({
      subagent_type: Type.Optional(Type.String()),
      prompt: Type.String(),
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
    renderCall: (args, theme) => renderSubagentCall("spawn", args.subagent_type, args.prompt, theme),
    renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
  });

  pi.registerTool({
    name: "message_subagent",
    label: "Message Subagent",
    description:
      "Send a follow-up prompt to a previously spawned subagent by id, resuming its persistent Pi session, and wait synchronously for its response.",
    promptSnippet:
      "Continue a previous subagent session with message_subagent when you have its subagent_id.",
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
    renderCall: (args, theme) => renderSubagentCall("message", args.subagent_id, args.prompt, theme),
    renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
  });
}
