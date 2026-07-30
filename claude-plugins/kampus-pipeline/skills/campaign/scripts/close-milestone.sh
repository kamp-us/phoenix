#!/usr/bin/env bash
# Close the campaign milestone — the operational projection of a finished campaign, the `done` path's
# step 2.
#
# usage: close-milestone.sh <milestone-number>
#
# Closing the milestone and flipping the ROADMAP row to `done` are PAIRED (roadmap-guard's I3 only
# requires *open* milestones to be claimed). That pairing is the skill's to hold — this script closes
# one milestone and reports whether it landed.
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "campaign: close-milestone.sh needs a milestone number — NOTHING was closed."; echo "usage: close-milestone.sh <milestone-number>" >&2; exit 2; }
MILESTONE_NUMBER="$1"
REPO="$(kp_repo)" || { echo "campaign: target repo unresolved — NOTHING was closed."; exit 1; }

gh api -X PATCH "repos/$REPO/milestones/$MILESTONE_NUMBER" -f state=closed >/dev/null ||
	{ echo "campaign: milestone #$MILESTONE_NUMBER did NOT close — do not flip the ROADMAP row to \`done\` over an open milestone."; exit 1; }

printf 'milestone #%s closed\n' "$MILESTONE_NUMBER"
