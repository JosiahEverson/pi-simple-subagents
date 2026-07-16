import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveJournalHitOrReserveSpawn } from "../workflow/agent.ts";
import { BudgetExceededError, BudgetTracker, WorkflowAbortedError } from "../workflow/budget.ts";
import type { JournalInput, UsageSummary, WorkflowBudget } from "../workflow/types.ts";

function budget(overrides: Partial<WorkflowBudget> = {}): WorkflowBudget {
  return { maxConcurrentAgents: 4, maxTotalAgents: 100, maxRuntime: Infinity, maxRetriesPerItem: 2, ...overrides };
}
function usage(tokens: number, cost: number): UsageSummary {
  return { assistantTurns: 1, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: tokens, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

describe("BudgetTracker", () => {
  it("throws when maxTotalAgents is reached", () => {
    const tracker = new BudgetTracker(budget({ maxTotalAgents: 1 }));
    tracker.checkBeforeSpawn();
    assert.throws(() => tracker.checkBeforeSpawn(), BudgetExceededError);
  });

  it("throws before spawning after maxTotalTokens is reached", () => {
    const tracker = new BudgetTracker(budget({ maxTotalTokens: 10 }));
    tracker.recordUsage(usage(10, 0));
    assert.throws(() => tracker.checkBeforeSpawn(), BudgetExceededError);
  });

  it("accumulates usage across calls", () => {
    const tracker = new BudgetTracker(budget());
    tracker.recordUsage(usage(7, 0.2));
    tracker.recordUsage(usage(5, 0.3));
    assert.equal(tracker.totals.totalTokens, 12);
    assert.equal(tracker.totals.totalCost, 0.5);
  });

  it("throws when runtime exceeds maxRuntime", () => {
    const tracker = new BudgetTracker(budget({ maxRuntime: -1 }));
    assert.throws(() => tracker.checkRuntime(), WorkflowAbortedError);
  });

  it("does not reserve agent budget for a journal cache hit", () => {
    const tracker = new BudgetTracker(budget({ maxTotalAgents: 1 }));
    const input: JournalInput = {
      task: "cached",
      spec: {
        label: "cached", systemPrompt: "prompt", tools: "all", skills: "all",
        modelId: "provider/model", thinking: "medium",
      },
    };
    const cached = {
      key: "key",
      input,
      result: { output: "done", agentId: "cached-1", usage: usage(0, 0) },
      completedAt: new Date(0).toISOString(),
    };
    assert.equal(resolveJournalHitOrReserveSpawn({ get: () => cached }, tracker, "key", input), cached.result);
    assert.equal(tracker.totals.agentsSpawned, 0);
  });
});
