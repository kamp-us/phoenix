#!/usr/bin/env bash
# Print the target repo as `owner/name`. Extracted from review-code/SKILL.md (#4451, epic #4435
# phase 1). Extraction contract + shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

# Top-level assignment, never `local` — `local REPO="$(kp_repo)"` takes `local`'s own status and
# masks the substitution's, so an unresolvable repo would sail through as the empty string and
# address `gh api repos//…` (the kp_repo idiom's gotcha).
REPO="$(kp_repo)" || exit 1
printf '%s\n' "$REPO"
