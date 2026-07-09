# simple subagents — Design Specification

An extremely lightweight subagent extension for [pi](https://github.com/badlogic/pi-mono).
Repository: `github.com/JosiahEverson/pi-simple-subagents` · License: **0BSD**

## Overview

Simple subagents lets the main agent delegate work to specialized subagents via
**synchronous tool calls**. Each subagent is a real pi agent session:

- Runs **in-process** via the pi SDK (`createAgentSession()`), not a subprocess.
- Its session is stored as a **real pi session** — it can be opened/resumed
  like any session and **never expires**. Subagent sessions use a synthetic
  cwd so they are hidden from the project session list but visible in the
  all-sessions view (TAB in `/resume`).
- The main agent can send **follow-up prompts** to a completed subagent by id,
  exactly like a user messaging the main agent.
- Subagents are **batched** naturally through pi's parallel tool execution,
  bounded by a configurable concurrency limit (semaphore; excess calls queue).
- Subagents have a **soft timeout** (steer a "wrap up" instruction) and a
  **hard timeout** (abort + model-generated summary returned in place of the
  subagent's response).

Runtime configuration lives in namespaced fields under `simpleSubagents` in
`~/.pi/agent/settings.json`. Personal agent definitions live in
`~/.pi/agent/agents/*.md`.

## Repository / Package Layout

```
pi-simple-subagents/
├── package.json          # pi package manifest
├── LICENSE               # 0BSD
├── README.md             # user-facing docs + install instructions
├── DESIGN.md             # this document
├── extension/
│   ├── index.ts          # entry point (exports default function)
│   ├── agents.ts         # agent type discovery + frontmatter parsing
│   ├── run.ts            # subagent session creation, timeouts, semaphore
│   └── registry.ts       # subagent_id → session-file mapping + persistence
└── agents/               # minimal built-in subagent shipped in the package
    └── general.md
```

`package.json`:

```json
{
  "name": "pi-simple-subagents",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "license": "0BSD",
  "pi": {
    "extensions": ["./extension/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

The built-in `general` agent `.md` file ships inside the package (`agents/`
directory, resolved relative to the extension module) — it is **not** copied
into `~/.pi/agent/agents`.

## Installation (as a user would)

```bash
pi install git:github.com/JosiahEverson/pi-simple-subagents
```

This adds the package to `packages` in `~/.pi/agent/settings.json` and clones
it under `~/.pi/agent/git/github.com/JosiahEverson/pi-simple-subagents`.
Versioning via git tags (`@v0.1.0` pins a ref).

## Tools

Four tools are registered. Descriptions stay terse; catalogs are exposed only
through `list_subagents` and `get_scoped_models`.

### `get_scoped_models`

Returns exact `provider/model` values allowed for spawn-time overrides. It
resolves Pi's `enabledModels` patterns; when no usable scope exists, it returns
all authenticated models.

Input: `{}`

### `spawn_subagent`

Creates a subagent session and sends the initial prompt. Returns when the
subagent finishes (synchronous).

Input:

```ts
{
  subagent_type?: string,  // optional; falls back to settings.defaultSubagentTypeId
  prompt: string,
  model?: string           // exact value from get_scoped_models
}
```

`model` has highest model-resolution precedence. Prompt metadata tells the main
agent to set it only at the user's request and to call `get_scoped_models`
first. Values outside the current scope are rejected.

Output:

```ts
{
  subagent_id: string,     // auto-generated, e.g. "general-a1b2c3"
  response?: string,
  error?: { code: string, message: string }
}
```

- `subagent_type` omitted **and** `defaultSubagentTypeId` unset → `MISSING_SUBAGENT_TYPE`.
- `subagent_type` set but not found → `UNKNOWN_SUBAGENT_TYPE` (the default is
  **not** used for unknown types — typos must not silently reroute).

### `message_subagent`

Sends a follow-up prompt to a previously spawned subagent. Resumes the stored
session (works even after a hard timeout, and after pi restarts). Returns when
the subagent finishes responding.

Input:

```ts
{
  subagent_id: string,
  prompt: string
}
```

Output:

```ts
{
  subagent_id: string,     // echoes input for batch correlation
  response?: string,
  error?: { code: string, message: string }
}
```

Unknown id → `UNKNOWN_SUBAGENT_ID`.

### `list_subagents`

Returns the catalog of available subagent **types only** (spawned-instance ids
are already visible in the transcript via prior tool results). Scans agent
directories **fresh on every call**, so mid-session edits to agent files apply
immediately.

Input: `{}`

Output (as text content): one entry per type with `name`, `description`,
`source` (`builtin` | `user`), resolved `model`/`thinking`, `tools` (resolved
from the subagent's filtered namespace, excluding all four tools from this
extension), `skills`, `context`.

### Error codes

| Code                    | Meaning                                                    |
|-------------------------|------------------------------------------------------------|
| `MISSING_SUBAGENT_TYPE` | `subagent_type` omitted and no `defaultSubagentTypeId` set |
| `UNKNOWN_SUBAGENT_TYPE` | Named type not found                                       |
| `UNKNOWN_SUBAGENT_ID`   | `message_subagent` id not in the registry                  |
| `MODEL_NOT_SCOPED`      | Spawn model was not returned by `get_scoped_models`        |
| `SUBAGENT_FAILED`       | Provider/runtime error inside the subagent run             |
| `ABORTED`               | User aborted (Esc) while the subagent was running          |

Hard timeout is **not** an error — see Timeouts.

## Subagent Types

### Discovery & precedence

| Source    | Location                                    |
|-----------|---------------------------------------------|
| Built-in  | `agents/*.md` inside the installed package  |
| User      | `~/.pi/agent/agents/*.md`                   |

- A user agent with the same `name` as a built-in **overrides** the built-in.
- **No project-local agents** (`.pi/agents` is not read) — repo-controlled
  prompts are deliberately out of scope for security.

### Definition format

Markdown files with YAML frontmatter. The body is the subagent's system prompt.

```markdown
---
name: specialist
description: Personal subagent for a focused task.
model: provider/model     # optional
thinking: medium          # optional
tools: [read, bash]       # list, comma string, or "all"
skills: []                # list, comma string, or "all"
context: fresh            # "fork" | "fresh" (default: fresh)
---
System prompt body…
```

Frontmatter fields:

- **`name`** (required) — the `subagent_type` id.
- **`description`** (required) — shown by `list_subagents`.
- **`model`**, **`thinking`** (optional) — see Model & Thinking Resolution.
- **`tools`** — a **uniform allowlist over the final tool namespace**: built-in
  tools and extension-registered tools alike (`web_search`, `mcp`, …).
  `all` (or omitted) = no filter. Unknown names → **warn and continue**
  (warning surfaced via notify + noted in tool result details); the spawn
  proceeds without that tool.
- **`skills`** — same semantics as `tools`, applied to skill names.
  `all` = every discovered skill.
- **`context`**:
  - `fresh` — subagent session starts empty.
  - `fork` — the main session's **current branch** is forked into the
    subagent session using `SessionManager.forkFrom()` (or equivalent
    branch-clone that preserves entry IDs and parent links, so compaction
    references like `firstKeptEntryId` remain valid). The fork includes all
    entries up to **but excluding** the assistant message that contains the
    `spawn_subagent` tool call. The prompt is then delivered into this
    forked session.

### System prompt semantics

The agent body **replaces pi's custom system prompt** (equivalent to
`--system-prompt`). Pi's prompt builder still assembles the surrounding
sections — available tools, tool guidelines, skills, AGENTS.md context files —
exactly as pi normally does. Tools and skills declared in frontmatter are
loaded through pi's standard machinery.

### Extensions inside subagents

Subagent sessions load **all user-scope extensions except simple-subagents
itself**. After `createAgentSession()`, the extension must call
`session.bindExtensions(extensionsResult)` to trigger the full extension
lifecycle (`session_start`, `resources_discover`, etc.) — without this, MCP
adapters and other lifecycle-dependent extensions will not initialize.

- Rationale: personal agents may depend on extension tools, and safety
  extensions should also protect subagent runs.
- Excluding simple-subagents means **no recursion**: subagents cannot spawn
  subagents. Predictable cost, no timeout pyramids.
- **Project-local extensions** (`.pi/extensions/`) are **excluded** from
  subagent sessions — only `~/.pi/agent/extensions/` and package extensions
  are loaded. This matches the security rationale for excluding project-local
  agent definitions.
- Extension hooks (e.g. `tool_result` truncation) remain active even for tools
  filtered out by the `tools:` allowlist.

### Built-in agent

| Agent     | Purpose                                        | context | tools |
|-----------|------------------------------------------------|---------|-------|
| `general` | No instructions beyond the main agent's prompt | fresh   | all   |

Specialized agents are personal configuration and belong in
`~/.pi/agent/agents/*.md`, not in the package.

## Execution Model

- Each subagent run is an in-process `createAgentSession()` with a persistent
  session file — a real pi session that can be opened/resumed and **never
  expires**.
- Subagent sessions are created with a **synthetic cwd** of
  `<realCwd>/.pi-simple-subagents`, using the main session's session dir
  (`ctx.sessionManager.getSessionDir()`). This means:
  - `SessionManager.list(realCwd)` **excludes** them (no clutter in the
    project session list or default `/resume` view).
  - `SessionManager.listAll()` **includes** them (visible when the user
    presses TAB to browse all sessions).
  - The session file path is stored **absolutely** in the registry, so
    lookups via `message_subagent` survive project directory renames.
- Subagent `cwd` (for tool execution) = main session `cwd` (the real one).
- `spawn_subagent` / `message_subagent` block until the run completes
  (synchronous tool calls).
- The main session's abort signal (`ctx.signal`, i.e. user pressing Esc)
  aborts in-flight subagent runs → `ABORTED`.

### `response`

The text content of the subagent's **final assistant message** for that run,
not the full transcript.

### subagent_id & persistence

- Format: `<type>-<shortHash>`, e.g. `general-a1b2c3` (6 hex chars, unique per
  main session).
- The `id → session file` mapping is **persisted into the main session** via
  `pi.appendEntry()` (custom entry type, e.g. `simple-subagents:spawn`).
- On `session_start` the registry is rebuilt by scanning session entries, so
  `message_subagent` works after the main session is resumed in a new process.
  Live `AgentSession` objects are not kept between calls; `message_subagent`
  reopens the subagent's session file on demand.

## Model & Thinking Resolution

Resolved independently for `model` and `thinking`, highest precedence first:

1. Spawn-time `model` override (model only).
2. `simpleSubagents.builtinSubagentOverrides[<name>]` — despite the field name
   (kept per original spec), applies to **any agent by name**, built-in or
   custom.
3. Agent frontmatter (`model:` / `thinking:`).
4. `simpleSubagents.defaultModel` / `simpleSubagents.defaultThinking`.
5. The main session's current model / thinking level.

## Timeouts

Both clocks are **per tool call** — each `spawn_subagent` **and** each
`message_subagent` gets fresh clocks. For queued (semaphore-blocked) calls,
clocks start **when execution starts**, not at call arrival.

### Soft timeout — default 30 min (`softTimeoutMinutes`)

The harness `steer()`s the subagent with a wrap-up instruction, approximately:

> Your time budget is nearly exhausted. Wrap up now. Finish only what is
> already in flight, then produce your final report. Explicitly tell the main
> agent what you were unable to finish and what remains to be done.

The run then continues until the subagent finishes or the hard timeout fires.

### Hard timeout — default 45 min (`hardTimeoutMinutes`)

1. The subagent run is aborted. The session file retains everything up to the
   abort.
2. If `summarizeOnTimeout` is `true`, a summarization model generates a
   summary of the subagent session (what was attempted, accomplished,
   unfinished, and any results produced). Model resolution:
   `timeoutSummaryModel` → `defaultModel` → the subagent's own resolved
   model. The summary is returned as `response`, prefixed with a marker:

   ```
   [hard timeout — session summarized] …
   ```

   No `error` field — the summary stands **in place of** the subagent's
   response.
3. If `summarizeOnTimeout` is `false` (the default), no model call is made.
   The response is a short static message indicating the timeout, directing
   the main agent to `message_subagent` if it wants to continue:

   ```
   [hard timeout — subagent aborted] Use message_subagent to resume.
   ```

4. The subagent remains **resumable**: `message_subagent` reopens the session
   with fresh clocks.

## Batching & Concurrency

- Batching = pi's native parallel tool execution: the main agent emits several
  `spawn_subagent` / `message_subagent` calls in one assistant message and
  they run concurrently.
- The extension enforces `maxConcurrentSubagents` (default **4**) with a
  semaphore. Excess calls **queue** for a slot — they never fail with a
  concurrency error.

## UI

One-line streaming progress per running subagent via the tool `onUpdate`
callback, rendered by pi's default renderers (no custom TUI components):

```
⏳ general-a1b2c3 · 4m12s · bash: npm test
```

Updated on subagent tool activity and elapsed time. Final result uses default
tool-result rendering. Usage stats (turns, tokens, cost) are included in the
tool result `details`.

## Settings Reference

`~/.pi/agent/settings.json`:

```jsonc
{
  "simpleSubagents": {
    "defaultModel": "provider/model",        // fallback model for all subagents
    "defaultSubagentTypeId": "general",      // used when subagent_type is omitted
    "defaultThinking": "medium",             // fallback thinking level
    "builtinSubagentOverrides": {            // per-agent-name overrides (any agent)
      "general": { "model": "…", "thinking": "…" }
    },
    "summarizeOnTimeout": false,             // opt-in; make a model call to summarize on hard timeout
    "timeoutSummaryModel": "provider/model", // summarizer model (only when summarizeOnTimeout is true)
    "softTimeoutMinutes": 30,                // default 30
    "hardTimeoutMinutes": 45,                // default 45
    "maxConcurrentSubagents": 4              // default 4; semaphore, queued
  }
}
```

All fields optional.

## Non-Goals

- Asynchronous / background subagents (all calls are synchronous).
- Recursion (subagents spawning subagents).
- Project-local (`.pi/agents`) agent definitions.
- Session expiry, cleanup, or garbage collection.
- Custom TUI renderers, workflow prompt presets, chain modes.

## Implementation Notes (SDK mapping)

- **Session creation:** `createAgentSession({ cwd: realCwd, sessionManager: SessionManager.create(syntheticCwd, sessionDir), … })`
  where `syntheticCwd` = `<realCwd>/.pi-simple-subagents` and `sessionDir` =
  `ctx.sessionManager.getSessionDir()`. The `DefaultResourceLoader` is
  configured with the real cwd, `systemPromptOverride` for the agent body,
  extension filtering (exclude this package and project-local extensions), and
  tool/skill activation per frontmatter (`setActiveTools` / skill path
  filtering). After creation, call
  `session.bindExtensions(extensionsResult)` to initialize extension
  lifecycle hooks (MCP adapters, etc.).
- **`context: fork`:** use `SessionManager.forkFrom()` (or equivalent
  ID-preserving branch export) to copy the main session's current branch into
  the subagent session file. The fork point is the last entry **before** the
  assistant message containing the `spawn_subagent` call, preserving entry IDs
  and compaction references.
- **Soft timeout:** `session.steer(text)` at `softTimeoutMinutes`.
- **Hard timeout:** `session.abort()` at `hardTimeoutMinutes`, then a direct
  model call over the session transcript for the summary.
- **Resume:** reopen with `SessionManager.open(sessionFile)` +
  `createAgentSession` + `session.bindExtensions(extensionsResult)` for
  `message_subagent`.
- **Registry persistence:** `pi.appendEntry("simple-subagents:spawn", { id, type, sessionFile })`;
  rebuild on `session_start` from `ctx.sessionManager.getEntries()`.
- **Abort propagation:** wire the tool `signal` (and `ctx.signal`) to abort
  the subagent session run.
- **Semaphore:** module-level async semaphore sized from settings, acquired
  around each run; timeout clocks start after acquisition.
