#!/usr/bin/env bash
# Step 8 (and repair R3): retract OUR OWN claim marker — the last mutation of the run that held it.
#
# usage: step8-claim-release.sh <N> [<token>]
#
# The EXIT STATUS is the contract: non-zero ⇒ the claim was NOT released. The release line already IS
# the verb, so this stays a relay (ADR 0228) — it never re-derives who owns the lane.
#
# Executed, never sourced (ADR 0232). `$MY_CLAIM` used to come from the sourcing shell; it resolves
# here exactly as step3_5-my-claim.sh resolves it (the threaded delegated token, else this session's
# id), or arrives as the optional second argument. That token is the one the marker itself carries.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Fail closed on an absent number — `claim release` with no issue number releases nothing, and
# reporting the lane freed when it is not is how a claim outlives its run.
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 8: no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step8-claim-release.sh <N>`. The claim was NOT released.\n' >&2
	exit 1
fi
MY_CLAIM="${2:-${THREADED_CLAIM_TOKEN:-${CLAUDE_CODE_SESSION_ID:-}}}"
if [ -z "$MY_CLAIM" ]; then
	echo "write-code Step 8: no claim token — the claim on #$N was NOT released (never guess whose marker to retract)." >&2
	exit 1
fi
PCLI="$(kp_pcli)" || exit 127
# the last mutation of the run — retract OUR OWN claim marker on the issue we just built.
# --session carries the token we owned the work under (the orchestrator's delegated token on the
# orchestrated path), because that is the token the marker itself carries.
"$PCLI" claim release --issue "$N" --session "$MY_CLAIM"
rc=$?

# The run held TWO things, and both outlived it: the claim on the issue, and the lane stamp on this
# worktree. An unretired stamp is why a finished lane's leftover tree read as a sibling still
# building and blocked every later repair on its branch, permanently (#4868). Retire it here, the
# same "last act of the run that held it" seam, and only once the claim release actually succeeded —
# a failed release means the run is not over.
if [ "$rc" -eq 0 ]; then
	if lane="$(lane_worktree 2>/dev/null)" && gd="$(git -C "$lane" rev-parse --absolute-git-dir 2>/dev/null)" &&
		kp_lane_retire "$gd"; then
		echo "write-code Step 8: retired this lane's stamp ($gd/kampus-lane -> kampus-lane.retired). The worktree and its files are untouched; a later repair on this branch now reads it as a leftover tree, not as a lane still building." >&2
	else
		# NOT fatal, and deliberately so: the claim IS released, and an unretired stamp degrades to
		# the liveness-unknown path, which still resolves once the tree is provably finished.
		echo "write-code Step 8: could not retire this lane's stamp (lane=${lane:-<unresolved>}). The claim WAS released. A later repair on this branch will have to prove this tree finished instead of reading it as retired." >&2
	fi
fi
exit "$rc"
