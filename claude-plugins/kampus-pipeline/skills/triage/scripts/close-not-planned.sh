#!/usr/bin/env bash
# Kill-protocol steps 2-4, every kill: the reason comment, the `closed-by-triage` audit label, and
# the not-planned close. The reason is REQUIRED — an unexplained kill is not auditable.
#
# usage: close-not-planned.sh <N> <specific reason>
#
# Extracted from triage/close-not-planned.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: close-not-planned.sh <N> <specific reason>" >&2; exit 2; }
N="$1"; REASON="$2"
[ -n "$REASON" ] || { echo "close-not-planned: empty reason — refusing an unauditable kill." >&2; exit 2; }
REPO="$(kp_repo)" || exit 1

gh api "repos/$REPO/issues/$N/comments" -f body="Closing not-planned: $REASON"
gh api "repos/$REPO/issues/$N/labels" -f "labels[]=closed-by-triage"
gh api -X PATCH "repos/$REPO/issues/$N" -f state=closed -f state_reason=not_planned
