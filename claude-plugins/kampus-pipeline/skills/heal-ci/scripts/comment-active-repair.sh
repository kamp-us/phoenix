#!/usr/bin/env bash
# An active write-code repair is in flight: route the red run to it instead of filing a twin defect.
# This comment IS the invocation's one routed action.
#
# usage: comment-active-repair.sh <pr> <signature> <run-url>
#
# Extracted from heal-ci/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "heal-ci: comment-active-repair.sh needs <pr> <signature> <run-url> — NOTHING was routed, so the red run is still unrouted."; echo "usage: comment-active-repair.sh <pr> <signature> <run-url>" >&2; exit 2; }
PR="$1"
SIGNATURE="$2"
RUN_URL="$3"
REPO="$(kp_repo)" || { echo "heal-ci: target repo unresolved — NOTHING was routed."; exit 1; }

gh api "repos/$REPO/issues/$PR/comments" \
	-f body="heal-ci: CI red — $SIGNATURE. Active write-code repair in flight (latest gate verdict FAIL); not filing a twin. Run $RUN_URL — fold into the in-flight fix." >/dev/null ||
	{ echo "heal-ci: the routing comment did NOT post on #$PR — the red run is UNROUTED; do not report it as routed."; exit 1; }

printf 'defect: %s — active repair on #%s, routed (no twin filed)\n' "$SIGNATURE" "$PR"
