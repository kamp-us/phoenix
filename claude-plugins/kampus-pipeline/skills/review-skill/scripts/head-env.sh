#!/usr/bin/env bash
# Print the absolute path of the run-state handle `materialize-head.sh` wrote (REVIEW_WT / PR_REF /
# HEAD_SHA / BASE_REF), so any later step re-derives it with `. "$(head-env.sh "$PR")"` after the
# harness resets the shell between Bash calls. Extracted from review-skill/SKILL.md's repeated
# re-source line (#4453, epic #4435 phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# The namespace is per-run and per-session (§SP, #3718), which is what keeps a SIBLING reviewer's
# tree out of reach — the failure a `git worktree list` re-derivation on the shared
# `review-skill-head-${PR}` leaf walks straight into, pinning the wrong head's skill text (#1807).
# Exits non-zero with EMPTY stdout when the namespace was never opened, so a caller's `.` fails
# loudly instead of silently reading the base tree.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: head-env.sh <pr>" >&2; exit 2; }
PR="$1"

DIR="$(kp_scratch_path "review-skill-head-$PR")" || exit 1
[ -s "$DIR/wt.env" ] || {
  echo "review-skill: §SP — $DIR/wt.env missing; re-run the head-materialization step in THIS session. NEVER fall back to the launched checkout's working copy (§HEAD, #793)." >&2
  exit 1
}
printf '%s\n' "$DIR/wt.env"
