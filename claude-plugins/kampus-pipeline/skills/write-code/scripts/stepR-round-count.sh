#!/usr/bin/env bash
# Bounding: how many distinct gate-FAIL ROUNDS this PR has already accrued.
#
# usage: stepR-round-count.sh <PR>
#
# stdout IS the round count, one integer. Empty stdout is UNKNOWN, never 0 rounds — read the exit
# status before the number (§ZS / ADR 0092), because 0 is the permissive answer that would let the
# N=3 cap fail to bind.
#
# Executed, never sourced (ADR 0232). It used to read the `$authorized` set and `$comments_file` the
# pre-pick scan / R1 left in the agent's shell; both now come from the §SP scratch dir R1 wrote. An
# absent set means R1 never ran here — UNKNOWN, and it refuses.
#
# This is the one thing `verdict read` deliberately does NOT do (it resolves the latest verdict, it
# does not count rounds), so the counting jq is inherently local until a verb owns it (#1929).
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'write-code Bounding: no PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR-round-count.sh <PR>`. NO round count was produced (UNKNOWN, never 0).\n' >&2
	exit 1
fi
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code Bounding: §SP session id unset — cannot re-derive R1's scratch dir (#3718). UNKNOWN, never 0 rounds." >&2
	exit 1
fi
SCRATCH="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-repair-$PR"
if [ ! -s "$SCRATCH/authorized.json" ] || [ ! -s "$SCRATCH/comments.json" ]; then
	echo "write-code Bounding: no R1 state under $SCRATCH — Step R1 never ran in this session. UNKNOWN, never 0 rounds." >&2
	exit 1
fi
authorized="$(cat "$SCRATCH/authorized.json")"

# how many distinct gate-FAIL ROUNDS has this PR already accrued (both namespaces)?
# cluster FAIL markers by timestamp gap: a new round starts only when >120s separates two
# FAILs, so a code+doc pass (seconds apart) is one round and two real rounds (fix-push +
# re-review apart) are two — grid-free, so no minute-boundary split or same-minute merge.
jq --argjson authorized "$authorized" \
	'[.[] | select(.user.login | IN($authorized[]))
         | select(.body | test("^\\s*\\**\\s*review-(code|doc|skill):\\s*FAIL"; "i"))
         | .created_at | sub("\\..*Z$";"Z") | fromdateiso8601]
    | sort
    | reduce .[] as $t ({n:0, prev:null};
        if (.prev == null) or ($t - .prev) > 120
        then {n:(.n+1), prev:$t} else {n:.n, prev:$t} end)
    | .n' "$SCRATCH/comments.json"
