#!/usr/bin/env bash
# Confirm the sub-issue links landed: the epic's summary, then the authoritative list. The *why* —
# that `sub_issues_summary.total` UNDERCOUNTS on a mixed open/closed epic, so the list is the source
# of truth on the re-plan path — stays in ../SKILL.md § Step 4.
#
# usage: confirm-links.sh <EPIC>
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: confirm-links.sh <EPIC>" >&2; exit 2; }
EPIC="$1"
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues/$EPIC" --jq '.sub_issues_summary'
# total should equal the number of children you linked
gh api "repos/$REPO/issues/$EPIC/sub_issues?per_page=100" \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
