#!/usr/bin/env bash
# Step 5's AC enumeration — the checklist that must be satisfied in FULL before a closing keyword.
#
# usage: step5-acceptance-criteria.sh <N>
#
# stdout IS the checklist. An empty one is UNKNOWN, never "no ACs" (§ZS / ADR 0092) — which is why an
# issue whose body carries prose criteria instead of checkboxes gets the explicit fallback LINE below
# rather than silence.
#
# Executed, never sourced (ADR 0232).
# shellcheck disable=SC1007,SC1091,SC2016,SC2086
set -uo pipefail
# shellcheck source=../../../lib/common.sh
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

# Fail closed on an absent number — with no number the fallback line prints and the run would read
# "no acceptance criteria" for an issue it never read.
N="${1:-}"
if [ -z "$N" ]; then
	printf 'write-code Step 5: no issue number — run this as `bash ./claude-plugins/kampus-pipeline/skills/write-code/scripts/step5-acceptance-criteria.sh <N>`. NO criteria were enumerated (UNKNOWN, not "none").\n' >&2
	exit 1
fi
REPO="$(kp_repo)" || {
	echo "write-code Step 5: target repo unresolved — NO criteria were enumerated (UNKNOWN, not 'none')." >&2
	exit 1
}
# enumerate #N's acceptance criteria — the checklist you must satisfy in FULL to emit a closing keyword
gh api repos/$REPO/issues/$N --jq '.body' \
	| awk '/^###[[:space:]]*Acceptance criteria/{f=1;next} /^###/{f=0} f' \
	| grep -E '^\s*- \[' || echo "(no checkbox ACs — read the ### Acceptance criteria prose)"
