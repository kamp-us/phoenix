#!/usr/bin/env bash
# Provision the campaign's OWN milestone — the roadmap act the founder-approval trace authorizes.
# Prints the new milestone NUMBER on stdout.
#
# usage: create-milestone.sh "<Campaign name> campaign" "<one-line campaign scope> (bounded, platform-lane drained)."
#
# Never reuse an arc milestone: a campaign runs concurrent with, not inside, a product arc (ADR 0072).
# That precedence is the skill's to apply — this script only creates what it is told to.
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "campaign: create-milestone.sh needs <title> <description> — NO milestone was created."; echo "usage: create-milestone.sh \"<Campaign name> campaign\" \"<one-line scope>.\"" >&2; exit 2; }
TITLE="$1"
DESCRIPTION="$2"
REPO="$(kp_repo)" || { echo "campaign: target repo unresolved — NO milestone was created."; exit 1; }

MILESTONE_NUMBER=$(gh api -X POST "repos/$REPO/milestones" \
	-f "title=$TITLE" \
	-f "description=$DESCRIPTION" \
	--jq .number)
[ -n "$MILESTONE_NUMBER" ] || { echo "campaign: the create call returned no milestone number — it may or may not exist; list milestones before retrying."; exit 1; }

printf '%s\n' "$MILESTONE_NUMBER"
