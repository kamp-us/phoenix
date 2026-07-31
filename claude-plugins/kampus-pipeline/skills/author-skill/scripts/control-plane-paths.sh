#!/usr/bin/env bash
# Print the §CP control-plane path list. Relays the verb (ADR 0228) — the path list has ONE source
# and this is not a second copy of it.
#
# Extracted from author-skill/SKILL.md (#4454, epic #4435 phase 1).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

PCLI="$(kp_pcli)" || exit 127

"$PCLI" control-plane-paths
