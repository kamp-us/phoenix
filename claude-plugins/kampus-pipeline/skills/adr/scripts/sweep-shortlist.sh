#!/usr/bin/env bash
# Print the ADR-sweep shortlist for a new ADR draft — the decisions it may supersede or amend.
# Relays the verb (ADR 0228); it derives nothing.
#
# usage: sweep-shortlist.sh <path/to/.decisions/NNNN-slug.md>
#
#   exit 0    nothing left to open
#   non-zero  a shortlist to clear, OR an INDETERMINATE run — the verb's own distinction, relayed.
#             127 means the CLI never ran, which is neither.
#
# Extracted from adr/SKILL.md (#4454, epic #4435 phase 1).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

[ "$#" -ge 1 ] || { echo "usage: sweep-shortlist.sh <path/to/.decisions/NNNN-slug.md>" >&2; exit 2; }
PCLI="$(kp_pcli)" || exit 127

"$PCLI" adr-sweep shortlist --new "$1"
