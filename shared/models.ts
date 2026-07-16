import type { Model } from "@earendil-works/pi-ai/compat";
import {
  resolveModelScopeWithDiagnostics,
  type ModelRegistry,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ParsedModelId {
  provider: string;
  modelId: string;
}

/** Parse only an exact, qualified provider/model ID. */
export function parseScopedModelId(value: string): ParsedModelId | undefined {
  const trimmed = value.trim();
  if (trimmed !== value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return {
    provider: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

export function formatModelId(
  model: Pick<Model<any>, "provider" | "id">,
): string {
  return `${model.provider}/${model.id}`;
}

export function findModelById(
  modelId: string,
  registry: Pick<ModelRegistry, "find">,
): Model<any> | undefined {
  const parsed = parseScopedModelId(modelId);
  return parsed ? registry.find(parsed.provider, parsed.modelId) : undefined;
}

export function findRuntimeModelById(
  modelId: string,
  runtime: Pick<ModelRuntime, "getModel">,
): Model<any> | undefined {
  const parsed = parseScopedModelId(modelId);
  return parsed ? runtime.getModel(parsed.provider, parsed.modelId) : undefined;
}

export function isScopedModelId(
  requested: string,
  scopedIds: readonly string[],
): boolean {
  return parseScopedModelId(requested) !== undefined && scopedIds.includes(requested);
}

export interface ScopedModels {
  models: Model<any>[];
  ids: string[];
  warnings: string[];
}

/** Resolve the exact model scope exposed by Pi's enabledModels setting. */
export async function resolveScopedModels(
  runtime: ModelRuntime,
  settings: Pick<SettingsManager, "getEnabledModels" | "drainErrors">,
): Promise<ScopedModels> {
  const available = [...await runtime.getAvailable()];
  const patterns = settings.getEnabledModels();
  const settingsWarnings = settings.drainErrors().map(({ error }) => `Pi settings: ${error.message}`);
  let models = available;
  let warnings = settingsWarnings;
  if (patterns && patterns.length > 0) {
    const resolved = await resolveModelScopeWithDiagnostics(patterns, runtime);
    models = resolved.scopedModels.length > 0 ? resolved.scopedModels.map(({ model }) => model) : available;
    warnings = [...settingsWarnings, ...resolved.diagnostics.map(({ message }) => message)];
  }
  return { models, ids: models.map(formatModelId), warnings };
}
