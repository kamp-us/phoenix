#!/usr/bin/env bash
# Step 1 — the PR's state / head / base / body (the `Fixes #N` lives in the body). Extracted from
# review-code/SKILL.md (#4451, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: pr-context.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

# the PR: state, head branch, body (the Fixes #N lives here), mergeability
gh api repos/"$REPO"/pulls/"$PR" \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
