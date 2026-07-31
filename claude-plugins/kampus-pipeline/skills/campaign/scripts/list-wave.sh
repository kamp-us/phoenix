#!/usr/bin/env bash
# Print one `#<n>\t<state>\t<title>` line per issue carrying the wave label — the membership read that
# confirms the wave names a NON-EMPTY cluster before anything mutates.
#
# usage: list-wave.sh <wave-label>
#
# ZERO SCOPE FAILS (§ZS / ADR 0092): an empty cluster is exit 4, and an unreadable one exit 1, each
# with its own line on stdout. Emptiness here is the permissive-looking answer — "no members, nothing
# to re-price" — so it must never be what a failed read looks like.
#
# Extracted from campaign/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "campaign: list-wave.sh needs a wave label — the cluster was NOT read."; echo "usage: list-wave.sh <wave-label>" >&2; exit 2; }
WAVE_LABEL="$1"
REPO="$(kp_repo)" || { echo "campaign: target repo unresolved — the cluster was NOT read (UNKNOWN, never empty)."; exit 1; }

MEMBERS=$(gh api -X GET "repos/$REPO/issues" -f "labels=$WAVE_LABEL" -f state=all -f per_page=100 --paginate \
	--jq '.[] | select(.pull_request | not) | "#\(.number)\t\(.state)\t\(.title)"') ||
	{ echo "campaign: could not read the '$WAVE_LABEL' cluster — UNKNOWN, never empty."; exit 1; }
[ -n "$MEMBERS" ] || { echo "campaign: '$WAVE_LABEL' names ZERO issues — there is no wave to run a campaign over."; exit 4; }

printf '%s\n' "$MEMBERS"
