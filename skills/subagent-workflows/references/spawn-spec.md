# Writing subagent task specs

A subagent starts with no memory of your conversation. Everything it needs must be in the spawn call. Vague delegation produces duplicated work and gaps; a few extra sentences in the task are cheaper than a retry.

## Task checklist

Include whichever of these the task's weight justifies:

1. **Objective** — the exact question or deliverable.
2. **Scope** — which files, directories, sources, or subsystems.
3. **Boundaries** — what NOT to touch or investigate.
4. **Distinct angle** — when running parallel workers, why this one isn't duplicating another.
5. **Tool strategy** — which tools to prefer; source-quality requirements for research.
6. **Output contract** — the exact reply format: summary shape, JSON structure, file paths to write.
7. **Success criteria** — how the worker knows it's done (tests pass, typecheck clean, N sources found).
8. **Effort budget** — expected depth: "quick scan" vs "exhaustive"; rough tool-call or time expectations.
9. **Handoff** — what to return in the reply vs write to files. For anything large: write files, reply with paths + a short summary.

A one-line task is fine for one-line work. Scale the spec with the stakes.

## Role vs task

- `role` becomes the worker's **system prompt**: durable behavioral identity — "You are a security reviewer. You report only exploitable findings, with evidence." Use it for how the worker should think, judge, and format across the whole session (including follow-ups via `message_subagent`, which reuse it).
- `task` is the **work item**: this file, this question, this diff.

Omit `role` for generic workers; a good task spec alone is usually enough for mechanical work.

## Routing model and thinking

Routing is your decision — make it deliberately per task:

- Match model capability to the task type (see any global routing guidance in AGENTS.md).
- Thinking: `low` for mechanical edits and extraction, `medium` for standard implementation and research, `high` for design, review, and adversarial judgment.
- Model must be an exact ID from `get_scoped_models`; omit both to inherit defaults.

## Narrowing tools and skills

Omit `tools` or `skills` to select all available resources of that kind. Narrow them when it sharpens behavior or reduces risk:

- Read-only analysis: `tools: ["read", "bash", "grep"]`.
- Pure reasoning over provided text: `tools: []`.
- Skills: pass an allowlist when only specific skills are relevant; irrelevant skills are noise in the worker's context.

Unknown names warn and are dropped — the spawn still proceeds. Normal global extensions are inherited automatically; copies of this package's own extension are excluded to prevent recursion. Tool selection uses the remaining effective names, including same-named tools from unrelated extensions. Extensions are not selectable per child.

## Follow-ups

`message_subagent` continues the same session with the same role, model, tools, and conversation. Use it to iterate on a worker's output instead of re-explaining context to a fresh spawn. Don't message the same id from parallel tool calls.
