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
# It installs no `EXIT` trap of its own: under bash 3.2 a cleanup trap's last command becomes the
# script's exit status, laundering a `set -u` abort into exit 0 (#4476, class #4479). The trap
# belongs to the CALLER's shell — `trap '…/scripts/teardown-head.sh "$PR"' EXIT`.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: teardown-head.sh <pr>" >&2; exit 2; }
PR="$1"

# shellcheck disable=SC1007
HANDLE="$("$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/head-env.sh" "$PR" 2>/dev/null)" || {
  echo "teardown-head.sh: no head handle for this run — nothing this gate materialized to tear down (no-op)." >&2
  exit 0
}
# shellcheck disable=SC1090
. "$HANDLE"
[ -n "${PR_REF:-}" ] || {
  echo "teardown-head.sh: handle carries no PR_REF — refusing to guess what to remove (no-op)." >&2
  exit 0
}

# The worktree exists only under Step 2's rare `--worktree` mode; the ref always does.
if [ -n "${REVIEW_WT:-}" ]; then
  rm -rf "$REVIEW_WT" && git worktree prune
fi
git update-ref -d "$PR_REF"          # drop the throwaway ref when done
