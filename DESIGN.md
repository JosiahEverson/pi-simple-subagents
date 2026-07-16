# pi-simple-subagents Design

## 1. Architecture Overview

A single canonical intermediate representation — `RuntimeSubagentSpec` — decouples spawn configuration from any particular source. Every session-creation path, the registry, and the workflow library consume this one type.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Extension (Pi tool surface)                                         │
│                                                                      │
│  spawn_subagent ──► resolveSpec() ──► RuntimeSubagentSpec            │
│                                           │                          │
│                                           ├──► createConfiguredSession()
│                                           │        (shared)          │
│                                           └──► registry.record(spec) │
│                                                                      │
│  message_subagent ──► registry.get() ──► persisted spec              │
│                           │                                          │
│                           └──► createConfiguredSession(spec)          │
│                                                                      │
│  get_scoped_models (unchanged scope logic)                           │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  Workflow library (subpath export "pi-simple-subagents/workflow")     │
│                                                                      │
│  agent(task, opts) ──► resolveSpec() ──► RuntimeSubagentSpec         │
│                                              │                       │
│                                              └──► createAgentSession │
│                                                   (Pi SDK direct)    │
│  parallel(), pipeline(), phase(), log(), args, budget, journal       │
└──────────────────────────────────────────────────────────────────────┘
```

**Shared code** between extension and workflow library:

- `RuntimeSubagentSpec` type and resolution/normalization logic
- Model ID validation (scoped-model check)
- Tool/skill filtering logic
- System-prompt/harness-prompt construction

**Not shared:**

- Extension: TUI rendering, registry persistence, progress emission, semaphore, stale-ctx-guard
- Workflow: journal, budget accounting, JSON Schema validation, parallel/pipeline primitives, stdout progress

---

## 2. Module / File Layout

### Deleted

| Path | Reason |
|------|--------|
| `agents/` (directory) | Personas removed entirely |
| `extension/agents.ts` | Persona discovery/parsing removed |

### Changed

| Path | Changes |
|------|---------|
| `extension/index.ts` | Remove `list_subagents` tool registration; update `spawn_subagent` schema; update rendering for plain-text output; remove persona discovery imports |
| `extension/run.ts` | Gut persona-based spawn; consume `RuntimeSubagentSpec` directly; plain-text output format; simplified `message_subagent` using persisted spec |
| `extension/registry.ts` | Record schema with full spec persistence |
| `extension/settings.ts` | Remove `builtinSubagentOverrides`, `defaultSubagentTypeId`; keep `defaultModel`, `defaultThinking`, `maxConcurrentSubagents`, timeout settings |
| `package.json` | Add `exports` for subpath; add `workflow/` to `files`; add test script; adjust `pi.skills` |
| `tsconfig.json` | Extend `include` to cover `workflow/**/*.ts` and `test/**/*.ts` |
| `README.md` | Tool reference, settings, workflow usage |

### Added

| Path | Purpose |
|------|---------|
| `shared/spec.ts` | `RuntimeSubagentSpec` type, `resolveSpec()`, normalization, system-prompt builder, harness-prompt builder |
| `shared/tools.ts` | Tool/skill filtering logic (extracted from run.ts) |
| `shared/models.ts` | Model ID validation, scoped-model utilities |
| `shared/types.ts` | Shared type re-exports (`ThinkingLevel`, `SelectionSpec`, etc.) |
| `workflow/index.ts` | Public API: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `createWorkflowRuntime()` |
| `workflow/budget.ts` | Budget accounting and enforcement |
| `workflow/journal.ts` | Run journal: persistence, keying, cache lookup, invalidation |
| `workflow/schema.ts` | JSON Schema output validation with retry logic |
| `workflow/semaphore.ts` | Re-export or fork of extension semaphore for workflow concurrency |
| `workflow/types.ts` | Public types: `WorkflowBudget`, `JournalEntry`, `AgentOptions`, `WorkflowConfig` |
| `test/spec.test.ts` | Spec resolution/normalization tests |
| `test/journal.test.ts` | Journal keying, cache hit/miss, invalidation tests |
| `test/schema.test.ts` | JSON Schema validation + retry decision tests |
| `test/budget.test.ts` | Budget accounting tests |
| `skills/subagent-workflows/SKILL.md` | Entry-point skill |
| `skills/subagent-workflows/references/spawn-spec.md` | Spawn-spec authoring guide |
| `skills/subagent-workflows/references/workflow-patterns.md` | Workflow script patterns |
| `skills/subagent-workflows/references/schema-budget-journal.md` | Schema/budget/journal reference |
| `skills/subagent-workflows/references/examples.md` | Worked examples |

---

## 3. Type Definitions

### 3.1 ThinkingLevel and SelectionSpec

```typescript
// shared/types.ts

export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * "all" means every available tool/skill (minus self-tools).
 * string[] is an explicit allowlist of names.
 */
export type SelectionSpec = "all" | string[];
```

### 3.2 RuntimeSubagentSpec

```typescript
// shared/spec.ts

export interface RuntimeSubagentSpec {
  /** Display label for progress/logs and ID prefix. */
  label: string;

  /**
   * Complete system prompt text delivered to the subagent session.
   * Includes role instructions if any. Never empty.
   */
  systemPrompt: string;

  /** Tool selection. "all" minus self-tools, or explicit allowlist. */
  tools: SelectionSpec;

  /** Skill selection. "all" or explicit allowlist. */
  skills: SelectionSpec;

  /**
   * Exact resolved model ID in "provider/model" format.
   * Resolved at spawn time and frozen for continuations.
   */
  modelId: string;

  /** Thinking level for the session. */
  thinking: ThinkingLevel;
}
```

### 3.3 Spec Resolution

```typescript
// shared/spec.ts

export interface SpawnInput {
  task: string;
  role?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  skills?: string[];
  label?: string;
}

export interface ResolutionContext {
  /** Parent session's current model ID ("provider/model") */
  parentModelId: string;
  /** Parent session's current thinking level */
  parentThinking: ThinkingLevel;
  /** Settings: simpleSubagents.defaultModel */
  defaultModel?: string;
  /** Settings: simpleSubagents.defaultThinking */
  defaultThinking?: ThinkingLevel;
}

/**
 * Builds a RuntimeSubagentSpec from spawn-time arguments and resolution context.
 * Pure function — no I/O.
 */
export function resolveSpec(input: SpawnInput, context: ResolutionContext): RuntimeSubagentSpec;
```

**Resolution precedence (model):**

1. `input.model` (spawn arg — must be exact scoped-model ID, validated upstream)
2. `context.defaultModel` (settings `simpleSubagents.defaultModel`)
3. `context.parentModelId` (current parent model)

**Resolution precedence (thinking):**

1. `input.thinking` (spawn arg)
2. `context.defaultThinking` (settings `simpleSubagents.defaultThinking`)
3. `context.parentThinking` (parent session thinking)

**System prompt construction:**

```typescript
function buildSystemPrompt(role: string | undefined): string {
  if (role && role.trim().length > 0) {
    return `You are a subagent.\n\n${role.trim()}`;
  }
  return "You are a subagent. Follow the instructions in your task exactly.";
}
```

**Label derivation:**

```typescript
function deriveLabel(input: SpawnInput): string {
  if (input.label) return sanitizeLabel(input.label);
  // Derive from first meaningful word(s) of task, max 20 chars
  return sanitizeLabel(input.task.slice(0, 20)) || "subagent";
}

function sanitizeLabel(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "subagent";
}
```

**Tools/skills:**

- If `input.tools` is undefined → `"all"` (all available minus self-tools)
- If `input.tools` is `[]` → no tools (model only)
- If `input.tools` is `["read", "bash"]` → explicit allowlist
- Same logic for skills

### 3.4 Harness Prompt

```typescript
// shared/spec.ts

export function buildHarnessPrompt(task: string, isFollowUp: boolean): string {
  const kind = isFollowUp ? "Follow-up task" : "Task";
  return [
    `${kind} from the parent agent. Complete it and reply with your results.`,
    "",
    "<parent_task>",
    task,
    "</parent_task>",
  ].join("\n");
}
```

### 3.5 Registry Record

```typescript
// extension/registry.ts

export const REGISTRY_ENTRY_TYPE = "simple-subagents:spawn";

export interface RegistryRecord {
  id: string;
  spec: RuntimeSubagentSpec;
  sessionFile: string;
  createdAt: string;
}
```

On `session_start`, rebuild scans custom entries matching the `REGISTRY_ENTRY_TYPE`.

### 3.6 Tool Schemas

#### `spawn_subagent`

```typescript
Type.Object({
  task: Type.String({ description: "Complete task description for the subagent." }),
  role: Type.Optional(Type.String({
    description: "System-prompt role/instructions. Omit for a generic worker.",
  })),
  model: Type.Optional(Type.String({
    description: "Exact model ID from get_scoped_models. Route by task fit; omit to inherit the default.",
  })),
  thinking: Type.Optional(Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
    Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ], { description: "Thinking level override." })),
  tools: Type.Optional(Type.Array(Type.String(), {
    description: "Tool allowlist. Omit for all tools.",
  })),
  skills: Type.Optional(Type.Array(Type.String(), {
    description: "Skill allowlist. Omit for all skills.",
  })),
  label: Type.Optional(Type.String({
    description: "Short label for identification (used in progress and subagent_id).",
  })),
})
```

- `executionMode: "parallel"`
- Prompt guidelines: model/thinking routing is an orchestrator decision — route deliberately per task; model overrides must be exact `get_scoped_models` IDs.

#### `message_subagent`

```typescript
Type.Object({
  subagent_id: Type.String({ description: "ID returned by spawn_subagent." }),
  prompt: Type.String({ description: "Follow-up task or question." }),
})
```

- `executionMode: "parallel"`

#### `get_scoped_models`

```typescript
Type.Object({})
```

### 3.7 Tool Output Format

Plain text, not JSON. First line is the id header; remainder is the raw markdown response.

**Success:**

```
subagent_id: worker-a1b2c3
<raw markdown response from subagent>
```

**Error:**

```
subagent_id: worker-a1b2c3
ERROR [CODE]: message
```

Or without ID (when spawn fails before ID generation):

```
ERROR [MODEL_NOT_SCOPED]: Model override was not returned by get_scoped_models: bad/model
```

The `details` object retains structured metadata for TUI rendering:

```typescript
interface SubagentToolDetails {
  subagent_id?: string;
  sessionFile?: string;
  elapsedMs?: number;
  model?: string;
  thinking?: ThinkingLevel;
  usage?: UsageSummary;
  warnings?: string[];
}
```

---

## 4. Workflow Library

### 4.1 Package Export

```jsonc
// package.json (partial)
{
  "exports": {
    ".": "./extension/index.ts",
    "./workflow": "./workflow/index.ts"
  },
  "pi": {
    "extensions": ["./extension/index.ts"],
    "skills": ["./skills"]
  }
}
```

The workflow library is imported by orchestrator-written scripts:

```typescript
import { agent, parallel, pipeline, phase, log, createWorkflowRuntime } from "pi-simple-subagents/workflow";
```

These scripts are written to `/tmp`, then executed via Pi's `bash` tool as a child process (e.g. `npx tsx /tmp/workflow-abc.ts`). The workflow library links against the Pi SDK (`@earendil-works/pi-coding-agent`) as a peer dependency.

### 4.2 Public API

```typescript
// workflow/index.ts

export { createWorkflowRuntime } from "./runtime.ts";
export { agent } from "./agent.ts";
export { parallel } from "./parallel.ts";
export { pipeline } from "./pipeline.ts";
export { phase, log } from "./progress.ts";

export type {
  WorkflowConfig,
  WorkflowBudget,
  AgentOptions,
  AgentResult,
  JournalEntry,
  JournalConfig,
} from "./types.ts";
```

### 4.3 `createWorkflowRuntime()`

Entry point that initializes SDK services and returns the primitives bound to a shared runtime context.

```typescript
// workflow/types.ts

export interface WorkflowConfig {
  /** Working directory for agent sessions. Default: process.cwd() */
  cwd?: string;

  /** Budget constraints. */
  budget?: Partial<WorkflowBudget>;

  /** Journal configuration for resume support. */
  journal?: JournalConfig;

  /** Arguments passed from the orchestrator (accessed as `args` in script). */
  args?: Record<string, unknown>;
}

export interface WorkflowBudget {
  /** Max concurrent agent sessions. Default: settings.maxConcurrentSubagents or 4. */
  maxConcurrentAgents: number;

  /** Max total agents spawned in this run. Default: 100. */
  maxTotalAgents: number;

  /** Max wall-clock runtime in ms. Default: no limit. */
  maxRuntime: number;

  /** Max retries per item (for schema validation failures). Default: 2. */
  maxRetriesPerItem: number;

  /** Max total tokens across all agents. Default: no limit. */
  maxTotalTokens?: number;

  /** Max total cost in USD. Default: no limit. */
  maxTotalCost?: number;
}

export interface AgentOptions {
  /** System-prompt role text. */
  role?: string;

  /** Exact model ID (provider/model). */
  model?: string;

  /** Thinking level. */
  thinking?: ThinkingLevel;

  /** Tool allowlist. Omit for all. */
  tools?: string[];

  /** Skill allowlist. Omit for all. */
  skills?: string[];

  /** Display label. */
  label?: string;

  /** JSON Schema for structured output. Enables validation + retry. */
  schema?: object;
}

export interface AgentResult<T = string> {
  /** Parsed output (object if schema provided, string otherwise). */
  output: T;

  /** Usage for this agent call. */
  usage: UsageSummary;

  /** Agent ID for debugging. */
  agentId: string;
}
```

### 4.4 `agent(task, options?)`

Spawns a single fresh-context worker. Returns when the worker completes.

```typescript
export async function agent<T = string>(
  task: string,
  options?: AgentOptions,
): Promise<AgentResult<T>>;
```

Behavior:

1. Acquire semaphore slot (respects `budget.maxConcurrentAgents`).
2. Check `budget.maxTotalAgents` — throw `BudgetExceededError` if reached.
3. Check journal cache — if hit and input+spec unchanged, return cached result.
4. Call `resolveSpec()` (shared with extension).
5. Create an in-memory `AgentSession` via Pi SDK `createAgentSession()`.
6. Prompt with `buildHarnessPrompt(task, false)`.
7. Extract final assistant text.
8. If `options.schema` provided, validate output against JSON Schema:
   - On validation failure, retry up to `budget.maxRetriesPerItem` times with a correction prompt.
   - On exhausted retries, throw `SchemaValidationError`.
9. Record result in journal.
10. Release semaphore.
11. Return `AgentResult`.

### 4.5 `parallel(thunks)`

Barrier-style concurrency. All thunks execute concurrently (bounded by semaphore); returns when all complete.

```typescript
export async function parallel<T>(
  thunks: Array<() => Promise<T>>,
): Promise<T[]>;
```

### 4.6 `pipeline(items, ...stages)`

Streaming/no-barrier. Each item flows through stages independently; item A can enter stage 2 while item B is still in stage 1.

```typescript
export async function pipeline<T>(
  items: T[],
  ...stages: Array<(item: T, index: number) => Promise<T>>
): Promise<T[]>;
```

Concurrency is bounded by the shared semaphore. Results are returned in original item order.

### 4.7 `phase(name)` and `log(message)`

Progress to stdout for the orchestrator model to observe.

```typescript
export function phase(name: string): void;
export function log(message: string): void;
```

Output format:

```
[phase] Discover routes
[log] Found 47 route files
[agent:routes-a1b2c3] ✓ 2.3s | ↑12.4k ↓3.1k | $0.004
[agent:routes-d4e5f6] ✓ 1.8s | ↑10.1k ↓2.8k | $0.003
```

### 4.8 Budget Types

```typescript
// workflow/budget.ts

export class BudgetTracker {
  constructor(budget: WorkflowBudget);

  /** Throws BudgetExceededError if any hard limit is reached. */
  checkBeforeSpawn(): void;

  /** Record completed agent usage. */
  recordUsage(usage: UsageSummary): void;

  /** Check runtime limit. */
  checkRuntime(): void;

  /** Current totals. */
  get totals(): BudgetTotals;
}

export interface BudgetTotals {
  agentsSpawned: number;
  totalTokens: number;
  totalCost: number;
  elapsedMs: number;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: keyof WorkflowBudget,
    public readonly current: number,
    public readonly max: number,
  );
}
```

### 4.9 Journal Types

```typescript
// workflow/journal.ts

export interface JournalConfig {
  /** Directory to persist journal files. Default: cwd/.pi-simple-subagents/journals/ */
  dir?: string;

  /** Enable journal persistence and resume. Default: true. */
  enabled?: boolean;
}

export interface JournalEntry {
  /** Deterministic cache key (see §5 below). */
  key: string;

  /** Normalized input that produced this entry. */
  input: JournalInput;

  /** Result, if completed successfully. */
  result?: AgentResult<unknown>;

  /** Timestamp of completion. */
  completedAt?: string;

  /** Status. */
  status: "completed" | "failed" | "running";
}

export interface JournalInput {
  task: string;
  spec: RuntimeSubagentSpec;
  /** Canonical JSON representation; absent when no schema was requested. */
  schema?: string;
}

export class Journal {
  constructor(config: JournalConfig);

  /** Load journal from disk. */
  async load(): Promise<void>;

  /** Look up a completed entry by key. Returns undefined on miss or invalidation. */
  get(key: string): JournalEntry | undefined;

  /** Record a result. Persists to disk. */
  async record(key: string, input: JournalInput, result: AgentResult<unknown>): Promise<void>;

  /** Invalidate entries whose input no longer matches. */
  invalidateStale(): number;
}
```

### 4.10 JSON Schema Validation

```typescript
// workflow/schema.ts

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  parsed?: unknown;
}

/**
 * Validate raw agent output text against a JSON Schema.
 * Attempts JSON.parse, then schema validation.
 */
export function validateOutput(raw: string, schema: object): ValidationResult;

/**
 * Determine whether to retry based on validation result and budget.
 */
export function shouldRetry(
  result: ValidationResult,
  attempt: number,
  maxRetries: number,
): boolean;

/**
 * Build a correction prompt for schema validation failures.
 */
export function buildCorrectionPrompt(errors: string[], schema: object): string;
```

---

## 5. Journal Key Derivation

The journal key uniquely identifies a unit of work for caching and invalidation. It is a deterministic hash of the **normalized input and spec**:

```typescript
function deriveJournalKey(input: JournalInput): string {
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
  if (spec === "all") return "all";
  return [...spec].sort();
}
```

**Cache hit:** key matches AND persisted `input.task` equals current task (exact string equality after trim) AND persisted `input.spec` deep-equals current spec AND persisted canonical `input.schema` equals the current canonical schema representation (including absence).

**Invalidation:** If any field of the spec or task changes, the key changes, and the old entry is stale. Downstream entries that consumed the stale entry's output are identified by the orchestration script's control flow (the script re-runs; changed upstream outputs naturally cause different downstream inputs).

---

## 6. Error Taxonomy

### Extension Tool Errors

| Code | Trigger | Has subagent_id? |
|------|---------|:---:|
| `MODEL_NOT_SCOPED` | `model` arg not in `get_scoped_models` results | No |
| `UNKNOWN_SUBAGENT_ID` | `message_subagent` with unregistered ID | Yes |
| `ABORTED` | User/signal abort during run | Yes |
| `SUBAGENT_FAILED` | Session creation or prompt execution throws | Yes |

### Workflow Library Errors

| Error class | Trigger |
|-------------|---------|
| `BudgetExceededError` | Any budget limit reached before spawn |
| `SchemaValidationError` | Output fails schema validation after all retries |
| `WorkflowAbortedError` | Runtime budget (maxRuntime) exceeded mid-run |
| `AgentFailedError` | Underlying session throws during prompt |

All workflow errors include `agentId` (if available), `task` (truncated), and `usage` consumed before failure.

---

## 7. Resolution Precedence (Complete)

### Model ID

| Priority | Source | Notes |
|:---:|--------|-------|
| 1 | `spawn_subagent.model` or `agent(task, {model})` | Must be exact scoped-model ID |
| 2 | `settings.simpleSubagents.defaultModel` | Must be valid provider/model |
| 3 | Parent session model ID | Always available |

### Thinking Level

| Priority | Source |
|:---:|--------|
| 1 | Spawn arg `thinking` |
| 2 | `settings.simpleSubagents.defaultThinking` |
| 3 | Parent session thinking level |

### Tools

| Priority | Source |
|:---:|--------|
| 1 | Spawn arg `tools` (explicit array or omitted=all) |

Self-tool exclusion is **always** applied regardless of selection.
Unknown tool names: warn (via `details.warnings`), omit from active set. Do not fail.

### Skills

| Priority | Source |
|:---:|--------|
| 1 | Spawn arg `skills` (explicit array or omitted=all) |

Unknown skill names: warn, omit. Do not fail.

---

## 8. Invariants

1. **No recursive spawning.** Self-tools (`spawn_subagent`, `message_subagent`, `get_scoped_models`) are always excluded from subagent tool surfaces.
2. **Model must be exact scoped-model ID.** Unqualified names, patterns, and aliases are rejected with `MODEL_NOT_SCOPED`.
3. **Unknown tools/skills warn, never fail.** The spawn proceeds with the valid subset.
4. **Every subagent is fresh-context.** No fork machinery exists.
5. **Registry persists the full resolved spec.** Continuations recreate sessions deterministically from the persisted spec, never re-resolving against current settings.
6. **Workflow workers are fresh-context only.** No session reuse within a workflow run (journal caching is a separate concern — it caches results, not sessions).

---

## 9. Settings

```typescript
// extension/settings.ts

export interface SimpleSubagentsSettings {
  /** Default model ID (provider/model). */
  defaultModel?: string;

  /** Default thinking level. */
  defaultThinking?: ThinkingLevel;

  /** Max concurrent subagent sessions (extension tool path). */
  maxConcurrentSubagents?: number;

  /** Soft timeout in minutes. Default: 30. */
  softTimeoutMinutes?: number;

  /** Hard timeout in minutes. Default: 45. */
  hardTimeoutMinutes?: number;

  /** Whether to summarize on hard timeout. Default: false. */
  summarizeOnTimeout?: boolean;

  /** Model for timeout summaries. Falls back to defaultModel. */
  timeoutSummaryModel?: string;
}
```

---

## 10. Skill Layout

```
skills/
└── subagent-workflows/
    ├── SKILL.md
    └── references/
        ├── spawn-spec.md
        ├── workflow-patterns.md
        ├── schema-budget-journal.md
        └── examples.md
```

### SKILL.md (entry point)

```markdown
---
name: subagent-workflows
description: >
  Spawn subagents and write workflow orchestration scripts for pi-simple-subagents.
  Use when delegating tasks to subagents, writing multi-agent fan-out scripts,
  or designing structured agent pipelines.
---

# Subagent Workflows

## Quick Reference

### Spawn a subagent (via tool)

Use `spawn_subagent` with a complete task description. Optionally provide:
- `role`: system-prompt instructions for the worker
- `tools`/`skills`: explicit allowlists (omit for all)
- `model`/`thinking`: override only when explicitly requested
- `label`: short identifier for progress display

### Continue a subagent

Use `message_subagent` with the returned `subagent_id`.

### Workflow scripts

For multi-agent orchestration (>3 workers, pipelines, structured output, verification):
write a TypeScript script to `/tmp` and execute via `bash`.

## When to Use What

| Scenario | Approach |
|----------|----------|
| 1-3 independent tasks | Direct `spawn_subagent` calls |
| Follow-up on prior work | `message_subagent` |
| Batch processing items | Workflow script with `pipeline()` |
| Parallel + synthesize | Workflow script with `parallel()` |
| Structured output needed | Workflow script with `schema` option |
| Adversarial verification | Workflow script: produce + refute stages |

## Detailed References

Load these as needed:

- [Spawn-spec authoring](references/spawn-spec.md) — task description checklist, role design, tool/skill selection guidance
- [Workflow patterns](references/workflow-patterns.md) — fan-out+synthesize, classify-and-route, adversarial verification, pipeline stages
- [Schema/budget/journal](references/schema-budget-journal.md) — JSON Schema for structured output, budget configuration, journal/resume semantics
- [Worked examples](references/examples.md) — batch TSV review, codebase audit, multi-perspective research
```

### Package exposure

Per Pi's packages/skills docs, the `skills/` directory is auto-discovered when the package manifest includes it or when using conventional directories. The `package.json` `pi.skills` entry ensures explicit registration:

```json
"pi": {
  "extensions": ["./extension/index.ts"],
  "skills": ["./skills"]
}
```

---

## 11. Test Plan

All tests use `node:test` (built-in, no dependencies). Tests cover pure logic only — no live Pi sessions.

### Test files

| File | Covers |
|------|--------|
| `test/spec.test.ts` | `resolveSpec()`: model precedence, thinking precedence, label derivation, system-prompt construction, tools/skills normalization, edge cases (empty role, all-whitespace label, undefined model) |
| `test/journal.test.ts` | `deriveJournalKey()`: determinism, ordering independence for tools/skills arrays, task trim normalization; `Journal.get()`: cache hit on matching input, cache miss on changed task, cache miss on changed spec field |
| `test/schema.test.ts` | `validateOutput()`: valid JSON + valid schema → pass; invalid JSON → fail with parse error; valid JSON + schema violation → fail with paths; `shouldRetry()`: returns true below max, false at max; `buildCorrectionPrompt()`: includes error details |
| `test/budget.test.ts` | `BudgetTracker`: throws on spawn when maxTotalAgents reached; throws when maxTotalTokens exceeded; accumulates correctly across multiple `recordUsage` calls; `checkRuntime()` throws when elapsed > maxRuntime |

### npm test

```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "unittest": "node --test test/*.test.ts",
  "test": "npm run typecheck && npm run unittest"
}
```

Node 22.19+ supports `--test` with TypeScript (via `--experimental-strip-types` or tsx). Use `--import tsx` if strip-types is insufficient for the TypeScript features used.

---

## 12. Staged Implementation Plan

### Stage 1: Core Refactor (Extension)

**Goal:** Extension compiles and functions with the new tool surface, spec resolution, registry, and plain-text output. No workflow library yet.

**Boundary:** `npm run typecheck` passes. Extension is manually testable in Pi.

**Tasks:**

1. Create `shared/types.ts`, `shared/spec.ts`, `shared/tools.ts`, `shared/models.ts`.
2. Implement `resolveSpec()`, `buildSystemPrompt()`, `buildHarnessPrompt()`, label derivation.
3. Implement tool/skill filtering in `shared/tools.ts` (extract from `run.ts`).
4. Rewrite `extension/registry.ts`: record type, persist full spec.
5. Rewrite `extension/settings.ts`: remove deleted settings, simplify.
6. Rewrite `extension/run.ts`:
   - Remove all persona/agents.ts imports and logic.
   - `executeSpawnSubagent`: accept new params schema, call `resolveSpec()`, pass to `createConfiguredSession()`.
   - `executeMessageSubagent`: load spec from registry record, pass directly to session creation.
   - `createConfiguredSession`: accept `RuntimeSubagentSpec` instead of `AgentDefinition`.
   - Output: plain text with id header instead of JSON.stringify.
7. Rewrite `extension/index.ts`:
   - Remove `list_subagents` tool registration.
   - Update `spawn_subagent` schema (new params).
   - Update TUI rendering for plain-text output parsing.
   - Remove persona discovery imports.
8. Delete `extension/agents.ts` and `agents/` directory.
9. Update `tsconfig.json` include paths.
10. Verify `npm run typecheck` passes.

### Stage 2: Workflow Library + Tests

**Goal:** Workflow library compiles, exports public API, and all unit tests pass.

**Boundary:** `npm test` passes (typecheck + unit tests).

**Tasks:**

1. Create `workflow/types.ts` with all public type definitions.
2. Implement `workflow/budget.ts` — `BudgetTracker` class.
3. Implement `workflow/journal.ts` — `Journal` class, `deriveJournalKey()`.
4. Implement `workflow/schema.ts` — `validateOutput()`, `shouldRetry()`, `buildCorrectionPrompt()`.
5. Implement `workflow/semaphore.ts` (re-export or shared instance).
6. Implement `workflow/agent.ts` — `agent()` function using Pi SDK.
7. Implement `workflow/parallel.ts` — `parallel()` barrier primitive.
8. Implement `workflow/pipeline.ts` — `pipeline()` streaming primitive.
9. Implement `workflow/progress.ts` — `phase()`, `log()`.
10. Implement `workflow/index.ts` — create runtime, export public API.
11. Add `exports` field to `package.json`.
12. Write all test files (`test/spec.test.ts`, `test/journal.test.ts`, `test/schema.test.ts`, `test/budget.test.ts`).
13. Add test script to `package.json`.
14. Verify `npm test` passes.

### Stage 3: Skill + Docs

**Goal:** Packaged skill is discoverable by Pi, README is accurate, package is publishable.

**Boundary:** `pi` loads the skill on startup (visible in skill list). README documents the full surface.

**Tasks:**

1. Create `skills/subagent-workflows/SKILL.md`.
2. Create `skills/subagent-workflows/references/spawn-spec.md` — task-spec checklist (Anthropic's 9-point list from researcher brief §8), role design patterns, tool/skill selection heuristics.
3. Create `skills/subagent-workflows/references/workflow-patterns.md` — fan-out+synthesize, adversarial verification, classify-and-route, pipeline stages, model routing.
4. Create `skills/subagent-workflows/references/schema-budget-journal.md` — schema authoring, budget tuning, journal behavior, resume semantics.
5. Create `skills/subagent-workflows/references/examples.md` — worked examples including batch-review-of-TSV-rows.
6. Update `package.json` `pi.skills` and `files` entries.
7. Rewrite `README.md` (installation, tool reference, settings, workflow usage).
8. Final verification: install package in Pi, confirm skill appears, confirm tools work.

---

## 13. Open Design Notes

### Per-ID concurrency on `message_subagent`

The full spec is persisted so the session file is the only contention point. Pi's `SessionManager.open()` behavior under concurrent writes is the remaining risk. Recommendation: document that parallel messages to the same ID are unsupported (undefined behavior). If needed later, add a per-ID mutex in the registry.

### Extension self-exclusion in workflow library

Workflow scripts run in a child process and create sessions via the SDK directly. They do not load Pi extensions at all (using `DefaultResourceLoader` without additional extension paths, or a minimal resource loader). The self-tool exclusion is handled by the workflow library simply never registering subagent tools on worker sessions.

### Workflow script execution environment

Scripts are TypeScript files executed via `npx tsx /tmp/workflow-xxx.ts` (or `node --import tsx`). They import from `pi-simple-subagents/workflow` which resolves via the installed package. The workflow library initializes its own `ModelRuntime` and `SettingsManager` instances to create sessions. The orchestrator model must ensure the package is importable (it is installed as a Pi package, so its path is known).

### Token/cost budget accuracy

Pi's `UsageSummary` on `AssistantMessage` provides per-turn token counts and cost. The workflow library accumulates these across all agents. Accuracy depends on the model provider reporting usage correctly. The budget is best-effort; a single agent turn may exceed the remaining budget before the check fires.
