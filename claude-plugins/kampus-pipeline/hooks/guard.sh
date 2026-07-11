#!/usr/bin/env bash
# Fail-open dispatch wrapper for the guard hooks.
#
# Usage: guard.sh <tool> [mode...]   e.g. guard.sh worktree-guard pre-file
#                                         guard.sh worktree-guard pre-bash
#                                         guard.sh spawn-guard guard
#                                         guard.sh spawn-guard freshness
#
# Resolves the SessionStart-installed pipeline-cli from the pipeline data dir
# (via resolve-data-dir.sh — the same resolver install.sh uses, robust to verbatim
# settings.json `env` values; see that file / #2495) and dispatches
# `pipeline-cli <tool> [mode...]`, forwarding the hook's stdin.
#
# #1050 FAIL-OPEN INVARIANT (HARD): when the CLI is absent — not yet installed,
# a degraded/offline install, or a worktree-creation hook firing with a stripped
# PATH before SessionStart completes — this MUST no-op (consume stdin, exit 0),
# never abort the hook/spawn. A PreToolUse hook that exits 0 with no stdout is an
# implicit allow, so a fail-open is a transparent no-op. This is the only thing
# standing between a not-yet-installed CLI and an all-lanes spawn abort
# (#787/#788/#789 incident class via the shared .git/hooks).

set -u

. "$(dirname "${BASH_SOURCE[0]}")/resolve-data-dir.sh"
DATA="$(resolve_pipeline_data_dir || true)"
BIN="${DATA:+$DATA/node_modules/.bin/pipeline-cli}"

# FAIL-OPEN: CLI not resolvable -> drain stdin and no-op (exit 0). Never crash.
if [ -z "$DATA" ] || [ ! -x "$BIN" ]; then
	cat >/dev/null 2>&1 || true
	exit 0
fi

# CLI present: dispatch. exec replaces this shell so the CLI owns stdin/stdout
# and its exit code (a real guard verdict — block/allow) is the hook's verdict.
exec "$BIN" "$@"
