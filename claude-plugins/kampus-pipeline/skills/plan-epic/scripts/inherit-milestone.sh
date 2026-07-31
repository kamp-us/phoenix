#!/usr/bin/env bash
# Inherit the epic's milestone onto <CHILD> — and ONLY if the epic has one. The *why* — that
# inheritance copies the epic's state and never invents one, and that this skill never creates a
# milestone — stays in ../SKILL.md § Inherit the epic's milestone.
#
# usage: inherit-milestone.sh <EPIC> <CHILD>
#
# An unmilestoned epic is a clean no-op (freeze-by-absence), reported on stdout so "did nothing" is
# distinguishable from "could not run" (which exits non-zero).
#
# Extracted from plan-epic/SKILL.md (#4452, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: inherit-milestone.sh <EPIC> <CHILD>" >&2; exit 2; }
EPIC="$1"; CHILD="$2"
REPO="$(kp_repo)" || exit 1

EPIC_MILESTONE=$(gh api "repos/$REPO/issues/$EPIC" --jq '.milestone.number // empty') || exit 1
if [ -n "$EPIC_MILESTONE" ]; then
  gh api -X PATCH "repos/$REPO/issues/$CHILD" -f milestone="$EPIC_MILESTONE"
else
  echo "milestone: epic #$EPIC has none — #$CHILD stays unmilestoned (inheritance copies, it never invents)."
fi
