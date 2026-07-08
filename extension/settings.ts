import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./agents.ts";

export interface SimpleSubagentsSettings {
  defaultModel?: string;
  defaultSubagentTypeId?: string;
  defaultThinking?: ThinkingLevel;
  builtinSubagentOverrides?: Record<string, { model?: string; thinking?: ThinkingLevel }>;
  summarizeOnTimeout?: boolean;
  timeoutSummaryModel?: string;
  softTimeoutMinutes?: number;
  hardTimeoutMinutes?: number;
  maxConcurrentSubagents?: number;
}

export function loadSettings(): SimpleSubagentsSettings {
  const path = join(getAgentDir(), "settings.json");
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const raw = parsed.simpleSubagents;
    return normalizeSettings(raw && typeof raw === "object" ? raw : {});
  } catch {
    return {};
  }
}

export function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizeSettings(raw: object): SimpleSubagentsSettings {
  const settings = raw as Record<string, unknown>;
  const overrides = settings.builtinSubagentOverrides;

  return {
    defaultModel: stringOrUndefined(settings.defaultModel),
    defaultSubagentTypeId: stringOrUndefined(settings.defaultSubagentTypeId),
    defaultThinking: thinkingOrUndefined(settings.defaultThinking),
    builtinSubagentOverrides:
      overrides && typeof overrides === "object"
        ? normalizeOverrides(overrides as Record<string, unknown>)
        : undefined,
    summarizeOnTimeout:
      typeof settings.summarizeOnTimeout === "boolean"
        ? settings.summarizeOnTimeout
        : undefined,
    timeoutSummaryModel: stringOrUndefined(settings.timeoutSummaryModel),
    softTimeoutMinutes: numberOrUndefined(settings.softTimeoutMinutes),
    hardTimeoutMinutes: numberOrUndefined(settings.hardTimeoutMinutes),
    maxConcurrentSubagents: numberOrUndefined(settings.maxConcurrentSubagents),
  };
}

function normalizeOverrides(
  raw: Record<string, unknown>,
): Record<string, { model?: string; thinking?: ThinkingLevel }> {
  const out: Record<string, { model?: string; thinking?: ThinkingLevel }> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    out[name] = {
      model: stringOrUndefined(entry.model),
      thinking: thinkingOrUndefined(entry.thinking),
    };
  }
  return out;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function thinkingOrUndefined(value: unknown): ThinkingLevel | undefined {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}
