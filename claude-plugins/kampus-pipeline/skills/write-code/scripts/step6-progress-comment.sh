#!/usr/bin/env bash
# Step 6: post the four-section progress comment, composed under the §SP per-run scratch namespace.
#
# usage: step6-progress-comment.sh <N>
#
# WRITE "$RUN_SCRATCH/progress.md" BEFORE running this — the path is deterministic and session-keyed,
# so it re-derives identically here even though you composed it in an earlier Bash call; the script
# names that path on stderr so a run that has not composed it yet is told where to put it. This
# script's answer is its EXIT STATUS — nothing lands on stdout, so non-zero ⇒ NO comment was posted.
#
# Executed, never sourced (ADR 0232). `claim_is_mine` used to be a function in the sourcing shell; it
# is now step3_5-claim-is-mine.sh, executed as a child, and its EXIT STATUS still gates the post.
#
# The hand-rolled $RUN_SCRATCH derivation duplicates `kp_scratch_path`; collapsing it onto that helper
# is phase 2's call (#1929), not this conversion's.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$HERE" ] || { echo "write-code Step 6: could not resolve this script's own directory — NO comment was posted." >&2; exit 1; }

# Fail closed on an absent number — an empty one both addresses `repos/$REPO/issues//comments` and
# collapses the per-issue scratch leaf, so a concurrent lane's note could be posted from this one.
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 6: no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step6-progress-comment.sh <N>`. NO comment was posted.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || { echo "write-code Step 6: target repo unresolved — NO comment was posted." >&2; exit 1; }
# §SP: the per-run scratch namespace — deterministic + fail-closed, never a shared fallback.
# Keyed on the session id, so if you compose progress.md in one Bash call and post it in the
# next, this same line re-derives the SAME directory (a bare `mktemp -d` would hand the second
# call a new EMPTY dir and post an empty body).
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code: §SP session id unset — refusing to compose a comment through a shared path (#3718)." >&2
	exit 1
fi
RUN_SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-$N"
mkdir -p "$RUN_SCRATCH" || {
	echo "write-code: §SP could not create a per-run scratch dir — refusing to compose a comment through a shared path (#3718)." >&2; exit 1; }
echo "write-code Step 6: §SP progress file is $RUN_SCRATCH/progress.md" >&2
# …the four-section comment must already be at "$RUN_SCRATCH/progress.md":
[ -s "$RUN_SCRATCH/progress.md" ] || { echo "write-code: progress.md is missing/empty — refusing to post an empty comment." >&2; exit 1; }
BODY="$(cat "$RUN_SCRATCH/progress.md")"   # the four-section comment
# gate the comment on the mis-attribution guard (Step 3.5) — only comment on an issue whose claim is mine
bash "$HERE/step3_5-claim-is-mine.sh" "$N" >&2 && gh api repos/$REPO/issues/$N/comments -f body="$BODY" >&2
