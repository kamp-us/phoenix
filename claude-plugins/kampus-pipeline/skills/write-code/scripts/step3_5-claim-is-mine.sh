#!/usr/bin/env bash
# Step 3.5's mis-attribution guard — MANDATED before every issue/PR-number mutation.
#
# usage: step3_5-claim-is-mine.sh <N> [<token>]
#
# The EXIT STATUS is the entire contract: 0 only on a proven-own claim; non-zero (REFUSE) on an absent
# OR a foreign one. What reaches stdout is the verb's own observability report (resolved owner vs
# MY_CLAIM, the outcome reason, any superseded dead-claimant claims) — read it to SEE the resolution,
# never to decide it, and route it to stderr at any call site whose own stdout is a machine channel.
#
# Executed, never sourced (ADR 0232). This used to define a `claim_is_mine` shell function for later
# steps to call; a function cannot cross an agent's Bash calls, so every guarded site now executes
# this script instead. `MY_CLAIM` resolves here the same way step3_5-my-claim.sh resolves it — the
# threaded delegated token, else this session's id — or arrives as the optional second argument.
#
# The ADR-0115 §2 resolution — CLAIM_RE + the write+ ACL trust root (ADR 0055) + the
# earliest-(created_at, comment id) tiebreak — is owned once by `pipeline-cli claim is-mine`; CITE it,
# never hand-roll the jq (#3687). The verb is default-deny: an absent claim, an unauthorized-only
# claim, a foreign owner, and a missing session all resolve NOT-mine, which IS this guard's
# fail-closed refusal, so the exit-status contract is preserved.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 3.5: no issue/PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step3_5-claim-is-mine.sh <N>`. Ownership was NOT proven; REFUSE the mutation.\n' >&2
	exit 1
fi
MY_CLAIM="${2:-${THREADED_CLAIM_TOKEN:-${CLAUDE_CODE_SESSION_ID:-}}}"
if [ -z "$MY_CLAIM" ]; then
	echo "mis-attribution guard: no claim token — CLAUDE_CODE_SESSION_ID absent and none threaded; refusing to mutate #$N (ADR 0115 — never a login fallback)" >&2
	exit 1
fi
PCLI="$(kp_pcli)" || exit 127
"$PCLI" claim is-mine --issue "$N" --session "$MY_CLAIM"   # exit 0 = mine; non-zero = REFUSE (default-deny)
