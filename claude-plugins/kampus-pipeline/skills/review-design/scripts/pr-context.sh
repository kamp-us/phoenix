#!/usr/bin/env bash
# Print the PR's descriptive context: its state/draft/merged/head/base/body summary, then the issue
# numbers its timeline links (the `Fixes #N` cross-check).
# Extracted from review-design/SKILL.md (#4453, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: pr-context.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/pulls/$PR" \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
# --paginate + a STREAMING --jq: per_page caps at 100, so a link event past event 100 is
# invisible without it on a long-lived PR's timeline (#4193)
gh api --paginate "repos/$REPO/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
