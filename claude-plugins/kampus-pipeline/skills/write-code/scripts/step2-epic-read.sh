#!/usr/bin/env bash
# Step 2's three reads of the parent epic: its body (the `## Dependencies` topology), its real child
# set with each child's state, and the handoff-note comment stream siblings left.
#
# usage: step2-epic-read.sh <EPIC>
#
# stdout IS the topology the eligibility derivation reads. Empty stdout is UNKNOWN, never "no
# dependencies" (§ZS / ADR 0092).
#
# Executed, never sourced (ADR 0232). Pass the number Step 1's sub-endpoint read RESOLVED (its
# `EPIC=<n>` stdout line), never a guessed or remembered one: an empty $EPIC addresses
# `repos/$REPO/issues//sub_issues`, which reads as an epic with no children — every dependency
# vacuously closed, every child "unblocked".
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

EPIC="${1:-}"
if [ -z "$EPIC" ]; then
	printf 'write-code Step 2: no epic number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step2-epic-read.sh <the parent number Step 1 resolved>`. NO topology was read (UNKNOWN, not "no dependencies").\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code Step 2: target repo unresolved — NO topology was read (UNKNOWN, not 'no dependencies')." >&2
	exit 1
}
# the epic body carries the plan + the ## Dependencies topology
gh api repos/$REPO/issues/$EPIC --jq '.body'
# the real child set + each child's state (the list endpoint is source of truth;
# sub_issues_summary undercounts under mixed closed/open children)
gh api "repos/$REPO/issues/$EPIC/sub_issues?per_page=100" \
	--jq '.[] | "#\(.number) [\(.state)] \(.title)"'
# the cross-task signal siblings left — read before assuming what's done
gh api "repos/$REPO/issues/$EPIC/comments?per_page=100" --jq '.[].body'
