#!/usr/bin/env bash
# Link <CHILD> to <EPIC> as a NATIVE sub-issue — the real parent/child edge, not a `## Dependencies`
# mention. The *why* — and why the endpoint takes the database id, not the issue number — stays in
# ../SKILL.md § Step 4.
#
# usage: link-child.sh <EPIC> <CHILD>
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: link-child.sh <EPIC> <CHILD>" >&2; exit 2; }
EPIC="$1"; CHILD="$2"
REPO="$(kp_repo)" || exit 1

# the child's database id (reuse the .id from the create if you captured it)
CHILD_ID=$(gh api "repos/$REPO/issues/$CHILD" --jq '.id') || exit 1
[ -n "$CHILD_ID" ] || { echo "link-child: could not resolve #$CHILD's database id — refusing to POST an idless link." >&2; exit 1; }
# `-F` (not `-f`) so the id is sent as a number.
gh api -X POST "repos/$REPO/issues/$EPIC/sub_issues" \
  -F sub_issue_id="$CHILD_ID" \
  --jq '.sub_issues_summary'
