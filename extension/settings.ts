import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../shared/types.ts";

export interface SubagentWorkflowsSettings {
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
  maxConcurrentSubagents?: number;
  softTimeoutMinutes?: number;
  hardTimeoutMinutes?: number;
  summarizeOnTimeout?: boolean;
  timeoutSummaryModel?: string;
}

export function loadSettings(): SubagentWorkflowsSettings {
  const path = join(getAgentDir(), "settings.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const raw = parsed.subagentWorkflows;
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

function normalizeSettings(raw: object): SubagentWorkflowsSettings {
  const settings = raw as Record<string, unknown>;
  return {
    defaultModel: stringOrUndefined(settings.defaultModel),
    defaultThinking: thinkingOrUndefined(settings.defaultThinking),
    maxConcurrentSubagents: numberOrUndefined(settings.maxConcurrentSubagents),
    softTimeoutMinutes: numberOrUndefined(settings.softTimeoutMinutes),
    hardTimeoutMinutes: numberOrUndefined(settings.hardTimeoutMinutes),
    summarizeOnTimeout: typeof settings.summarizeOnTimeout === "boolean"
      ? settings.summarizeOnTimeout
      : undefined,
    timeoutSummaryModel: stringOrUndefined(settings.timeoutSummaryModel),
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function thinkingOrUndefined(value: unknown): ThinkingLevel | undefined {
  return value === "off" || value === "minimal" || value === "low" ||
    value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}
