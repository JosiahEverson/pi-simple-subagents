# Workflow scripts

A workflow script is deterministic orchestration code you write for one task: it spawns fresh-context workers, holds their intermediate results in variables, and prints one consolidated result. Your context receives only that final output — not N raw worker replies.

Use a script instead of direct spawns when:

- More than ~3 workers doing homogeneous work (one rubric, many items).
- Stages: results of one wave feed the next (discover → process → verify → synthesize).
- Results need structured aggregation (counts, filters, rankings) that shouldn't burn your context.
- Verification patterns: every finding independently refuted, every candidate scored.

Stay with direct `spawn_subagent` when you need to exercise judgment between steps — scripts don't pause for decisions mid-run. For staged control, split into smaller scripts or rerun: the journal serves completed, unchanged calls from cache, so a rerun after editing later stages costs only the changed work.

## Lifecycle

1. Write the script to `/tmp/<name>.ts`.
2. Import the library **by absolute path** from the package root (module resolution won't find it from `/tmp`). The package root is a path listed under `"packages"` in `~/.pi/agent/settings.json`, or `~/.pi/agent/npm/node_modules/pi-subagent-workflows`.
3. Tell the user how many workers the script will spawn, then run:
   `npx tsx /tmp/<name>.ts`
   (`node --experimental-transform-types` also works, but only when the package root is outside `node_modules` — e.g. a local checkout; Node refuses to strip types under `node_modules`.)
4. Progress streams to stdout (`[phase]`, `[log]`, per-agent completion lines); the final `console.log` is your result.

Every script starts:

```ts
import { createWorkflowRuntime } from "<package-root>/workflow/index.ts";

const wf = await createWorkflowRuntime({
  budget: { maxTotalAgents: 30 },          // always set a deliberate cap
  args: { /* parameterize reruns here */ },
});
```

`wf.agent<T>(task, options?)` spawns one worker and resolves to `{ output, usage, agentId }`. Options are the same as `spawn_subagent` (`role`, `model`, `thinking`, `tools`, `skills`, `label`) plus `schema` for structured output. `wf.phase(name)` and `wf.log(msg)` print progress. Plain JavaScript handles everything else: loops, conditions, filtering, dedup, aggregation.

## Patterns

### Fan out + synthesize

Independent perspectives on one subject, then one synthesis pass:

```ts
const angles = ["security", "performance", "maintainability"];
const reviews = await wf.parallel(angles.map((angle) => () =>
  wf.agent(`Review ${target} strictly from a ${angle} perspective. Report top 3 issues with evidence.`,
    { label: angle })));
const synthesis = await wf.agent(
  `Merge these reviews into one prioritized issue list, deduplicating overlaps:\n\n${reviews.map((r) => r.output).join("\n---\n")}`,
  { thinking: "high" });
console.log(synthesis.output);
```

`parallel(thunks)` is a barrier: use it when the next step needs the whole wave.

### Streaming pipeline with verification

`pipeline(items, ...stages)` is streaming — item A enters stage 2 while item B is still in stage 1. Each stage is `(item, index) => Promise<item>`; carry results forward on the item object:

```ts
type Item = { file: string; finding?: string; confirmed?: boolean };
const items: Item[] = files.map((file) => ({ file }));

const results = await wf.pipeline(
  items,
  async (it) => ({ ...it, finding: (await wf.agent(
    `Audit ${it.file} for missing input validation. Reply NONE if clean, else describe the flaw with line refs.`,
    { tools: ["read", "grep"], label: it.file })).output }),
  async (it) => it.finding === "NONE" ? { ...it, confirmed: false } : ({ ...it, confirmed: (await wf.agent(
    `Attempt to REFUTE this finding. Reply CONFIRMED or REFUTED with reasoning:\n${it.finding}`,
    { thinking: "high", label: `verify-${it.file}` })).output.startsWith("CONFIRMED") }),
);
console.log(results.filter((r) => r.confirmed));
```

Producing and refuting with separate workers avoids self-preference; route the judge to a strong model.

### Classify and route

Cheap classification first, expensive treatment only where warranted:

```ts
const classified = await wf.pipeline(items, async (it) => ({ ...it,
  kind: (await wf.agent(`Classify: ...`, { thinking: "low", schema: kindSchema })).output }));
for (const it of classified.filter((i) => i.kind.severity === "high")) { /* strong-model pass */ }
```

### Generate and filter

Over-generate candidates in parallel, then score/filter with an independent judge; keep only survivors.

## Scaling and stop conditions

- Workers proportional to genuine task complexity: a simple check is 1 agent; a comparison 2–4; only sweeping audits justify dozens. Over-allocation is the common failure.
- Always cap `maxTotalAgents`; never loop without an explicit stop condition (max iterations, or "no new findings this round").
- One shared rubric belongs in a script constant interpolated into each task — never make workers read a shared spec file.
- Workers share the working directory: keep parallel workers write-disjoint, or make them read-only and apply changes in a final sequential stage.
