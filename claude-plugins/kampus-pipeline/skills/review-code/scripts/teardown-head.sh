#!/usr/bin/env bash
# Step 2 — tear the throwaway head worktree + per-run ref down. Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract:
# ../SKILL.md § The extracted scripts.
#
# It is its OWN script because the prose requires it on EVERY exit path (PASS, FAIL, mid-run error),
# not just after the lint/typecheck run it followed in the fence — a leaked `review-head-*` tree
# accumulates on the shared primary otherwise (#2785). Safe by construction: the tree it removes is
# a detached, already-pushed throwaway this gate materialized itself, holding no branch and no
# unpushed work. Idempotent — a namespace that was never opened is a clean no-op, so it may be run
# after an aborted materialization.
#
# usage: bash ./claude-plugins/kampus-pipeline/skills/review-code/scripts/teardown-head.sh <pr>
#
# It takes the PR so it can only ever delete ITS OWN. Under the session-only handle key, a reviewer
# finishing PR A `rm -rf`'d PR B's live worktree and dropped B's ref mid-run (#5416) — teardown is
# the one consumer whose mis-keying destroys another lane's work rather than merely mis-reading it.
#
# It exits 0 ONLY on a real teardown or a real no-op. A handle read that could not RUN is UNKNOWN and
# exits non-zero: this branch used to answer "nothing to tear down" for every failure, so the gate
# reported success on the exact path it leaked its worktree and ref (#4972 / #5193, class #4482).
# The no-op/error split is `head-env.sh`'s exit status — 5 and $KP_HEAD_HANDLE_ABSENT mean nothing
# was materialized, everything else means the resolver could not look (§ZS, ADR 0092).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: teardown-head.sh <pr>" >&2; exit 2; }
PR="$1"
# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# `bash "$HERE/head-env.sh"`, not a direct exec: the sibling is committed non-executable in two of the
# three gates, and a direct exec there dies 126 — a failure this script then reported as a clean no-op
# on every single run (#5193). Every other call site in the suite already invokes via `bash`.
# head-env.sh's stderr is deliberately NOT discarded: it names which cause fired (#4972).
HANDLE="$(bash "$HERE/head-env.sh" "$PR")"
RC=$?
case "$RC" in
  0) ;;
  5 | "$KP_HEAD_HANDLE_ABSENT")
    echo "teardown-head.sh: no head handle for this run (head-env.sh rc=$RC) — nothing this gate materialized to tear down (no-op)." >&2
    exit 0
    ;;
  *)
    echo "teardown-head.sh: could NOT read the head handle (head-env.sh rc=$RC) — that is UNKNOWN, not a no-op, and a materialized worktree/ref may be leaking on the shared primary. See head-env.sh's diagnostic above." >&2
    exit 1
    ;;
esac
# shellcheck disable=SC1090
. "$HANDLE" || {
  echo "teardown-head.sh: could NOT source the head handle $HANDLE — the tree it names is unreachable, not absent." >&2
  exit 1
}
[ -n "${REVIEW_WT:-}" ] && [ -n "${PR_REF:-}" ] || {
  echo "teardown-head.sh: handle $HANDLE carries no REVIEW_WT/PR_REF — refusing to guess a path to \`rm -rf\`, and refusing to call that success: a readable handle is evidence something WAS materialized and is now unreachable." >&2
  exit 1
}
# The last gate before an `rm -rf`: prove what is about to be deleted is PR $PR's, not a sibling
# reviewer's live tree. A mismatch is a refusal, never a no-op — something IS materialized, and this
# run is not the one allowed to remove it.
kp_head_handle_names_pr "$PR" "$HANDLE" || {
  echo "teardown-head.sh: refusing to tear down — the handle does not describe PR $PR. Nothing was removed, and a tree may still be live on the shared primary." >&2
  exit 1
}

rm -rf "$REVIEW_WT" && git worktree prune && git update-ref -d "$PR_REF"   # tear the throwaway tree + ref down
