# pi-simple-subagents

Lightweight synchronous subagents for Pi.

This package adds four tools:

- `list_subagents` shows available subagent types.
- `get_scoped_models` lists allowed model overrides from Pi's `enabledModels` scope.
- `spawn_subagent` starts a persistent Pi session and accepts an optional `model` override.
- `message_subagent` sends a follow-up prompt to a spawned subagent.

## Install

```bash
pi install git:github.com/JosiahEverson/pi-simple-subagents
```

For local development:

```bash
pi install /path/to/pi-simple-subagents
```

After installing or editing the package, run `/reload` in Pi.

## Agent Definitions

The package ships only the minimal `general` agent in its `agents/` directory.
Add personal agents in `~/.pi/agent/agents/*.md`. A personal agent with the same
`name` as a built-in overrides it.

Project-local `.pi/agents` files are deliberately ignored.

Example:

```markdown
---
name: specialist
description: Personal subagent for a focused task.
model: provider/model
thinking: medium
tools: [read, bash]
skills: []
context: fresh
---
System prompt body...
```

`tools` and `skills` accept a YAML list, a comma-separated string, or `all`.
Omitting `tools` or `skills` means `all`.

## Model Overrides

Only pass `spawn_subagent.model` when the user requests an override. Call
`get_scoped_models` first and use an exact returned `provider/model` value.
The tool resolves Pi's `enabledModels`; when unset or empty, it returns all
authenticated models.

## Settings

All settings are optional under `simpleSubagents` in `~/.pi/agent/settings.json`:

```jsonc
{
  "simpleSubagents": {
    "defaultModel": "provider/model",
    "defaultSubagentTypeId": "general",
    "defaultThinking": "medium",
    "builtinSubagentOverrides": {
      "general": { "model": "provider/model", "thinking": "medium" }
    },
    "summarizeOnTimeout": false,
    "timeoutSummaryModel": "provider/model",
    "softTimeoutMinutes": 30,
    "hardTimeoutMinutes": 45,
    "maxConcurrentSubagents": 4
  }
}
```

## Notes

Subagent sessions are real Pi sessions and remain resumable. They use a
synthetic cwd below the current project so they do not clutter the default
project session list, but they are visible in the all-sessions view.

Personal agent definitions can select tools supplied by other installed
extensions.
