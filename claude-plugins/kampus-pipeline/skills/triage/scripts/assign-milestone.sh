#!/usr/bin/env bash
# Home #N in milestone <n> — one single-field, last-write-wins PATCH (benign, #91); by NUMBER,
# never title.
#
# usage: assign-milestone.sh <N> <milestone-number>
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 2 ] || { echo "usage: assign-milestone.sh <N> <milestone-number>" >&2; exit 2; }
REPO="$(kp_repo)" || exit 1

gh api -X PATCH "repos/$REPO/issues/$1" -f milestone="$2"
