# @kampus/worktree-guard

The harness slice that keeps an **`isolation:worktree` subagent** pinned to its
worktree and reaps that worktree clean when the agent exits (issue #741). It
kills the single largest mined subagent error class (~205 errors) and reclaims
~26GB of leaked disk.

The hazard it closes is documented across the repo: a worktree subagent's Bash
cwd **resets to the MAIN checkout** between calls, so a relative path — or an
absolute path written against the main checkout — silently targets the primary
tree and mis-edits or mis-branches it. And a finished subagent's worktree is
never cleaned up, so disk leaks. This package makes both mechanical, in the
`epic-ledger` / `leak-guard` idiom (CLAUDE.md: a pure, unit-tested core + a thin
Effect bin under `packages/` — **never a `.py` hook**).

## Shape

Four pure, IO-free cores + one Effect bin wiring them to the Claude Code hook
envelopes:

- **`src/path-resolve.ts`** — `resolvePath(...)` decides how a `Read`/`Edit`/
  `Write` `file_path` should resolve for a worktree agent: a **relative** path is
  rewritten against `$WORKTREE_ROOT` (the cwd-reset fix); an absolute
  **main-checkout** path with an identically-named worktree copy is **rewritten**
  to that copy; one with no copy is **blocked** with the corrected worktree path.
  The main-checkout prefix is derived from `$WORKTREE_ROOT` alone (an agent
  worktree lives at `<main>/.claude/worktrees/<id>`).
- **`src/bash-pin.ts`** — `pinBash(...)` prepends `cd "$WORKTREE_ROOT" &&` to a
  `Bash` command that has no leading `cd`, pinning it to the worktree.
- **`src/enter-guard.ts`** — `guardEnterWorktree(...)` hard-blocks `EnterWorktree`
  when `$WORKTREE_ROOT` is already set (refuse to nest a worktree in a worktree).
- **`src/reap.ts`** — `decideReap(...)` maps a finished worktree's clean/dirty
  status to **reap** (clean) or **refuse-and-keep** (dirty). The load-bearing
  safety rule (MEMORY "Safe worktree prune"): a dirty/unpushed tree is **never**
  force-removed. The bin runs `git worktree remove` **without `--force`**, so even
  a misclassification can never discard unpushed work — git itself refuses a dirty
  remove, and we never escalate to `--force`.
- **`src/bin.ts`** — the `effect/unstable/cli` bin. Each subcommand reads the
  hook's stdin JSON, runs a core, and emits the matching hook output. All read
  `$WORKTREE_ROOT` from the process env (injected at spawn); an **unset** root
  makes every subcommand a clean allow/skip no-op, so a non-worktree session is
  untouched.

## The fail-open / fail-safe stance

- **Not a managed worktree agent** (`$WORKTREE_ROOT` unset, or a bespoke dir not
  under `.claude/worktrees/`) → every hook is a **no-op** (`allow` / `skip`). The
  guard never invents a target.
- **The reaper fails SAFE toward keeping work**: if it can't determine clean/dirty
  status it treats the tree as dirty (keep); the `git worktree remove` runs
  without `--force`, so a dirty tree errors and is KEPT.

## Hook wiring (`.claude/settings.json`)

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Read|Edit|Write",
				"hooks": [{"type": "command", "command": "node $CLAUDE_PROJECT_DIR/packages/worktree-guard/src/bin.ts pre-file"}]
			},
			{
				"matcher": "Bash",
				"hooks": [{"type": "command", "command": "node $CLAUDE_PROJECT_DIR/packages/worktree-guard/src/bin.ts pre-bash"}]
			},
			{
				"matcher": "EnterWorktree",
				"hooks": [{"type": "command", "command": "node $CLAUDE_PROJECT_DIR/packages/worktree-guard/src/bin.ts pre-enter"}]
			}
		],
		"SubagentStop": [
			{
				"matcher": "*",
				"hooks": [{"type": "command", "command": "node $CLAUDE_PROJECT_DIR/packages/worktree-guard/src/bin.ts reap"}]
			}
		]
	}
}
```

`$WORKTREE_ROOT` is injected into an `isolation:worktree` subagent's environment
at spawn (the orchestrator that dispatches the worktree agent sets it to the
worktree's absolute path); the hooks read it from their own process env.

## Commands

```bash
pnpm --filter @kampus/worktree-guard typecheck
pnpm --filter @kampus/worktree-guard test
# exercise a subcommand directly (reads the hook envelope on stdin):
echo '{"tool_name":"Edit","cwd":"/main","tool_input":{"file_path":"src/x.ts"}}' \
  | WORKTREE_ROOT=/main/.claude/worktrees/wf_x node packages/worktree-guard/src/bin.ts pre-file
```
