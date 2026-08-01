#!/usr/bin/env bash
# Step 3's direct path: claim through the verb FIRST (layer two), and only then write layer one.
#
# usage: step3-direct-claim.sh <N>
#
# The EXIT STATUS is the whole contract: non-zero ⇒ NO claim was made, back off and re-pick. Its
# `exit 0` on a LOST race is the moved block's own control flow — the run is meant to end and re-pick
# from Step 1, so the prose at the invocation site, not this status, is what routes that case.
#
# Executed, never sourced (ADR 0232). Both lines ARE the verbs, so this stays a relay (ADR 0228).
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Fail closed on an absent number — `tracker claim` with no issue number claims nothing, and reading
# that as a won claim is the double-pick this whole step exists to prevent (#1431).
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 3 (direct): no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step3-direct-claim.sh <N>`. NO claim was made; do not implement.\n' >&2
	exit 1
fi
# §CLI — resolve the shim by path; `pipeline-cli` is NOT on PATH (ADR 0207; #3314).
PCLI="$(kp_pcli)" || exit 127
# 0. Fail-closed on a missing token: the claim comment is the ONLY agent-distinguishable signal
#    under the shared `usirin` login — with no token a co-racer is unresolvable, so NEVER claim
#    (and never fall back to the login-keyed assignee as ownership — that is the §7 degeneracy).
#    The verb enforces this too (it backs off on an empty session), so this is a fast local exit.
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "no CLAUDE_CODE_SESSION_ID in env — cannot post an agent-distinguishable claim. BACK OFF, re-pick." >&2
	exit 0   # → re-run Step 1
fi

# 1. Claim through the verb FIRST — layer two, the fine agent-distinguishable resolver. It defers
#    to a pre-existing authorized owner WITHOUT posting, posts a PRESENCE-STAMPED marker under
#    $CLAUDE_CODE_SESSION_ID, re-reads canonical state, and retracts its OWN claim if it lost.
#    Exit 0 = the claim is mine; non-zero = backed off, having mutated nothing that is not ours.
if ! "$PCLI" tracker claim $N; then
	echo "did not win the claim on #$N (held by another agent, or lost the tiebreak) — back off, re-pick."
	exit 0   # → re-run Step 1
fi

# 2. ONLY NOW write layer one — the coarse availability gate the Step-1 picker reads (§7). One verb
#    owns this write on every path (#4298); never hand-roll the assignees POST. Defer-then-assign is
#    load-bearing, not stylistic: every agent authenticates as the SAME login, so the assignee is ONE
#    shared slot. Assigning first would make the back-off above a cleanup unassign that strips the
#    LIVE incumbent's assignment — clearing the coarse gate on an issue someone else legitimately
#    holds. Claiming first removes the cleanup entirely: the verb only ever writes on a claim it
#    proved is ours, and it has no removal path at all, so there is nothing to undo (#4015).
"$PCLI" claim assign --issue $N || { echo "could not set the availability gate on #$N — routed blocker." >&2; exit 1; }
# claim won and confirmed (earliest authorized claim is mine) — proceed to implement
