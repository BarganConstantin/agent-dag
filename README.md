# ccgraph

Live DAG of Claude Code agents. Watch parallel subagents fork, call tools, and return — all on one calm canvas.

## Run

```bash
npx ccgraph
```

Opens http://127.0.0.1:4317. Start a Claude Code session in any directory and watch the graph fill in.

## Design

- One canvas. No tabs. No kanban.
- Node = agent (root session, subagent).
- Edge = parent → child (spawn) or agent → tool (call).
- In-flight edges animate; settled edges fade.
- Click a node for details.

## How it works

`ccgraph` registers a hook script in `~/.claude/settings.json` for these Claude Code events:

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Notification`.

The hook forwards the event JSON to the running `ccgraph` server, which streams it to the browser via SSE.

## Status

Pre-alpha. Names, ports, and event shapes may change.
