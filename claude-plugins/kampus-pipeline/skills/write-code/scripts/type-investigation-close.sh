#!/usr/bin/env bash
# The `type:investigation` residue path's close: post the diagnosis as the closing comment, then
# close the issue `completed`.
#
# usage: type-investigation-close.sh <N> <diagnosis-body>
#
# `completed`, not `not_planned` — the investigation DID its job. Reserve `not_planned` for work that
# won't be done.
#
# Both writes are number-targeting mutations, and the Step-3.5 mis-attribution guard stays a separate
# visible line at the CALL SITE rather than folding in here: a reader of SKILL.md must still see the
# guard the step mandates, and hiding it inside this script would make the mandate unauditable from
# the doc. This script therefore assumes an already-green `step3_5-claim-is-mine.sh <N>`.
#
# An absent number, an empty diagnosis, or an unresolved repo refuses with NOTHING on stdout and a
# non-zero exit (§ZS / ADR 0092) — a close with no diagnosis is indistinguishable from a completed
# investigation, which is exactly the state that must never be reachable by accident.
#
# Executed, never sourced (ADR 0232). `$REPO` used to arrive from the agent's own shell and `<N>` was
# hand-substituted into the fence; both are explicit seams here. The comment POST is deliberately not
# `|| exit`-gated: that is the moved block's own sequencing, and turning it into a fail-closed gate is
# a behaviour change this conversion does not own (ADR 0228: relay, never derive).
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

N="${1:-}"
DIAGNOSIS="${2:-}"
if [ -z "$N" ] || [ -z "$DIAGNOSIS" ]; then
	printf 'write-code (type:investigation): need BOTH an issue number and a diagnosis body — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/type-investigation-close.sh <N> "$DIAGNOSIS"`. NOTHING was posted and NOTHING was closed.\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code (type:investigation): target repo unresolved — NOTHING was posted and the issue was NOT closed." >&2
	exit 1
}

gh api repos/$REPO/issues/$N/comments -f body="$DIAGNOSIS"
gh api -X PATCH repos/$REPO/issues/$N -f state=closed -f state_reason=completed
