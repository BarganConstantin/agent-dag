# agent-dag

Live DAG of Claude Code agents. Watch parallel subagents fork, call tools, and return — all on one calm canvas.

## Run

```bash
npx agent-dag
```

Opens http://127.0.0.1:4317 (or a random port in 4318–4400 if 4317 is taken). Start a Claude Code session in any directory and watch the graph fill in.

## Options

```
-p, --port <number>      Preferred port (default: 4317; falls back to random 4318–4400)
    --no-open            Don't open the browser automatically
    --workspace <path>   Workspace root to filter events (default: cwd)
    --all                Capture sessions from all workspaces (machine-wide)
    --history <path>     Override events log file (default: ~/.claude/ccgraph/events.jsonl)
    --no-persist         RAM-only mode, no log file
    --uninstall          Remove agent-dag hooks from ~/.claude/settings.json
-h, --help               Show help
```

## Design

- One canvas. No tabs. No kanban.
- Node = agent (root session, subagent).
- Edge = parent → child (spawn) or agent → tool (call).
- In-flight edges animate; settled edges fade.
- Click a node for details.

## How it works

`agent-dag` registers a hook script in `~/.claude/settings.json` for these Claude Code events:

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Notification`.

The hook forwards the event JSON to the running server, which streams it to the browser via SSE.

## Uninstall

```bash
npx agent-dag --uninstall
```

Removes all hooks from `~/.claude/settings.json`.

## Status

Pre-alpha. Names, ports, and event shapes may change.
