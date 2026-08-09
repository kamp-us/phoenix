#!/usr/bin/env bash
# Step 2 — tear the throwaway head worktree + per-run ref down. Extracted from review-doc/SKILL.md
# (#4453, epic #4435 phase 1). Extraction contract: ../SKILL.md § The extracted scripts.
#
# It is its OWN script because the prose requires it on EVERY exit path (PASS, FAIL, mid-run error),
# not just after a clean read — a leaked `review-doc-head-*` tree accumulates on the shared primary
# otherwise (#2785). Safe by construction: what it removes is a detached, already-pushed throwaway
# this gate materialized itself, holding no branch and no unpushed work. Idempotent — a namespace
# that was never opened is a clean no-op, so it may be run after an aborted materialization.
#
# It exits 0 ONLY on a real teardown or a real no-op. A handle read that could not RUN is UNKNOWN and
# exits non-zero: this branch used to answer "nothing to tear down" for every failure, so the gate
# reported success on the exact path it leaked its worktree and ref (#5193 / #4972, class #4482).
# The no-op/error split is `head-env.sh`'s exit status — 5 and $KP_HEAD_HANDLE_ABSENT mean nothing
# was materialized, everything else means the resolver could not look (§ZS, ADR 0092).
#
# It installs no `EXIT` trap of its own: under bash 3.2 a cleanup trap's last command becomes the
# script's exit status, laundering a `set -u` abort into exit 0 (#4476, class #4479). The trap
# belongs to the CALLER's shell — `trap '…/scripts/teardown-head.sh "$PR"' EXIT`.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: teardown-head.sh <pr>" >&2; exit 2; }
PR="$1"

# shellcheck disable=SC1007
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# `bash "$HERE/head-env.sh"`, not a direct exec: every file in this scripts/ dir is committed
# non-executable, so the direct exec died 126 on EVERY run and reported it as a no-op (#5193).
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
    echo "teardown-head.sh: could NOT read the head handle (head-env.sh rc=$RC) — that is UNKNOWN, not a no-op, and a materialized ref (and worktree, under --worktree) may be leaking on the shared primary. See head-env.sh's diagnostic above." >&2
    exit 1
    ;;
esac
# shellcheck disable=SC1090
. "$HANDLE" || {
  echo "teardown-head.sh: could NOT source the head handle $HANDLE — what it names is unreachable, not absent." >&2
  exit 1
}
[ -n "${PR_REF:-}" ] || {
  echo "teardown-head.sh: handle $HANDLE carries no PR_REF — refusing to guess what to remove, and refusing to call that success: a readable handle is evidence something WAS materialized and is now unreachable." >&2
  exit 1
}

# The worktree exists only under Step 2's rare `--worktree` mode; the ref always does.
if [ -n "${REVIEW_WT:-}" ]; then
  rm -rf "$REVIEW_WT" && git worktree prune
fi
git update-ref -d "$PR_REF"          # drop the throwaway ref when done
