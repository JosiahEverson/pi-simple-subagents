import type { UsageSummary, WorkflowBudget } from "./types.ts";

export interface BudgetTotals {
  agentsSpawned: number;
  totalTokens: number;
  totalCost: number;
  elapsedMs: number;
}

export interface WorkflowErrorContext {
  agentId?: string;
  task?: string;
  usage?: UsageSummary;
}

export class BudgetExceededError extends Error {
  readonly agentId?: string;
  readonly task?: string;
  readonly usage?: UsageSummary;

  constructor(
    public readonly limit: keyof WorkflowBudget,
    public readonly current: number,
    public readonly max: number,
    context: WorkflowErrorContext = {},
  ) {
    super(`Workflow budget exceeded: ${limit} is ${current} (maximum ${max}).`);
    this.name = "BudgetExceededError";
    this.agentId = context.agentId;
    this.task = context.task;
    this.usage = context.usage;
  }
}

export class WorkflowAbortedError extends Error {
  constructor(
    message: string,
    public readonly agentId?: string,
    public readonly task?: string,
    public readonly usage?: UsageSummary,
  ) {
    super(message);
    this.name = "WorkflowAbortedError";
  }
}

export class AgentFailedError extends Error {
  constructor(
    message: string,
    public readonly agentId?: string,
    public readonly task?: string,
    public readonly usage?: UsageSummary,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentFailedError";
  }
}

export class BudgetTracker {
  private agentsSpawned = 0;
  private totalTokens = 0;
  private totalCost = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly budget: WorkflowBudget) {}

  checkBeforeSpawn(): void {
    this.checkRuntime();
    this.checkLimit("maxTotalAgents", this.agentsSpawned, this.budget.maxTotalAgents);
    if (this.budget.maxTotalTokens !== undefined) {
      this.checkLimit("maxTotalTokens", this.totalTokens, this.budget.maxTotalTokens);
    }
    if (this.budget.maxTotalCost !== undefined) {
      this.checkLimit("maxTotalCost", this.totalCost, this.budget.maxTotalCost);
    }
    this.agentsSpawned += 1;
  }

  recordUsage(usage: UsageSummary): void {
    this.totalTokens += usage.totalTokens;
    this.totalCost += usage.cost.total;
  }

  checkRuntime(): void {
    const elapsed = Date.now() - this.startedAt;
    if (Number.isFinite(this.budget.maxRuntime) && elapsed > this.budget.maxRuntime) {
      throw this.runtimeAbortError();
    }
  }

  remainingRuntimeMs(): number {
    return Number.isFinite(this.budget.maxRuntime)
      ? Math.max(0, this.startedAt + this.budget.maxRuntime - Date.now())
      : Number.POSITIVE_INFINITY;
  }

  runtimeAbortError(): WorkflowAbortedError {
    const elapsed = Date.now() - this.startedAt;
    return new WorkflowAbortedError(
      `Workflow runtime exceeded: ${elapsed}ms (maximum ${this.budget.maxRuntime}ms).`,
    );
  }

  get totals(): BudgetTotals {
    return {
      agentsSpawned: this.agentsSpawned,
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  private checkLimit(limit: keyof WorkflowBudget, current: number, max: number): void {
    if (current >= max) throw new BudgetExceededError(limit, current, max);
  }
}
