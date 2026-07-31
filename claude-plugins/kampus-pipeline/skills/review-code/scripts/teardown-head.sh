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
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# shellcheck disable=SC1007
HANDLE="$("$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/head-env.sh" 2>/dev/null)" || {
  echo "teardown-head.sh: no head handle for this run — nothing this gate materialized to tear down (no-op)." >&2
  exit 0
}
# shellcheck disable=SC1090
. "$HANDLE"
[ -n "${REVIEW_WT:-}" ] && [ -n "${PR_REF:-}" ] || {
  echo "teardown-head.sh: handle carries no REVIEW_WT/PR_REF — refusing to guess a path to \`rm -rf\` (no-op)." >&2
  exit 0
}

rm -rf "$REVIEW_WT" && git worktree prune && git update-ref -d "$PR_REF"   # tear the throwaway tree + ref down
