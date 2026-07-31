#!/usr/bin/env bash
# Step 2 — the full diff plus the changed-file list. Extracted from review-code/SKILL.md (#4451,
# epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: pr-diff.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

# the full diff — gh pr diff is the reliable form; the diff media type is the REST equivalent
gh pr diff "$PR" \
  || gh api repos/"$REPO"/pulls/"$PR" -H "Accept: application/vnd.github.v3.diff"
# files touched, at a glance
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[] | "\(.status)\t+\(.additions)/-\(.deletions)\t\(.filename)"'   # --paginate: streaming --jq, pages concatenate — the full set past file #100 (#725)
