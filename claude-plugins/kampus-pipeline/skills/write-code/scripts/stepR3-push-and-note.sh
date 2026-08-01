#!/usr/bin/env bash
# Step R3: re-assert the claim, force-with-lease the rebased head through `verified-push`, and post
# the format-3 repair note.
#
# usage: stepR3-push-and-note.sh <PR> <N>
#
# WRITE "$RUN_SCRATCH/repair-progress.md" BEFORE running this; the script names that path on stderr.
# Its answer is its EXIT STATUS — nothing lands on stdout, so non-zero ⇒ the push was NOT confirmed
# on the remote and/or no note was posted. Do not report the resubmit as landed on a non-zero.
#
# Executed, never sourced (ADR 0232). `claim_is_mine` / `wt_preflight` used to be functions in the
# sourcing shell and `$WT` a variable it left there; both are now child scripts, and the push is
# addressed at the worktree root the preflight prints.
#
# The hand-rolled $RUN_SCRATCH derivation duplicates `kp_scratch_path`; collapsing it onto that helper
# is phase 2's call (#1929).
# shellcheck disable=SC1007,SC1091,SC2015,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "write-code Step R3: could not resolve this script's own directory — NOTHING was pushed." >&2; exit 1; }

PR="${1:-}"
N="${2:-}"
if [ -z "$PR" ] || [ -z "$N" ]; then
	printf 'write-code Step R3: need the PR and its linked issue — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR3-push-and-note.sh <PR> <N>`. NOTHING was pushed.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step R3: target repo unresolved — NOTHING was pushed." >&2; exit 1; }
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127
# re-assert the mis-attribution guard (Step 3.5) before the resubmit push — a between-calls cwd
# reset can't move the claim, but the guard is MANDATED before every number-targeting mutation,
# exactly as the worktree preflight is before every git op; gate both the push and the progress comment.
bash "$HERE/step3_5-claim-is-mine.sh" "$N" >&2 \
	|| { echo "refusing to push/comment — PR #$PR linked issue #$N not my claim (Step 3.5)" >&2; exit 1; }
WT="$(bash "$HERE/step4-wt-preflight.sh")" || { echo "write-code Step R3: the worktree preflight refused — NOTHING was pushed." >&2; exit 1; }
# The SANCTIONED push path ([Pushing: the verdict is the ref, not the exit code]) — force-with-lease
# because the R2 rebase onto origin/main moved the head. It confirms the remote ref carries the
# rebased head before you claim the resubmit landed; exit 0 = MOVED, 1 = NOT-MOVED, 3 = UNKNOWN.
# STOP on either non-zero: a reviewer waiting on a moved head would otherwise re-gate the STALE one.
"$PCLI" verified-push --cwd "$WT" --remote origin --force-with-lease >&2 \
	|| { echo "write-code: the repair push was NOT confirmed on the remote (see the PUSH-VERDICT line above) — the gate would re-run against the STALE head. Do not report the resubmit as landed." >&2; exit 1; }
# compose the repair note under the §SP per-run scratch namespace, never a fixed /tmp leaf:
# concurrent repair lanes clobber a shared name and this posts THEIR note onto your issue (#3718).
# Session-keyed and deterministic, so the note you wrote in an earlier Bash call is still here.
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code: §SP session id unset — refusing to compose a repair note through a shared path (#3718)." >&2
	exit 1
fi
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-$N"
mkdir -p "$RUN_SCRATCH" || { echo "write-code: §SP could not create a per-run scratch dir (#3718)." >&2; exit 1; }
echo "write-code Step R3: §SP repair note is $RUN_SCRATCH/repair-progress.md" >&2
# …the format-3 repair note must already be at "$RUN_SCRATCH/repair-progress.md":
[ -s "$RUN_SCRATCH/repair-progress.md" ] || { echo "write-code: repair-progress.md is missing/empty — refusing to post an empty comment." >&2; exit 1; }
gh api repos/$REPO/issues/$N/comments -f body="$(cat "$RUN_SCRATCH/repair-progress.md")" >&2
