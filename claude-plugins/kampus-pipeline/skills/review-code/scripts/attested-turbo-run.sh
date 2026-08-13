#!/usr/bin/env bash
# Step 2 — run a turbo-cached task inside the review worktree and ATTEST that it really executed
# there, instead of consuming its exit status alone (#4887).
#
# turbo's cache key is repo-relative path -> git blob SHA plus a dependency hash; no absolute path
# and no checkout identity participate in it, and a linked worktree shares the primary checkout's
# cache directory ("using shared worktree cache" is turbo's own line for it). So an entry produced
# by a SIBLING tree at a DIFFERENT commit replays here in milliseconds and exits 0, and a gate that
# reads nothing but that exit status reports a check it never ran against a tree it never read.
#
# Two legs, both load-bearing:
#   --force      turbo ignores the cache for READS (2.10.3: equivalent to --cache=local:w,remote:w),
#                so every task in the run executes here. This PREVENTS the replay.
#   --summarize  turbo writes a machine-readable run summary whose per-task `cache.status` is MISS
#                (executed) or HIT (replayed). Re-reading it PROVES the prevention held, so the
#                signal stops being "exit 0" and becomes "turbo says these N tasks executed here".
# Forcing alone would put the gate back on exit-status-only consumption the day a flag is dropped;
# reading alone would only catch a replay after paying for it.
#
# Correct whatever #4106 concludes: this attests WHICH signal the gate consumed — a run of this head
# or a replay of another tree's — which is worth stating if every hit is sound and worth more if
# some hit is not.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/attested-turbo-run.sh <pr> <turbo-task> [extra turbo args…]
#
# stdout is the attestation line, and ONLY on the path where the task both ran and passed; every
# other outcome exits non-zero with empty stdout and the line on stderr (§ZS, ADR 0092;
# .patterns/skill-script-io-contract.md). The line names repo-relative turbo task ids only — never a
# machine-local path — so a reviewer pastes it verbatim into a public verdict.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: attested-turbo-run.sh <pr> <turbo-task> [extra turbo args…]" >&2; exit 2; }
PR="$1"
TASK="$2"
shift 2
# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HANDLE="$(bash "$HERE/head-env.sh" "$PR")" || exit 1
# shellcheck disable=SC1090
. "$HANDLE" || exit 1
: "${REVIEW_WT:?attested-turbo-run.sh: REVIEW_WT unset — the head was never materialized; refusing to run against the base tree (§HEAD)}"
kp_head_handle_names_pr "$PR" "$HANDLE" || exit 1   # never attest a SIBLING reviewer's tree (#5416)

RUNS_DIR="$REVIEW_WT/.turbo/runs"
# Which summaries existed BEFORE this invocation, so the one it writes is identified by set
# difference rather than by mtime. The sentinel keeps `grep -vxF` from matching every line when the
# directory is empty or absent.
BEFORE="$(ls -1 "$RUNS_DIR" 2>/dev/null)"
[ -n "$BEFORE" ] || BEFORE='attested-turbo-run.sh: no pre-existing summary'

if [ "$#" -gt 0 ]; then
	pnpm -C "$REVIEW_WT" "$TASK" --force --summarize "$@" >&2
else
	pnpm -C "$REVIEW_WT" "$TASK" --force --summarize >&2
fi
RUN_RC=$?

# shellcheck disable=SC2010  # this is a set difference over two `ls` listings, not name filtering; turbo names its summaries with its own alphanumeric run ids
NEW="$(ls -1 "$RUNS_DIR" 2>/dev/null | grep -vxF "$BEFORE")"
COUNT=0
[ -n "$NEW" ] && COUNT="$(printf '%s\n' "$NEW" | wc -l | tr -d ' ')"
[ "$COUNT" -eq 1 ] || {
	printf 'attested-turbo-run.sh: expected exactly 1 new turbo run summary under the review worktree, found %s — the run is UNATTESTABLE, which is UNKNOWN and never a pass (§ZS). The task itself exited %s.\n' "$COUNT" "$RUN_RC" >&2
	exit 1
}

# The judgement reads the summary's own `cache.status` field, never turbo's counts line ("Cached: 1
# cached, 31 total") — that line is display text.
ATTESTATION="$(node "$HERE/attest-turbo-summary.mjs" "$RUNS_DIR/$NEW" "$TASK")"
ATT_RC=$?

case "$ATT_RC" in
	0) ;;
	4)
		printf '%s\n' "$ATTESTATION" >&2
		printf 'attested-turbo-run.sh: BLOCKING — turbo REPLAYED cached results for the tasks listed above instead of executing them, so this run attests nothing about the head under review (#4887). Never read it as a pass.\n' >&2
		exit 1
		;;
	*)
		printf 'attested-turbo-run.sh: could not derive an attestation from the run summary (node exited %s) — UNKNOWN, never a pass (§ZS). The task itself exited %s.\n' "$ATT_RC" "$RUN_RC" >&2
		exit 1
		;;
esac

[ "$RUN_RC" -eq 0 ] || {
	printf '%s\n' "$ATTESTATION" >&2
	printf 'attested-turbo-run.sh: the task genuinely ran here and FAILED (exit %s) — a real red, not a cache artifact.\n' "$RUN_RC" >&2
	exit "$RUN_RC"
}

printf '%s\n' "$ATTESTATION"
