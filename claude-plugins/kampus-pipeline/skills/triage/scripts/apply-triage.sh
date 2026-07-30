#!/usr/bin/env bash
# Apply the triage verdict to #N: the type + priority labels and the status transition, through the
# one verb that owns that label write.
#
# usage: apply-triage.sh <N> <type> <priority>
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../shared/lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/lib" && pwd)/common.sh"

[ "$#" -ge 3 ] || { echo "usage: apply-triage.sh <N> <type> <priority>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" tracker apply-triage "$1" --type "$2" --p "$3"
