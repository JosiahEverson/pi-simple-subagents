# pi-simple-subagents

Inline-defined subagents and workflow orchestration for [Pi](https://github.com/earendil-works/pi-coding-agent).

There are no prebuilt agent roles. Every subagent is defined at spawn time by the orchestrating agent: a task, and optionally a role, model, thinking level, and tool/skill allowlists. For large batches, the orchestrator writes a workflow script that fans out workers and returns one consolidated result.

## Install

Add the package to `~/.pi/agent/settings.json`:

```json
{ "packages": ["pi-simple-subagents"] }
```

## Tools

### `spawn_subagent`

Runs a fresh-context subagent synchronously and returns its final reply.

| Param | | |
|---|---|---|
| `task` | required | Objective, scope, boundaries, expected output |
| `role` | optional | System-prompt instructions for the worker |
| `model` | optional | Exact ID from `get_scoped_models` |
| `thinking` | optional | `off`–`max` |
| `tools` / `skills` | optional | Allowlists; omit for all, `[]` for none |
| `label` | optional | Short display name |

Output is plain text: a `subagent_id: <id>` header line followed by the worker's reply. The extension's own tools are always excluded from workers — no recursive spawning.

### `message_subagent`

Continues a spawned subagent by `subagent_id`. The full resolved spec (role, model, thinking, tools, skills) is persisted at spawn time, so follow-ups recreate the session deterministically.

### `get_scoped_models`

Lists exact model IDs permitted by Pi's `enabledModels`.

## Workflow library

`pi-simple-subagents/workflow` is a programmatic orchestration layer for scripts run outside the Pi process:

```ts
import { createWorkflowRuntime } from "pi-simple-subagents/workflow";

const wf = await createWorkflowRuntime({ budget: { maxTotalAgents: 30 } });
const audits = await wf.pipeline(files, async (file) => ({
  file,
  finding: (await wf.agent(`Audit ${file} for missing auth checks.`, { tools: ["read", "grep"] })).output,
}));
console.log(audits.filter((a) => a.finding !== "NONE"));
```

- `agent(task, options)` — one fresh worker; options match `spawn_subagent`, plus `schema` for JSON-Schema-validated structured output with correction retries.
- `parallel(thunks)` — barrier concurrency.
- `pipeline(items, ...stages)` — streaming stages, no barrier.
- Budgets — `maxConcurrentAgents`, `maxTotalAgents`, `maxRuntime`, `maxRetriesPerItem`, `maxTotalTokens`, `maxTotalCost`.
- Journal — completed calls are cached on disk keyed by task + spec; unchanged calls are served from cache on rerun.

The packaged `subagent-workflows` skill teaches the orchestrating model both surfaces.

## Settings

Under `simpleSubagents` in Pi settings:

| Key | Default | |
|---|---|---|
| `defaultModel` | parent model | `provider/model` |
| `defaultThinking` | parent level | |
| `maxConcurrentSubagents` | 4 | Also the default workflow concurrency |
| `softTimeoutMinutes` | 30 | Worker asked to wrap up |
| `hardTimeoutMinutes` | 45 | Worker aborted |
| `summarizeOnTimeout` | false | Summarize aborted runs |
| `timeoutSummaryModel` | `defaultModel` | |

## Development

```sh
npm test   # typecheck + node:test unit tests
```

License: 0BSD
