#!/usr/bin/env bash
# Print one `#<n>\t<state>\t<title>` line per milestone (any state), so an existing founder-curated
# campaign milestone can be matched by title/description before a new one is provisioned.
#
# usage: list-milestones.sh
#
# An empty list would read as "no milestone to attach to ⇒ create one", so a failed read must not
# arrive as the same emptiness: exit 1 with its own line on stdout.
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

REPO="$(kp_repo)" || { echo "campaign: target repo unresolved — milestones NOT read (UNKNOWN, never 'none exist')."; exit 1; }

gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[] | "#\(.number)\t\(.state)\t\(.title)"' ||
	{ echo "campaign: could not read the milestone list — UNKNOWN, never 'none exist'."; exit 1; }
