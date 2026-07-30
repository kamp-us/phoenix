#!/usr/bin/env bash
# The re-plan journal note: post *why* a child is superseded and where the work went, then unlink it
# from the epic and close it not-planned. The *why* — that every supersede is auditable, and that a
# closed-done child is history and is never superseded — stays in ../SKILL.md § The journal note.
#
# usage: supersede-child.sh <EPIC> <CHILD> <reason>
#
# <reason> is the specific sentence, e.g. "scope merged into #<NEW>" or "dropped, the brief no
# longer asks for X". Order is load-bearing: the note lands BEFORE the close, so the trail exists
# even if a later leg fails.
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: supersede-child.sh <EPIC> <CHILD> <reason>" >&2; exit 2; }
EPIC="$1"; CHILD="$2"; REASON="$3"
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues/$CHILD/comments" \
  -f body="Superseded by re-plan of #$EPIC: $REASON." || exit 1
# unlink from the epic (singular sub_issue, id in the JSON body), then close not-planned
CHILD_ID=$(gh api "repos/$REPO/issues/$CHILD" --jq '.id') || exit 1
[ -n "$CHILD_ID" ] || { echo "supersede-child: could not resolve #$CHILD's database id — refusing to DELETE an idless edge." >&2; exit 1; }
echo "{\"sub_issue_id\": $CHILD_ID}" | gh api -X DELETE "repos/$REPO/issues/$EPIC/sub_issue" --input - || exit 1
gh api -X PATCH "repos/$REPO/issues/$CHILD" -f state=closed -f state_reason=not_planned
