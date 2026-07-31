#!/usr/bin/env bash
# Print the numbers of the PRs merged in the window — REST search, never GraphQL.
#
# usage: merged-prs.sh <since> <until>
#
# Extracted from what-shipped/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: merged-prs.sh <since> <until>" >&2; exit 2; }
SINCE="$1"; UNTIL="$2"
REPO="$(kp_repo)" || exit 1

# `is:merged` + `merged:$SINCE..$UNTIL`
gh api -X GET search/issues \
  -f q="repo:$REPO is:pr is:merged merged:$SINCE..$UNTIL" \
  -f per_page=100 --jq '.items[] | .number'
