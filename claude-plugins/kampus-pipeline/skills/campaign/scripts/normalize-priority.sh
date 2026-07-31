#!/usr/bin/env bash
# Normalize the wave's still-OPEN issues to p1: drop p0/p2, apply p1. Closed issues keep the
# priority they were worked at.
#
# usage: normalize-priority.sh <wave-label>
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: normalize-priority.sh <wave-label>" >&2; exit 2; }
WAVE_LABEL="$1"
REPO="$(kp_repo)" || exit 1

for N in $(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
    --jq '.[] | select((.pull_request | not) and .state=="open") | .number'); do
  for P in p0 p2; do gh api -X DELETE "repos/$REPO/issues/$N/labels/$P" >/dev/null 2>&1; done
  gh api -X POST "repos/$REPO/issues/$N/labels" -f "labels[]=p1" >/dev/null
done
