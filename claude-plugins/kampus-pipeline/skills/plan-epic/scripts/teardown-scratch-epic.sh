#!/usr/bin/env bash
# Dry-run cleanup: unlink + close each scratch child not-planned, then close the scratch epic. The
# *why* — that issues cannot be deleted over the public REST API, and that dry-run validation must
# never run against a real epic — stays in ../SKILL.md § Cleaning up after a dry-run.
#
# usage: teardown-scratch-epic.sh <EPIC> [<CHILD> …]
#
# THROWAWAY EPICS ONLY. It closes exactly the numbers you name, so naming a real epic closes a real
# epic — there is no way for a script to tell test debris from the backlog.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: teardown-scratch-epic.sh <EPIC> [<CHILD> …]" >&2; exit 2; }
EPIC="$1"; shift
REPO="$(kp_repo)" || exit 1

# for each scratch child: unlink + close
for CHILD in "$@"; do
  CHILD_ID=$(gh api "repos/$REPO/issues/$CHILD" --jq '.id') || exit 1
  [ -n "$CHILD_ID" ] || { echo "teardown: could not resolve #$CHILD's database id — refusing to DELETE an idless edge." >&2; exit 1; }
  echo "{\"sub_issue_id\": $CHILD_ID}" | gh api -X DELETE "repos/$REPO/issues/$EPIC/sub_issue" --input - || exit 1
  gh api -X PATCH "repos/$REPO/issues/$CHILD" -f state=closed -f state_reason=not_planned || exit 1
done
# then close the scratch epic
gh api -X PATCH "repos/$REPO/issues/$EPIC" -f state=closed -f state_reason=not_planned
