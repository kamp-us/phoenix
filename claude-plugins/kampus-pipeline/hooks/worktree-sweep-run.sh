#!/usr/bin/env bash
# The detached half of the SessionStart sweep (#4998). Runs the sweep entry unchanged —
# `guard.sh worktree-sweep --execute`, same classifier, still non-`--force` — and records
# where it got to, so a background run that fails or dies is reported at the next session
# start instead of vanishing.
#
# NEVER put this back on a hook chain directly: it is the long-running half, and inlining it
# is exactly the blocking cost #4998 removed. worktree-sweep-detach.sh is the hook entry.
set -uo pipefail

HOOKS_DIR="$(dirname "${BASH_SOURCE[0]}")"
. "$HOOKS_DIR/resolve-data-dir.sh"

DATA="$(resolve_pipeline_data_dir || true)"
if [ -z "$DATA" ] || [ ! -d "$DATA" ]; then
	exit 0
fi

LOG="$DATA/worktree-sweep.log"
FAILED_LOG="$DATA/worktree-sweep.failed.log"
STATUS="$DATA/worktree-sweep.status"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STARTED="$(now)"
printf 'running %s\n' "$STARTED" >"$STATUS"

{
	printf '=== worktree-sweep --execute (detached, started %s) ===\n' "$STARTED"
	"$HOOKS_DIR/guard.sh" worktree-sweep --execute </dev/null
} >"$LOG" 2>&1
RC=$?

printf '=== exit %s at %s ===\n' "$RC" "$(now)" >>"$LOG"
printf 'exit %s %s\n' "$RC" "$(now)" >"$STATUS"

# The log is truncated per run, so a failure would be overwritten by the next session's run
# before anyone read it. Keep a copy of the one that matters.
if [ "$RC" -ne 0 ]; then
	cp "$LOG" "$FAILED_LOG" 2>/dev/null || true
fi

exit "$RC"
