#!/usr/bin/env bash
# Step 4b's first input: the tolerant read of the child's `**Containment:**` line. The second — the
# cycle-doc probe — is its own relay, `step4b-cycle-doc.sh`; ship dark ONLY when both resolve, i.e.
# `CONTAINMENT=flag` AND `CYCLE_DOC=present`.
#
# usage: step4b-containment.sh <N>
#
# stdout is the one line `CONTAINMENT=<flag|exempt|none>`.
#
# The moved line's `|| echo none` resolves an UNREADABLE issue body to the same `none` an issue with
# no marker resolves to — the §ZS shape where a failed read poses as the permissive answer. It is
# carried over AS-IS on purpose (this is a conversion, ADR 0228/0232) and tracked separately in #4501;
# do not repair it here. `pipefail` is ON now per the shell shape, which only makes that fallback
# fire in MORE failure cases, never fewer — it cannot turn a `none` into a `flag`.
#
# Executed, never sourced (ADR 0232) — `$CONTAINMENT` used to land in the sourcing shell.
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Fail closed on an absent number — `issues/` with no number would fall straight into the
# `|| echo none` fallback and report "not a dark ship".
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 4b: no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step4b-containment.sh <N>`. CONTAINMENT was NOT resolved (UNKNOWN, not `none`).\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code Step 4b: target repo unresolved — CONTAINMENT was NOT resolved (UNKNOWN, not 'none')." >&2
	exit 1
}
# the child's containment marker; a missing line reads as `none` (formats §2 tolerant-read rule)
CONTAINMENT=$(gh api repos/$REPO/issues/$N --jq '.body' \
	| grep -ioE '\**\s*Containment:\**\s*(flag|exempt|none)' | head -n1 \
	| grep -ioE '(flag|exempt|none)' || echo none)
printf 'CONTAINMENT=%s\n' "$CONTAINMENT"
