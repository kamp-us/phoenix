#!/usr/bin/env bash
# Step 1 — the PR's shape (state, draft, merged, head/base refs, body). Extracted from
# review-skill/SKILL.md (#4453, epic #4435 phase 1). Extraction contract + shell-option rationale:
# ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: pr-context.sh <pr>" >&2; exit 2; }
PR="$1"
REPO="$(kp_repo)" || exit 1

gh api repos/"$REPO"/pulls/"$PR" \
  --jq '{number, state, draft, merged, head: .head.ref, base: .base.ref, body}'
