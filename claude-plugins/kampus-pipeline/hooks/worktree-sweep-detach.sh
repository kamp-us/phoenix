#!/usr/bin/env bash
# SessionStart entry for the orphaned-worktree sweep: DISPATCH ONLY, never the scan (#4998).
#
# The sweep used to sit on the SessionStart hook chain as `guard.sh worktree-sweep --execute`,
# so every launch and every resume blocked on a full dirty-check of every registered worktree
# — measured at 52-66s on a checkout with 255 of them, and the set only grows. Nothing at
# session start reads the sweep's result, so that wait bought nothing.
#
# Two redirections on the background child are load-bearing, not tidiness. Its stdin is
# /dev/null so it never competes for the hook payload this script drains. Its stdout/stderr go
# to a file so it does not inherit the hook's stdout pipe: a hook runner that reads that pipe
# to EOF would otherwise wait for the whole sweep anyway, and the fix would be undone with no
# visible symptom.
#
# #1050 FAIL-OPEN INVARIANT (HARD): every path here drains stdin and exits 0, so this entry can
# never abort a session start.
set -uo pipefail

HOOKS_DIR="$(dirname "${BASH_SOURCE[0]}")"
. "$HOOKS_DIR/resolve-data-dir.sh"

DATA="$(resolve_pipeline_data_dir || true)"

drain_and_exit() {
	cat >/dev/null 2>&1 || true
	exit 0
}

# No data dir means no installed CLI to run and nowhere to record the run — the same state
# guard.sh itself no-ops on. Refuse to dispatch, fail-open.
if [ -z "$DATA" ] || [ ! -d "$DATA" ]; then
	drain_and_exit
fi

LOG="$DATA/worktree-sweep.log"
FAILED_LOG="$DATA/worktree-sweep.failed.log"
STATUS="$DATA/worktree-sweep.status"

# Report the PREVIOUS run before starting a new one. A backgrounded guard that quietly stops
# running is worse than a slow one, and this is the one place its outcome reaches a human.
PREV="$(head -n 1 "$STATUS" 2>/dev/null)"
case "$PREV" in
'' | 'exit 0 '*) ;;
'running '*)
	echo "kampus-pipeline: the previous background worktree-sweep ($PREV) never recorded an exit — it was killed or is still running. Last output: $LOG." >&2
	;;
*)
	echo "kampus-pipeline: the previous background worktree-sweep FAILED ($PREV) — worktrees are not being reclaimed. Output kept at $FAILED_LOG." >&2
	;;
esac

nohup "$HOOKS_DIR/worktree-sweep-run.sh" >/dev/null 2>&1 </dev/null &

drain_and_exit
