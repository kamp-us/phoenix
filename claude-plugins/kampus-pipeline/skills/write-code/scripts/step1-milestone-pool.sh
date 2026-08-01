#!/usr/bin/env bash
# Step 1's explicit `work milestone N` drain: the candidate pool scoped to one milestone.
#
# usage: step1-milestone-pool.sh <milestone-number>
#
# stdout IS the pool, one `#N<TAB>created_at<TAB>title` row per candidate, p0 bucket first; an empty
# pool means the milestone holds no unassigned triaged issue. An absent milestone number or an
# unresolved repo refuses with NOTHING on stdout (§ZS / ADR 0092) — silence plus a non-zero exit is
# UNKNOWN, never "this milestone is drained".
#
# Executed, never sourced (ADR 0232). `$REPO` and the milestone `$N` used to arrive from the agent's
# own shell, which does not survive between Bash calls: the repo resolves here through `kp_repo` and
# the milestone arrives as the one seam. The per-bucket read keeps the moved block's own behaviour (a
# failed bucket prints nothing and the loop continues) — hardening that into a §ZS refusal is the
# sibling pool's open follow-up (#4501), not this conversion's (ADR 0228: relay, never derive).
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 1 (milestone drain): no milestone number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step1-milestone-pool.sh <milestone-number>`. NO pool was listed (UNKNOWN, never an empty pool).\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code Step 1 (milestone drain): target repo unresolved — NO candidate pool was listed (UNKNOWN, never an empty pool)." >&2
	exit 1
}

# explicit milestone drain: same priority spine, scoped to milestone N (REST, never GraphQL)
for P in p0 p1 p2; do
	gh api "repos/$REPO/issues?state=open&milestone=$N&labels=status:triaged,$P&sort=created&direction=asc&per_page=100" \
		--jq '.[] | select(.assignee == null and (.pull_request | not)) | "#\(.number)\t\(.created_at)\t\(.title)"'
done
