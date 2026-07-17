---
name: subagent-workflows
description: Delegate work to subagents — single inline-defined spawns, iterative copilot loops, or workflow scripts that fan out many workers. Use whenever deciding how to delegate, writing a subagent task, or orchestrating a multi-agent batch.
---

# Subagent workflows

Two delegation surfaces exist. Pick by shape of the work:

| Situation | Use |
|---|---|
| 1–3 tasks, or you need to judge each result before deciding what's next | `spawn_subagent` calls, in parallel where independent |
| Follow-up on a previous subagent's work | `message_subagent` with its `subagent_id` |
| Many similar items, staged processing, or structured aggregation | A workflow script (see below) |
| Verification at scale (produce → refute, generate → filter) | A workflow script |

## Spawning directly

Every subagent is defined inline at spawn time — there are no prebuilt agent types:

- `task` (required): objective, scope, boundaries, and the exact output you expect.
- `role`: system-prompt instructions — who the worker is and how it should operate.
- `model` / `thinking`: route deliberately per task (exact `get_scoped_models` ID; lower for mechanical work, higher for judgment and complexity).
- `tools` / `skills`: allowlists; omit for all.
- `label`: short name for progress display and the id.

Output is plain text: a `subagent_id: <id>` header line, then the worker's reply. Ask workers to write large artifacts to files and reply with a short summary plus paths.

Workers automatically inherit normal global Pi extensions; copies of this package's own extension are excluded to prevent recursion. Effective same-named tools from unrelated extensions remain selectable. There is no child extension selector. Use only `tools` and `skills` when narrowing child resources.

Read [references/spawn-spec.md](references/spawn-spec.md) before writing non-trivial task specs.

## Workflow scripts

For batch or staged orchestration, write a TypeScript script to `/tmp` and run it with the bash tool. The script holds intermediate results in variables — only the final consolidated output returns to your context.

```ts
const wf = await createWorkflowRuntime({ budget: { maxTotalAgents: 30 } });
const results = await wf.pipeline(items, (item) => reviewOne(wf, item));
console.log(summarize(results));
```

Run with `npx tsx <script>`. Before running, state how many workers the script will spawn. The launch and every Pi-native worker session follow the user's normal global extension and tool policies.

Read as needed:

- [references/workflow-patterns.md](references/workflow-patterns.md) — script lifecycle, orchestration patterns, scaling guidance.
- [references/schema-budget-journal.md](references/schema-budget-journal.md) — structured output, budgets, journal/resume.
- [references/examples.md](references/examples.md) — complete worked scripts, including batch review of TSV rows.
