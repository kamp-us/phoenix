# @kampus/read-guard

Auto-Read-on-edit `PreToolUse` hook. Kills the largest mined subagent error class
(~151: `File has not been read yet` 134× + `File has been modified since read` 17×;
epic #737, child #740).

Before an `Edit`/`Write`, the harness refuses the call when the target was never
`Read` this session, or was read but has since changed on disk — a wasted turn.
This package decides that condition mechanically and turns the raw refusal into a
precise, one-turn-resolvable instruction.

## Shape

- **`read-guard.ts`** — the pure, IO-free decision core. `decide(target, readSet,
  currentMtimeMs)` returns `inject-read` (never read, or read-then-changed) or
  `no-op` (a current read on record). Staleness is `currentMtime > latestReadAt`
  (strict; a re-read refreshes the recorded view). Unit-tested across the three AC
  cases in `read-guard.unit.test.ts`.
- **`transcript.ts`** — reconstructs the session read-set from the transcript
  JSONL (`parseReadSet`): every `Read` `tool_use` becomes `{path, readAtMs}`. Total
  and fail-open — malformed lines are skipped, never thrown.
- **`bin.ts`** — the `PreToolUse` hook. Reads the envelope from stdin, builds the
  read-set, stats the target, asks the core, and emits the hook decision.

## Block, not inject — and why

The documented Claude Code `PreToolUse` hook surface
([docs.claude.com/en/docs/claude-code/hooks](https://docs.claude.com/en/docs/claude-code/hooks);
plugin-dev hook-development) can `allow`/`deny`/`ask` and rewrite `updatedInput` —
it has **no** documented way to *inject* a separate `Read` tool call ahead of the
edit. So this hook takes the deterministic **block-with-exact-instruction** form the
issue calls for: on `inject-read` it emits `permissionDecision: deny` with a
`Read <abs-path> first — …` `systemMessage` the agent resolves in one turn (re-Read
the named path, retry the edit), replacing the harness's opaque refusal with an
actionable one. If a future hook API exposes tool-call injection, only `bin.ts`
changes — the core already names the case `inject-read`.

## Fail-open

A turn-saver, not a gate: any malformed envelope, unreadable transcript, or
unexpected error → `permissionDecision: allow` (exit 0). A hook crash must never
wedge an edit.

## Wiring

Wired at `PreToolUse` for `Edit|Write` in `.claude/settings.json`:

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Edit|Write",
				"hooks": [{"type": "command", "command": "node $CLAUDE_PROJECT_DIR/packages/read-guard/src/bin.ts"}]
			}
		]
	}
}
```

## Run

```bash
pnpm --filter @kampus/read-guard test       # unit + end-to-end
pnpm --filter @kampus/read-guard typecheck
echo '{"tool_name":"Edit","tool_input":{"file_path":"/abs/x.ts"},"transcript_path":"/abs/t.jsonl"}' \
  | node packages/read-guard/src/bin.ts      # prints the hook decision JSON
```
