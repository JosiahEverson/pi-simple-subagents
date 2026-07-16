import type { SelectionSpec } from "./types.ts";

export const SELF_TOOL_NAMES = new Set<string>([
  "spawn_subagent",
  "message_subagent",
  "get_scoped_models",
]);

export interface SelectionResult {
  selected: string[];
  warnings: string[];
}

export function filterToolSelection(
  availableNames: readonly string[],
  spec: SelectionSpec,
): SelectionResult {
  const available = availableNames.filter((name) => !SELF_TOOL_NAMES.has(name));
  return filterSelection(available, spec, "tool");
}

export function filterSkillSelection(
  availableNames: readonly string[],
  spec: SelectionSpec,
): SelectionResult {
  return filterSelection(availableNames, spec, "skill");
}

function filterSelection(
  availableNames: readonly string[],
  spec: SelectionSpec,
  kind: "tool" | "skill",
): SelectionResult {
  if (spec === "all") return { selected: [...availableNames], warnings: [] };

  const available = new Set(availableNames);
  const warnings: string[] = [];
  const selected = spec.filter((name) => {
    if (kind === "tool" && SELF_TOOL_NAMES.has(name)) return false;
    if (available.has(name)) return true;
    warnings.push(`Unknown ${kind} "${name}" requested by subagent spec.`);
    return false;
  });
  return { selected, warnings };
}
