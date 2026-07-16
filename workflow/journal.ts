import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SelectionSpec } from "../shared/types.ts";
import type { AgentResult, JournalConfig, JournalEntry, JournalInput } from "./types.ts";

export type { JournalConfig, JournalEntry, JournalInput } from "./types.ts";

export function deriveJournalKey(input: JournalInput): string {
  const normalized = JSON.stringify({
    task: input.task.trim(),
    systemPrompt: input.spec.systemPrompt,
    tools: normalizeSelection(input.spec.tools),
    skills: normalizeSelection(input.spec.skills),
    modelId: input.spec.modelId,
    thinking: input.spec.thinking,
    schema: input.schema ?? null,
  });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function normalizeSelection(spec: SelectionSpec): SelectionSpec {
  return spec === "all" ? "all" : [...spec].sort();
}

export function journalInputsEqual(left: JournalInput, right: JournalInput): boolean {
  return left.task.trim() === right.task.trim() &&
    JSON.stringify(left.spec) === JSON.stringify(right.spec) &&
    left.schema === right.schema;
}

/** Merge persisted and in-memory records, preferring the current process for duplicate keys. */
export function mergeJournalEntries(
  persisted: ReadonlyMap<string, JournalEntry>,
  current: ReadonlyMap<string, JournalEntry>,
): Map<string, JournalEntry> {
  return new Map([...persisted, ...current]);
}

export class Journal {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly path: string;
  private entries = new Map<string, JournalEntry>();
  private writeChain = Promise.resolve();

  constructor(config: JournalConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.dir = config.dir ?? join(process.cwd(), ".pi-simple-subagents", "journals");
    this.path = join(this.dir, "journal.json");
  }

  async load(): Promise<void> {
    if (!this.enabled) return;
    this.entries = await this.readEntries();
  }

  get(key: string): JournalEntry | undefined {
    if (!this.enabled) return undefined;
    return this.entries.get(key);
  }

  async record(key: string, input: JournalInput, result: AgentResult<unknown>): Promise<void> {
    if (!this.enabled) return;
    this.entries.set(key, { key, input, result, completedAt: new Date().toISOString() });
    this.writeChain = this.writeChain.then(
      () => this.persist(),
      () => this.persist(),
    );
    await this.writeChain;
  }

  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const persisted = await this.readEntries();
    // Best effort across processes: a writer can still rename between this read and our rename.
    this.entries = mergeJournalEntries(persisted, this.entries);
    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.entries.values()], null, 2), "utf8");
    await rename(temporary, this.path);
  }

  private async readEntries(): Promise<Map<string, JournalEntry>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Journal root must be an array.");
      return new Map(parsed.map((value) => {
        const entry = parseJournalEntry(value);
        return [entry.key, entry];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
  }
}

function parseJournalEntry(value: unknown): JournalEntry {
  if (!value || typeof value !== "object") throw new Error("Journal entry must be an object.");
  const entry = value as Partial<JournalEntry>;
  if (typeof entry.key !== "string" || !entry.input || typeof entry.input.task !== "string" ||
      !entry.input.spec || (entry.input.schema !== undefined && typeof entry.input.schema !== "string") ||
      !entry.result || typeof entry.completedAt !== "string") {
    throw new Error("Journal entry has an invalid shape.");
  }
  return entry as JournalEntry;
}
