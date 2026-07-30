#!/usr/bin/env bash
# Print the open milestones sitting at 100% — 0 open issues, at least one closed (an empty
# milestone is not "done").
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/milestones?state=open&per_page=100" \
  --jq '.[] | select(.open_issues == 0 and .closed_issues > 0)
        | "#\(.number)\t\(.title)\t(\(.closed_issues) closed, 0 open)"'
