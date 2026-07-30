#!/usr/bin/env bash
# Print the linked issue's title, milestone, and `type:*` — the readout entry's title (preferred),
# milestone, and type.
#
# usage: issue-context.sh <issue>
#
# Extracted from what-shipped/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: issue-context.sh <issue>" >&2; exit 2; }
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues/$1" \
  --jq '{title: .title, milestone: (.milestone.title // null), type: ([.labels[].name | select(startswith("type:")) | sub("^type:";"")] | first // null)}'
