#!/usr/bin/env bash
# Step 3.5's `MY_CLAIM` resolution — the token this run owns its work under.
#
# usage: step3_5-my-claim.sh
#
# stdout is the one line `MY_CLAIM=<token>`. It is informational: every guarded site resolves the
# same token internally (step3_5-claim-is-mine.sh, step8-claim-release.sh), because a shell variable
# does not survive between an agent's Bash calls. Read it to SEE which token this lane owns work
# under; never to carry it.
#
# Executed, never sourced (ADR 0232). Fail-closed: with NEITHER token set there is no
# agent-distinguishable identity to verify ownership under, so it refuses with empty stdout rather
# than fall back to the bare assignee login (the login degeneracy ADR 0115 removes).
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# the claim token this run owns work under: the orchestrator's threaded delegated token if it
# pre-claimed, else my own session id (the direct-path Step-3 self-claim).
MY_CLAIM="${THREADED_CLAIM_TOKEN:-${CLAUDE_CODE_SESSION_ID:-}}"
if [ -z "$MY_CLAIM" ]; then
	echo "mis-attribution guard: no claim token — CLAUDE_CODE_SESSION_ID absent and none threaded; refusing to claim or mutate (ADR 0115 Consequences — never a login fallback)" >&2
	exit 1
fi
echo "MY_CLAIM=$MY_CLAIM"
