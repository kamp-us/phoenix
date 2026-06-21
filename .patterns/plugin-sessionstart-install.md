# plugin SessionStart-install + fail-open guard dispatch

How the `kampus-pipeline` plugin acquires its runtime tooling once per consumer and wires its guard hooks through it. A `SessionStart` hook installs `@kampus/pipeline-cli` into `${CLAUDE_PLUGIN_DATA}` (version-aware, network-resilient); every guard hook dispatches through a wrapper that **fail-opens** when the CLI isn't there yet. This is the *shape* — the *why* (one published package, two install paths) is [ADR 0103](../.decisions/0103-consolidate-pipeline-cli-package.md); the fail-open requirement is the #777 stale-tree invariant tracked at #1050.

This pattern is what makes the pipeline **portable**: a foreign repo enables the plugin and gets the whole guard surface from npm, with no `node "$CLAUDE_PROJECT_DIR/packages/<guard>/src/bin.ts"` repo-path dependency.

## The two plugin variables

Grounded in the [plugins reference](https://code.claude.com/docs/en/plugins-reference) (§ Environment variables):

- **`${CLAUDE_PLUGIN_ROOT}`** — the plugin's installation dir (where the committed files live). **Ephemeral**: the path changes on every plugin update; never write state here. Scripts and config are read from here.
- **`${CLAUDE_PLUGIN_DATA}`** — a **persistent** dir (under Claude Code's per-plugin data root, `…/plugins/data/{id}/`) that survives plugin updates, created on first reference. The documented home for installed deps (`node_modules`), caches, generated code. The install target.

The split is the whole design: code is read from `${CLAUDE_PLUGIN_ROOT}` (versioned, replaced on update), dependencies are installed into `${CLAUDE_PLUGIN_DATA}` (persisted, reinstalled only on a manifest/version change).

## The flow

```
SessionStart (startup|resume)
  │
  ▼
hooks/install.sh                     reads pinned PIN, compares to ${CLAUDE_PLUGIN_DATA}/.pipeline-cli.version
  │   match  → no-op (exit 0)
  │   differ → npm install @kampus/pipeline-cli@PIN into ${CLAUDE_PLUGIN_DATA}/node_modules, write marker
  │   fail   → drop marker, log to stderr, exit 0  (session still starts)
  ▼
${CLAUDE_PLUGIN_DATA}/node_modules/.bin/pipeline-cli   (the installed CLI)
  ▲
  │  resolved by
  │
PreToolUse / SubagentStop / SessionStart guard hooks
  │   each runs:  hooks/guard.sh <tool> [mode...]
  ▼
hooks/guard.sh                       resolve the installed bin
      present → exec pipeline-cli <tool> [mode...]   (real guard verdict)
      absent  → drain stdin, exit 0                  (FAIL-OPEN no-op)
```

## Install — `hooks/install.sh` (version-aware, idempotent, resilient)

The data dir outlives any one plugin version, so *directory existence alone can't tell you the pinned version changed* — the reference docs' canonical caveat. So the script keeps a **version marker** (`${CLAUDE_PLUGIN_DATA}/.pipeline-cli.version`) and reinstalls only when the marker is missing, mismatched, or the bin has vanished.

- **One pin.** `PIN="0.1.0"` in the script is the single source of the installed version. Bumping it makes the *next* `SessionStart` reinstall — no other edit. (This stands in for the docs' "diff the bundled `package.json`": the version string *is* the manifest here.)
- **Idempotent.** When `[ -x bin ] && marker == PIN`, it's an immediate `exit 0` — no `npm` spawn, the installed bin untouched.
- **Network-resilient (load-bearing).** A SessionStart hook that crashes blocks the session. So **every** failure path — `CLAUDE_PLUGIN_DATA` unset, `mkdir` denied, registry unreachable, `npm install` non-zero — logs to **stderr** and `exit 0`. On a failed install the marker is **dropped** so the next session retries; the session itself always starts.

## Dispatch — `hooks/guard.sh` (the #1050 fail-open invariant)

Every guard hook in `hooks.json` invokes `guard.sh <tool> [mode...]` rather than the CLI directly. The wrapper resolves `${CLAUDE_PLUGIN_DATA}/node_modules/.bin/pipeline-cli` and:

- **CLI present** → `exec` it, forwarding the hook's stdin and *returning its exit code unchanged* — a real `block`/`allow` verdict is the hook's verdict.
- **CLI absent** (unset `CLAUDE_PLUGIN_DATA`, empty data dir, a degraded/offline install, or a hook firing with a stripped PATH **before** SessionStart-install completes) → **drain stdin and `exit 0`**. A PreToolUse hook that exits 0 with no stdout is an implicit *allow*, so a fail-open is a transparent no-op.

**Why this is non-negotiable (#1050 / #777):** a worktree-creation hook fires with a stripped PATH on a fresh/stale tree, possibly before any install ran. If that hook *crashed* instead of no-op'ing, it would abort the spawn for **all lanes** through the shared `.git/hooks` — the #787/#788/#789 incident class. The fail-open wrapper is the single thing standing between a not-yet-installed CLI and an all-lanes spawn abort. The resilience lives in the **wrapper**, not in each guard — the consolidated `pipeline-cli` dropped the old per-guard `bin.run.ts`/`preflight.ts` stale-tree shim precisely because the wrapper (CLI-absent → no-op) + the bundled-deps install (CLI-present → deps already resolved) replace it.

## hooks.json — matchers mirror `.claude/settings.json`

The plugin's `hooks.json` (registered via plugin.json's `"hooks": "./hooks.json"`) carries the same matcher→guard map as phoenix's `.claude/settings.json`, so enabling the plugin changes the *invocation path* (installed CLI) without changing *coverage*:

| Event | Matcher | Dispatch |
|---|---|---|
| SessionStart | `startup\|resume` | `install.sh`, then `guard.sh spawn-guard freshness` |
| PreToolUse | `Edit\|Write` | `guard.sh read-guard` |
| PreToolUse | `Read\|Edit\|Write` | `guard.sh worktree-guard pre-file` |
| PreToolUse | `Bash` | `guard.sh worktree-guard pre-bash` |
| PreToolUse | `EnterWorktree` | `guard.sh worktree-guard pre-enter` |
| PreToolUse | `Task\|Workflow` | `guard.sh spawn-guard guard` |
| SubagentStop | `*` | `guard.sh worktree-guard reap` |

The old standalone `freshness-bin.ts` is now `spawn-guard freshness` — one consolidated CLI, subcommand dispatch (ADR 0103).

## Why two shell scripts (not the node-bin idiom)

CLAUDE.md mandates Node over Python/ad-hoc shell for *mechanical tooling logic* — and that logic already lives in the Effect `pipeline-cli`. `install.sh` and `guard.sh` are thin **bootstrap glue**: their whole job is to *acquire and resolve* the node bin, so they can't themselves be that bin. The reference docs' own canonical SessionStart-install example is a shell one-liner for exactly this reason. They stay minimal (`set -u`, quoted vars, one `exec`) and carry no domain logic.
