#!/usr/bin/env bash
# Home every issue carrying the wave label into the campaign's milestone (open and closed alike).
#
# usage: home-wave.sh <wave-label> <milestone-number>
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: home-wave.sh <wave-label> <milestone-number>" >&2; exit 2; }
WAVE_LABEL="$1"; MILESTONE_NUMBER="$2"
REPO="$(kp_repo)" || exit 1

for N in $(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
    --jq '.[] | select(.pull_request | not) | .number'); do
  gh api -X PATCH "repos/$REPO/issues/$N" -F "milestone=$MILESTONE_NUMBER" >/dev/null
done
