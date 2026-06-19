# @kampus/spawn-guard

The observability + cost-control harness slice (issue #744, epic #737). Three
coordinated pieces that turn the silent fable-5 "tokens going brrrr" leak into a
gated, observable knob:

1. **`WORKFLOW_MODEL` pin** — an env var the spawn path honors so a workflow's
   subagents run a deterministic model instead of whatever default a session
   inherits. The `guard` command reads it and rewrites an absent/disallowed spawn
   model to the pin.
2. **Per-session cost statusline** — `node src/bin.ts statusline` renders the
   running per-session cost/token figure so an operator sees spend live.
3. **Spawn-model allowlist guard** — `node src/bin.ts guard`, a `PreToolUse` hook on
   `Task`/`Workflow` that refuses to dispatch a subagent on a model outside the
   allowlist, **failing closed** (ADR 0092): an off-allowlist *or unset* model is a
   `deny`, never a silent allow, and every decision emits *what it checked*.

The allowlist is the **Opus 4.8 family** (`claude-opus-4-8`, `claude-opus-4-8[1m]`)
per the claude-api skill's "ALWAYS use `claude-opus-4-8`" rule. fable-5 / sonnet /
haiku / older opus are deliberately off the list.

## Layout

- `src/spawn-guard.ts` — the pure, IO-free cores: `decideSpawn` (allow / rewrite /
  deny), `isOnAllowlist`, `formatSessionCost`. Unit-tested in
  `src/spawn-guard.unit.test.ts`.
- `src/bin.ts` — the Effect CLI that wires the cores to the Claude Code `PreToolUse`
  and `statusLine` stdin/stdout envelopes. Exercised in `src/bin.envelope.test.ts`.

## Wiring (`.claude/settings.json`)

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "node packages/spawn-guard/src/bin.ts statusline"
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Task|Workflow",
        "hooks": [
          {"type": "command", "command": "node packages/spawn-guard/src/bin.ts guard"}
        ]
      }
    ]
  }
}
```

Set `WORKFLOW_MODEL=claude-opus-4-8` (or `claude-opus-4-8[1m]`) in the orchestrator's
environment to pin spawned subagents.

## Commands

```bash
pnpm --filter @kampus/spawn-guard test       # vitest
pnpm --filter @kampus/spawn-guard typecheck
echo '{"tool_input":{"model":"claude-fable-5"}}' | node packages/spawn-guard/src/bin.ts guard
echo '{"cost":{"total_cost_usd":0.42,"total_tokens":31000}}' | node packages/spawn-guard/src/bin.ts statusline
```
