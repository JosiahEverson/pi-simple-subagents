import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RuntimeSubagentSpec } from "../shared/spec.ts";
import { deriveJournalKey, Journal, mergeJournalEntries } from "../workflow/journal.ts";
import type { AgentResult, JournalInput } from "../workflow/types.ts";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const spec: RuntimeSubagentSpec = {
  label: "worker", systemPrompt: "prompt", tools: ["read", "bash"], skills: ["one", "two"],
  modelId: "provider/model", thinking: "medium",
};
const input = (task = "task", overrides: Partial<RuntimeSubagentSpec> = {}): JournalInput =>
  ({ task, spec: { ...spec, ...overrides } });
const result: AgentResult<unknown> = {
  output: "done", agentId: "worker-123", usage: { assistantTurns: 1, input: 1, output: 2,
    cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

describe("journal", () => {
  it("derives deterministic, ordering-independent keys", () => {
    const first = deriveJournalKey(input());
    assert.equal(first, deriveJournalKey(input()));
    assert.equal(first, deriveJournalKey(input("task", { tools: ["bash", "read"], skills: ["two", "one"] })));
  });

  it("normalizes surrounding task whitespace", () => {
    assert.equal(deriveJournalKey(input(" task ")), deriveJournalKey(input("task")));
  });

  it("distinguishes absent and different schemas for the same task and spec", () => {
    const base = input();
    const first = { ...base, schema: '{"type":"string"}' };
    const second = { ...base, schema: '{"type":"number"}' };
    assert.notEqual(deriveJournalKey(base), deriveJournalKey(first));
    assert.notEqual(deriveJournalKey(first), deriveJournalKey(second));
  });

  it("merges persisted records while current records win by key", () => {
    const older = { key: "same", input: input("old"), result, completedAt: "old" };
    const external = { key: "external", input: input("external"), result, completedAt: "external" };
    const current = { key: "same", input: input("current"), result, completedAt: "current" };
    const merged = mergeJournalEntries(
      new Map([[older.key, older], [external.key, external]]),
      new Map([[current.key, current]]),
    );
    assert.equal(merged.get("same"), current);
    assert.equal(merged.get("external"), external);
  });

  it("returns a cache hit for a matching completed input", async () => {
    const journal = await createJournal();
    const key = deriveJournalKey(input());
    await journal.record(key, input(), result);
    assert.deepEqual(journal.get(key)?.result, result);
  });

  it("misses when task changes", async () => {
    const journal = await createJournal();
    await journal.record(deriveJournalKey(input()), input(), result);
    assert.equal(journal.get(deriveJournalKey(input("changed"))), undefined);
  });

  it("misses when a spec field changes", async () => {
    const journal = await createJournal();
    await journal.record(deriveJournalKey(input()), input(), result);
    assert.equal(journal.get(deriveJournalKey(input("task", { thinking: "high" }))), undefined);
  });
});

async function createJournal(): Promise<Journal> {
  const dir = await mkdtemp(join(tmpdir(), "subagents-journal-"));
  dirs.push(dir);
  const journal = new Journal({ dir });
  await journal.load();
  return journal;
}
