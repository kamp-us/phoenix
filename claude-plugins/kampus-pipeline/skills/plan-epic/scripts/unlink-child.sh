#!/usr/bin/env bash
# Unlink <CHILD> from <EPIC>. The endpoint is SINGULAR `sub_issue` and the id goes in the JSON body
# via `--input` — `-X DELETE … -F` does NOT work here. Unlinking does not close the child; closing is
# a separate state change. The *why* stays in ../SKILL.md § Step 4.
#
# usage: unlink-child.sh <EPIC> <CHILD>
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: unlink-child.sh <EPIC> <CHILD>" >&2; exit 2; }
EPIC="$1"; CHILD="$2"
REPO="$(kp_repo)" || exit 1

CHILD_ID=$(gh api "repos/$REPO/issues/$CHILD" --jq '.id') || exit 1
[ -n "$CHILD_ID" ] || { echo "unlink-child: could not resolve #$CHILD's database id — refusing to DELETE an idless edge." >&2; exit 1; }
echo "{\"sub_issue_id\": $CHILD_ID}" \
  | gh api -X DELETE "repos/$REPO/issues/$EPIC/sub_issue" --input -
