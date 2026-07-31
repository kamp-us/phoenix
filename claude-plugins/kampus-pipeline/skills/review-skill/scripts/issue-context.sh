#!/usr/bin/env bash
# Step 1 — the linked issue (its `### Acceptance criteria` lives in the body) plus the progress trail
# write-code left. Extracted from review-skill/SKILL.md (#4453, epic #4435 phase 1). Extraction
# contract + shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: issue-context.sh <issue>" >&2; exit 2; }
ISSUE="$1"
REPO="$(kp_repo)" || exit 1

gh api repos/"$REPO"/issues/"$ISSUE" --jq '{number, state, assignee: .assignee.login, body}'
gh api "repos/$REPO/issues/$ISSUE/comments?per_page=100" --jq '.[].body'
