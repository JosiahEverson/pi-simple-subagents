export function phase(name: string): void {
  console.log(`[phase] ${name}`);
}

export function log(message: string): void {
  console.log(`[log] ${message}`);
}

export function agentCompleted(agentId: string, elapsedMs: number, usage: import("./types.ts").UsageSummary): void {
  console.log(
    `[agent:${agentId}] ✓ ${(elapsedMs / 1000).toFixed(1)}s | ↑${formatCount(usage.input)} ↓${formatCount(usage.output)} | $${usage.cost.total.toFixed(3)}`,
  );
}

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}
