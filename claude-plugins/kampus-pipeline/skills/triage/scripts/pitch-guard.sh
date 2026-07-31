#!/usr/bin/env bash
# Run the pitch-guard over #N — out-of-scope issues pass; a red is this draft.
# Relays the verb's own output and exit status (ADR 0228); a CLI that never resolved exits 127,
# which is UNKNOWN, not a pass.
#
# usage: pitch-guard.sh <N>
#
# Extracted from triage/SKILL.md (#4454, epic #4435 phase 1). Extraction contract +
# shell-option rationale: ../SKILL.md § The extracted scripts.
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: pitch-guard.sh <N>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" pitch-guard check --issue "$1"
