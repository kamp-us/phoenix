#!/usr/bin/env bash
# Step 1 — the PR↔issue link events, the cross-check when the body's `Fixes #N` is not obvious.
# Extracted from review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
#
# Empty output here means "no link event found", which is exactly what Step 1's class-aware branch
# then has to decide about — it is NOT a positive "standalone PR", and the caller never reads it as
# one: `classify-issueless.sh` is what answers that, fail-closed, on its own evidence.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: linked-issue-timeline.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

# timeline shows "connected"/"cross-referenced" events linking PR ↔ issue
# --paginate + a STREAMING --jq: per_page caps at 100, so a link event past event 100 is
# invisible without it on a long-lived PR's timeline (#4193)
gh api --paginate "repos/$REPO/issues/$PR/timeline?per_page=100" \
  --jq '.[] | select(.event=="connected" or .event=="cross-referenced") | .source.issue.number // .issue.number' 2>/dev/null
