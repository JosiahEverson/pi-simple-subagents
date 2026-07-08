import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

export const REGISTRY_ENTRY_TYPE = "simple-subagents:spawn";

export interface RegistryRecord {
  id: string;
  type: string;
  sessionFile: string;
  createdAt: string;
}

export class SubagentRegistry {
  private readonly records = new Map<string, RegistryRecord>();

  rebuild(entries: SessionEntry[]): void {
    this.records.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== REGISTRY_ENTRY_TYPE) {
        continue;
      }
      if (isRegistryRecord(entry.data)) {
        this.records.set(entry.data.id, entry.data);
      }
    }
  }

  createId(type: string): string {
    const prefix = type.replace(/[^a-zA-Z0-9_-]/g, "-") || "subagent";
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
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.sessionFile === "string" &&
    typeof record.createdAt === "string"
  );
}
