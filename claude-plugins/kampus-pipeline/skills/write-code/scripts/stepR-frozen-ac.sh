#!/usr/bin/env bash
# Freeze-after-round-K: does this round's resolving FAIL table carry a review-appended AC tagged
# at/after the final round (ADR 0079)?
#
# usage: stepR-frozen-ac.sh <PR>
#
# stdout is one `FROZEN appended AC …` line per frozen criterion — an EMPTY answer means none is
# frozen and the round drains normally. Because empty IS the ordinary answer, a read that could not
# run must never reach the caller as one: an absent FAIL body refuses with NOTHING on stdout and a
# named diagnostic on stderr (§ZS / ADR 0092).
#
# Executed, never sourced (ADR 0232). It used to read the `$FAILBODY` R2 left in the agent's shell;
# it now reads the same body out of the §SP file stepR2-fail-body.sh wrote.
# shellcheck disable=SC1007,SC1091,SC2016
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PR="${1:-}"
if [ -z "$PR" ]; then
	printf 'write-code Freeze-after-round-K: no PR number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/stepR-frozen-ac.sh <PR>`. NO freeze check ran (UNKNOWN, never "nothing frozen").\n' >&2
	exit 1
fi
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
	echo "write-code Freeze-after-round-K: §SP session id unset — cannot re-derive R2's FAIL body (#3718). UNKNOWN, never 'nothing frozen'." >&2
	exit 1
fi
FAILBODY_FILE="${TMPDIR:-/tmp}/kampus-run/$CLAUDE_CODE_SESSION_ID/write-code-repair-$PR/fail-body.md"
if [ ! -s "$FAILBODY_FILE" ]; then
	echo "write-code Freeze-after-round-K: no FAIL body at $FAILBODY_FILE — stepR2-fail-body.sh never ran in this session. UNKNOWN, never 'nothing frozen'." >&2
	exit 1
fi

# does this round's resolving FAIL table carry a review-appended AC tagged at/after the final round?
# the row is the ordinary checkbox shape; the tag is the only thing read here (no new parser)
grep -oE '<!-- *ac:review-[a-z]+ +pr:#[0-9]+ +round:[0-9]+ *-->' "$FAILBODY_FILE" | while read -r tag; do
	K=$(printf '%s' "$tag" | grep -oE 'round:[0-9]+' | cut -d: -f2)
	[ "$K" -ge 3 ] && echo "FROZEN appended AC ($tag) — appended in/after final round; escalate, do not loop"
done
exit 0
