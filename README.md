# pi-subagent-workflows

Inline-defined subagents and workflow orchestration for [Pi](https://github.com/earendil-works/pi-coding-agent).

There are no prebuilt agent roles. Every subagent is defined at spawn time by the orchestrating agent: a task, and optionally a role, model, thinking level, and tool/skill allowlists. For large batches, the orchestrator writes a workflow script that fans out workers and returns one consolidated result.

## Install

```sh
pi install npm:pi-subagent-workflows
```

Or add `"npm:pi-subagent-workflows"` to the `packages` array in `~/.pi/agent/settings.json`.

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

Output is plain text: a `subagent_id: <id>` header line followed by the worker's reply.

Workers are normal Pi `AgentSession`s. They automatically discover and bind all global extensions in `print` mode, except copies of this package's own extension, which are identified by package manifest and excluded to prevent recursion. No third-party extension is singled out. Tool selection then operates on Pi's effective tool surface, so same-named tools supplied by another extension remain available. Child resource selection is limited to `tools` and `skills`; there is no per-child extensions option.

### `message_subagent`

Continues a spawned subagent by `subagent_id`. The full resolved spec (role, model, thinking, tools, skills) is persisted at spawn time, so follow-ups recreate the session deterministically.

### `get_scoped_models`

Lists exact model IDs permitted by Pi's `enabledModels`.

## Workflow library

`pi-subagent-workflows/workflow` is a programmatic orchestration layer for scripts run outside the Pi process:

```ts
import { createWorkflowRuntime } from "pi-subagent-workflows/workflow";

const wf = await createWorkflowRuntime({ budget: { maxTotalAgents: 30 } });
const audits = await wf.pipeline(files, async (file) => ({
  file,
  finding: (await wf.agent(`Audit ${file} for missing auth checks.`, { tools: ["read", "grep"] })).output,
}));
console.log(audits.filter((a) => a.finding !== "NONE"));
```

- `agent(task, options)` — one fresh Pi-native worker; options match `spawn_subagent`, plus `schema` for JSON-Schema-validated structured output with correction retries. Results may include `warnings` from resource selection or extensions.
- `parallel(thunks)` — barrier concurrency.
- `pipeline(items, ...stages)` — streaming stages, no barrier.
- Budgets — `maxConcurrentAgents`, `maxTotalAgents`, `maxRuntime`, `maxRetriesPerItem`, `maxTotalTokens`, `maxTotalCost`.
- Journal — completed calls are cached on disk keyed by task + spec; unchanged calls are served from cache on rerun.

Workflow workers use the same global extension discovery as direct workers and bind extensions before active tools are selected. Successful runs emit Pi's shutdown event and dispose before their final warnings are journaled and returned. Both paths keep `projectTrusted: false`. This package is the only extension package filtered from workers.

The packaged `subagent-workflows` skill teaches the orchestrating model both surfaces.

## Settings

Under `subagentWorkflows` in Pi settings:

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
