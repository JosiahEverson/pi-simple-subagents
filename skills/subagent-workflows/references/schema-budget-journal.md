# Structured output, budgets, and the journal

## Structured output (`schema`)

Don't parse prose when a schema can express the contract. Pass a JSON Schema in `agent()` options; the worker is instructed to reply with matching JSON, the reply is parsed and validated, and validation failures trigger a correction retry (up to `maxRetriesPerItem`). After exhausted retries, `SchemaValidationError` throws.

```ts
const verdict = await wf.agent<{ pass: boolean; reasons: string[] }>(
  `Review row ${i} against the rubric above.`,
  { schema: {
      type: "object",
      required: ["pass", "reasons"],
      properties: {
        pass: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } },
      },
    } },
);
if (!verdict.output.pass) failures.push(verdict.output.reasons);
```

The validator supports the subset `type`, `properties`, `required`, `items`, `enum` — schemas using other keywords are rejected up front rather than silently half-enforced. Keep schemas flat and small — a worker fills a compact record more reliably than a deep tree. Anything long-form (explanations, patches) belongs in a plain-text agent call or a file, not a schema field.

## Budgets

Set in `createWorkflowRuntime({ budget })`; checked before each spawn (best-effort — a running turn can overshoot a token cap before the next check).

| Field | Default | Notes |
|---|---|---|
| `maxConcurrentAgents` | `maxConcurrentSubagents` setting, else 4 | Semaphore width |
| `maxTotalAgents` | 100 | Set this deliberately in every script |
| `maxRuntime` | unlimited | ms of wall clock; on expiry, running workers are aborted and the run throws |
| `maxRetriesPerItem` | 2 | Schema-correction retries per call |
| `maxTotalTokens` | unlimited | Across all workers |
| `maxTotalCost` | unlimited | USD across all workers |

`BudgetExceededError` names the limit hit. `wf.budget.totals` exposes running `{ agentsSpawned, totalTokens, totalCost, elapsedMs }` — log it in long runs.

## Journal and reruns

Every completed `agent()` call is recorded in `<cwd>/.pi-subagent-workflows/journals/`, keyed by a hash of the task text plus the fully resolved worker spec (role, model, thinking, tools, skills). On rerun, a call whose task and spec are unchanged returns the cached result without spawning.

Consequences:

- **Reruns are cheap.** Edit a later stage and rerun the whole script; earlier unchanged calls hit cache. This is the mechanism for staged control — run, inspect, adjust, rerun.
- **Changing a task string or any spec field invalidates that call** (new key), and its changed output naturally flows into different downstream task strings, re-running what depends on it.
- **Cache keys ignore the outside world.** If the filesystem changed and workers must re-read it, make the change visible in the task (interpolate a content hash or timestamp) or disable the journal.
- The output contract is part of the key: the same task with a different (or no) `schema` is a different call.
- Concurrent workflow processes sharing a cwd share one journal file; writes are merged best-effort — avoid two simultaneous runs in the same cwd.
- Disable with `journal: { enabled: false }` for runs that must always be live.
