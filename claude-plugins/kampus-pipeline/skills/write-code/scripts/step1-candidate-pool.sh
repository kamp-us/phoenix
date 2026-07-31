#!/usr/bin/env bash
# Step 1's candidate pool: list unassigned `status:triaged` issues, priority bucket by bucket.
#
# usage: step1-candidate-pool.sh
#
# stdout IS the pool, one `#N<TAB>created_at<TAB>title` row per candidate; an empty pool means no
# unassigned triaged issue exists. An unresolved repo refuses with NOTHING on stdout (§ZS / ADR 0092).
#
# Executed, never sourced (ADR 0232) — the caller reads the pool off stdout. `$REPO` used to arrive
# from the sourcing shell; shell state does not cross an agent's Bash calls, so it resolves here
# through `kp_repo`, which fails closed rather than address `repos//…`. The per-bucket read keeps the
# moved block's own behaviour (a failed bucket prints nothing and the loop continues) — hardening that
# into a §ZS refusal is #4501's, not this conversion's (ADR 0228: relay, never derive).
# shellcheck disable=SC1007,SC1091,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

REPO="$(kp_repo)" || {
	echo "write-code Step 1: target repo unresolved — NO candidate pool was listed (UNKNOWN, never an empty pool)." >&2
	exit 1
}

# p0 first; only fall through to p1, then p2 if a bucket is empty of unassigned issues
for P in p0 p1 p2; do
	gh api "repos/$REPO/issues?state=open&labels=status:triaged,$P&sort=created&direction=asc&per_page=100" \
		--jq '.[] | select(.assignee == null and (.pull_request | not)) | "#\(.number)\t\(.created_at)\t\(.title)"'
done
