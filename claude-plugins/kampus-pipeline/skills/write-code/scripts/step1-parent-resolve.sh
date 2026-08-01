#!/usr/bin/env bash
# Step 1's three-outcome parent read: sub-issue (200) / standalone (404) / UNKNOWN (anything else).
#
# usage: step1-parent-resolve.sh <N>
#
# stdout IS the classification. On a sub-issue it is two lines — `EPIC=<n>` first (the machine value
# Step 2 takes as its argument), then the prose classification. An empty stdout is UNKNOWN, never
# "standalone" (§ZS / ADR 0092).
#
# Executed, never sourced (ADR 0232). `$EPIC` used to survive into Step 2 through the sourcing shell;
# it now leaves on stdout and travels as Step 2's explicit argument.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Fail closed on an absent number — an empty one addresses `repos/$REPO/issues//parent`, whose 404 is
# INDISTINGUISHABLE from the genuine "No parent issue found" 404 that means standalone, i.e. it would
# answer "standalone" for an unnamed issue (the #4171 class this very block exists to close).
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 1: no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step1-parent-resolve.sh <N>`. NO parent classification was produced (UNKNOWN, not standalone).\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code Step 1: target repo unresolved — NO parent classification was produced (UNKNOWN, not standalone)." >&2
	exit 1
}

# `-i` keeps the status line on stdout even when gh exits non-zero, which is the whole point:
# it is what distinguishes a genuine 404 ("No parent issue found" ⇒ standalone) from an
# UNREADABLE response (5xx, rate-limit, auth, network ⇒ UNKNOWN). Collapsing those two into
# "no parent" is a silent no-op that skips Step 2 on a real epic child (#4171, #3715, #4108).
PARENT_RESP="$(gh api "repos/$REPO/issues/$N/parent" -i 2>/dev/null)"
PARENT_STATUS="$(printf '%s\n' "$PARENT_RESP" | head -n1 | awk '{print $2}')"
case "$PARENT_STATUS" in
	200)
		EPIC="$(printf '%s\n' "$PARENT_RESP" | awk 'body{print} /^\r?$/{body=1}' | jq -r '.number // empty')"
		if [ -z "$EPIC" ]; then
			echo "write-code FAILED (fail-closed): parent read on #$N returned 200 with no .number — UNKNOWN, not standalone; refusing to claim $N." >&2
			exit 1
		fi
		echo "EPIC=$EPIC"
		echo "#$N is a sub-issue of epic #$EPIC → Step 2 (derive eligibility BEFORE claiming)" ;;
	404)
		echo "#$N is standalone (404 'No parent issue found') → Step 3 (claim it)" ;;
	*)
		echo "write-code FAILED (fail-closed): parent read on #$N returned HTTP '${PARENT_STATUS:-none}' — UNKNOWN, which is NOT evidence of 'no parent'. Refusing to claim: retry, or re-pick per Step 1." >&2
		exit 1 ;;
esac
