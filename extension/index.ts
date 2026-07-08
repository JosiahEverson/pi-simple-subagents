import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentRegistry } from "./registry.ts";
import {
  executeListSubagents,
  executeMessageSubagent,
  executeSpawnSubagent,
} from "./run.ts";

const SELF_EXTENSION_PATH = fileURLToPath(import.meta.url);

export default function simpleSubagents(pi: ExtensionAPI) {
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
  });
}
