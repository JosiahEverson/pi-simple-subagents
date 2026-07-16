import { randomBytes } from "node:crypto";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuntimeSubagentSpec } from "../shared/spec.ts";

export const REGISTRY_ENTRY_TYPE = "subagent-workflows:spawn";

export interface RegistryRecord {
  id: string;
  spec: RuntimeSubagentSpec;
  sessionFile: string;
  createdAt: string;
}

export class SubagentRegistry {
  private readonly records = new Map<string, RegistryRecord>();

  rebuild(entries: SessionEntry[]): void {
    this.records.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== REGISTRY_ENTRY_TYPE) continue;
      if (isRegistryRecord(entry.data)) this.records.set(entry.data.id, entry.data);
    }
  }

  createId(label: string): string {
    const prefix = label.replace(/[^a-zA-Z0-9_-]/g, "-") || "subagent";
    for (let i = 0; i < 20; i++) {
      const id = `${prefix}-${randomBytes(3).toString("hex")}`;
      if (!this.records.has(id)) return id;
    }
    throw new Error("Unable to generate a unique subagent id");
  }

  record(pi: Pick<ExtensionAPI, "appendEntry">, record: RegistryRecord): void {
    this.records.set(record.id, record);
    pi.appendEntry(REGISTRY_ENTRY_TYPE, record);
  }

  get(id: string): RegistryRecord | undefined {
    return this.records.get(id);
  }
}

function isRegistryRecord(value: unknown): value is RegistryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    isRuntimeSubagentSpec(record.spec) &&
    typeof record.sessionFile === "string" &&
    typeof record.createdAt === "string";
}

function isRuntimeSubagentSpec(value: unknown): value is RuntimeSubagentSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Record<string, unknown>;
  return typeof spec.label === "string" &&
    typeof spec.systemPrompt === "string" && spec.systemPrompt.length > 0 &&
    isSelectionSpec(spec.tools) && isSelectionSpec(spec.skills) &&
    typeof spec.modelId === "string" &&
    isThinkingLevel(spec.thinking);
}

function isSelectionSpec(value: unknown): boolean {
  return value === "all" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function isThinkingLevel(value: unknown): boolean {
  return value === "off" || value === "minimal" || value === "low" ||
    value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
