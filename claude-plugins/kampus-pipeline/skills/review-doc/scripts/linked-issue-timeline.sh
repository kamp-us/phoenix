#!/usr/bin/env bash
# Step 1 — cross-check the linked issue off the PR's timeline when `Fixes #N` is not obvious in the
# body. Extracted from review-doc/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: linked-issue-timeline.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

# --paginate + a STREAMING --jq: per_page caps at 100, so a link event past event 100 is
# invisible without it on a long-lived PR's timeline (#4193)
gh api --paginate "repos/$REPO/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
